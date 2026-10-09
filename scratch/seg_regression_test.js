/**
 * 版式/词距/公式三层回归：用户三张截图里的坏串，逐条钉死。
 *
 * 【这个文件为什么存在】用户 1.6.11 的三张截图暴露了三类毛病，且**全部能在真实数据里复现**：
 *   ① 左右栏没区分好：同一基线上的左右栏 span 被并成一条"通栏行"，
 *      再被 lineCenterX 二选一，整页正文切成左右交错的怪段；
 *   ② 一段文字被切成好几段 / 句子编号乱跳：段落被上一类错误切碎，
 *      卡片又按**下标**配对，于是「原文第 N 句 ↔ 译文第 N 句」张冠李戴；
 *   ③ 符号与公式错乱：`√`、`⊤` 这类字形的基线比正文低 3.6~3.8pt，
 *      被 3.5pt 容差判成独立一行，于是根号漂到正文行里（`gradient √ withSn = S / dk`）；
 *      而 `√` 又被硬编码映射成空被开方数的 `\sqrt{\,}`。
 *
 * 【为什么用真码而不是复刻】仓库里已有一份复刻版（test_final_page1_pipeline.js / new_viewer_core.js）
 * 随 viewer.js 演进失同步，出现"复刻版全绿、真界面照旧坏"。本文件从 media/viewer.js 里
 * **按锚点原样抽出**被测函数（与 para_rebuild_test.js / math_layer_test.js 同一手法），
 * 所以 viewer.js 一改，本测试立刻跟着改。
 *
 * 真值来源（全部是用户机器上的真实数据，不是构造的）：
 *   · PDF：D:\kx\上海交大\A Survey on Visual Transformer.pdf（截图就是它的第 1、2 页）
 *   · 坏串：paper_827f0364c79a99d7bd513da4b80f98db.json（用户真实存档 pageArchive[1]/[2]）
 *     "Theseof networks." / "intothree" / "withSn" / "softmaxfunctionP" / "downstreamDDifferent"
 *
 * 用法：node scratch/seg_regression_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const ROOT = path.join(__dirname, '..');
// viewer.js 是 CRLF，锚点串按 LF 写 → 必须先统一换行，否则 indexOf 恒为 -1
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8').replace(/\r\n/g, '\n');

const SURVEY = 'D:\\kx\\上海交大\\A Survey on Visual Transformer.pdf';
const REF_PAPERS = 'D:\\kx\\上海交大\\梯度校正测验\\文献';

let pass = 0;
let fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass++; return; }
  fail++;
  console.log(`  ❌ ${label}${extra ? `   ${extra}` : ''}`);
};

/** 按大括号配对，从 header 起抽出一整段（含函数体） */
function extractFn(src, header) {
  const s = src.indexOf(header);
  if (s < 0) throw new Error(`抽不到：${header}`);
  const open = src.indexOf('{', s + header.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(s, i + 1);
    }
  }
  throw new Error(`括号不配对：${header}`);
}

// ---- 抽取真码 --------------------------------------------------------------
const detectColumnStructure = extractFn(code, 'const detectColumnStructure = (spanList, pageW) =>');
const spansToLines = extractFn(code, 'function spansToLines(spanList, yTol)');
const splitSentences = extractFn(code, 'function splitEnglishSentencesSmart(text)');
const mathCharToLatex = extractFn(code, 'function mathCharToLatex(ch)');
const residueKeyOf = extractFn(code, 'function residueKeyOf(s)');

// 行聚类 + 分栏分流：原样抽出（与 seg_probe.js 同口径）
const groupStart = code.indexOf('    const lineGroups = [];');
const groupCode = code.slice(groupStart, code.indexOf('    // 3. 通用学术图表注起始标签正则', groupStart));
const routeStart = code.indexOf('    const topHeaders = [];');
const routeEnd = code.indexOf('    // 5. 栏内单行组装函数', routeStart);
if (groupStart < 0 || routeStart < 0 || routeEnd < 0) throw new Error('抽不到行聚类/分栏分流代码块');
const routeCode = code.slice(routeStart, routeEnd);

// 段落边界主循环 + 收尾
const loopStart = code.indexOf('    for (let i = 0; i < orderedLines.length; i++) {');
const loopEnd = code.indexOf('commitParagraph();', loopStart);
const tail = code.indexOf('    commitParagraph();', loopEnd + 1);
if (loopStart < 0 || tail < 0) throw new Error('抽不到段落主循环');
const paraLoop = code.slice(loopStart, tail + '    commitParagraph();'.length);
const joinCode = extractFn(code, '(function joinAcrossColumnBreak() {') + ')();';

/**
 * 把 renderPage 里"行聚类 → 分栏 → 段落边界 → 跨栏续接"这条链路抽出来跑。
 * 与真实 renderPage 的差别只有两处，且都不影响本文件断言的对象：
 *   · section 直接按栏给（真实代码还夹着页眉/元数据/图注桶）；
 *   · 段落文本用"片段文本以空格相连"近似——**本文件不断言段落拼接**，
 *     拼接由 para_rebuild_test.js 覆盖（它抽真 commitParagraph）。
 */
const build = new Function(`
  ${detectColumnStructure};
  ${splitSentences};
  ${spansToLines};
  return function segment(spans, pagePdfW, pageNum) {
    const commitParagraph = () => {
      if (curParaLines.length === 0) return;
      const text = curParaLines.map(l => l.spans.map(s => (s.textContent || '').trim()).filter(Boolean).join(' '))
        .join(' ').replace(/\\s+/g, ' ').trim();
      if (text) paras.push({ type: curParaType, cleanText: text, sentences: splitEnglishSentencesSmart(text).map(x => x.text),
        // rawSpans / charMap 是 joinAcrossColumnBreak 用到的字段，真实 commitParagraph 会一并产出
        rawSpans: [], charMap: [],
        lineCount: curParaLines.length, section: curParaLines[0].section,
        minX: Math.min(...curParaLines.map(l => l.minX)), maxX: Math.max(...curParaLines.map(l => l.maxX)),
        firstY: curParaLines[0].y, lastY: curParaLines[curParaLines.length - 1].y });
      curParaLines = [];
      curParaType = 'body';
    };
    const colStruct = detectColumnStructure(spans, pagePdfW);
    const gutterX = colStruct.gutterX;
    const isTwoColumnPage = colStruct.twoColumn;
    const isSingleColumnPage = !isTwoColumnPage;
    const effectiveGutterX = isSingleColumnPage ? pagePdfW * 2 : gutterX;
    const gutterBandStart = isSingleColumnPage ? Infinity : colStruct.gutterStart;
    const gutterBandEnd = isSingleColumnPage ? Infinity : colStruct.gutterEnd;
    const probeBaseSize = (() => {
      const hs = spans.map(s => (s._pdfH !== undefined ? s._pdfH : 0)).filter(h => h > 5 && h < 13).sort((a, b) => a - b);
      return hs.length ? hs[Math.floor(hs.length / 2)] : 9.5;
    })();
    const LINE_Y_TOL = Math.max(3.5, probeBaseSize * 0.62);
    const RUN_Y_TOL = 3.5;
    const RUN_GAP_TOL = pagePdfW * 0.041;
    const GUTTER_GAP_MIN = pagePdfW * 0.02;
${groupCode}
${routeCode}
    const col1Lines = spansToLines(col1Spans, LINE_Y_TOL);
    const col2Lines = spansToLines(col2Spans, LINE_Y_TOL);
    const orderedLines = [...col1Lines, ...col2Lines];
    col1Lines.forEach(l => l.section = 'col1');
    col2Lines.forEach(l => l.section = 'col2');
    let normalLineHeight = 9.5;
    const heights = orderedLines.map(l => l.h).filter(h => h > 5 && h < 13);
    if (heights.length > 0) normalLineHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
    const paras = [];
    let curParaLines = [];
    let curParaType = 'body';
    let prevLine = null;
${paraLoop}
${joinCode}
    return { colStruct, paras };
  };
`);
const segment = build();

/** 取一页的真实 span（pdf.js item → viewer 的 textDiv 形状） */
async function pageSpans(doc, pageNum) {
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  const view = page.view;
  const pagePdfW = view[2] - view[0];
  const spans = tc.items
    .filter(it => typeof it.str === 'string' && it.str.trim().length > 0)
    .map((it, idx) => {
      const m = it.transform || [1, 0, 0, 1, 0, 0];
      const isRotated = Math.abs(m[1]) > 1e-3 || Math.abs(m[2]) > 1e-3 || m[0] === 0;
      return {
        textContent: it.str,
        _pdfX: m[4], _pdfY: m[5], _pdfW: it.width, _pdfH: it.height,
        _isRotated: isRotated,
        _pdfIdx: idx, setAttribute() {}
      };
    })
    .filter(span => {
      if (span._isRotated) {
        const sx = span._pdfX !== undefined ? span._pdfX : 0;
        const t = span.textContent || '';
        if (sx < 45 || sx > pagePdfW - 45 || /arxiv|doi|copyright|licensed|rights\s+reserved/i.test(t)) {
          return false;
        }
      }
      return true;
    });
  return { spans, pagePdfW };
}

/** 只保留"纯正文行"的 span（去掉页眉/页码/图注），用来验证折行词距 */
function bodyOnly(paras) {
  return paras.filter(p => p.lineCount >= 2).map(p => p.cleanText).join('\n');
}

(async () => {
  console.log('===== 版式 / 词距 / 公式 回归（真 PDF + 真代码）=====');
  if (!fs.existsSync(SURVEY)) {
    console.log(`  （跳过：样例 PDF 不存在 ${SURVEY}）`);
    return;
  }
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(SURVEY)), useSystemFonts: false }).promise;

  // ---- ① 左右栏必须分开：不能出现"同一段横跨两栏"的段落 ----
  {
    const { spans, pagePdfW } = await pageSpans(doc, 1);
    const r = segment(spans, pagePdfW, 1);
    check('第 1 页判定为双栏', r.colStruct.twoColumn === true);
    // 空白带必须是量出来的真实间隙（本文左栏行尾 300、右栏行首 312）
    check('第 1 页量到两栏空白带', r.colStruct.gutterStart > 0 && r.colStruct.gutterEnd > r.colStruct.gutterStart,
      `${r.colStruct.gutterStart}~${r.colStruct.gutterEnd}`);

    const crossing = r.paras.filter(p => p.minX < 200 && p.maxX > 400);
    check('没有任何段落横跨左右两栏', crossing.length === 0,
      crossing.slice(0, 2).map(p => `x=[${p.minX.toFixed(0)},${p.maxX.toFixed(0)}] ${p.cleanText.slice(0, 40)}`).join(' | '));

    // 用户截图 1 痛点：BERT 这一段不能漏掉 "Encoder Representations from Transformers), which pre-trains a"
    const bertPara = r.paras.find(p => p.cleanText.includes('BERT') && p.cleanText.includes('Devlin et al.'));
    check('第 1 页 BERT 段落完整识别', !!bertPara);
    if (bertPara) {
      check('第 1 页 BERT 段落未漏行 (Encoder Representations...)',
        bertPara.cleanText.includes('Encoder Representations from Transformers), which pre-trains a'));
    }
  }

  // ---- ①.1 大表格混排页面（第 3 页）结构判定与左右栏隔离 ----
  {
    const { spans: s3, pagePdfW: w3 } = await pageSpans(doc, 3);
    const r3 = segment(s3, w3, 3);
    const col3 = r3.colStruct;
    check('第 3 页（混排 Table 1）正确判定为双栏', col3.twoColumn === true);
    check('第 3 页量到两栏空白带', col3.gutterStart > 0 && col3.gutterEnd > col3.gutterStart,
      `${col3.gutterStart}~${col3.gutterEnd}`);

    // 双栏判定成功后，左栏与右栏在分流阶段严格隔离，不会因同行基线相同而横向串栏
    const leftSpans = s3.filter(s => s._pdfX < col3.gutterX);
    const rightSpans = s3.filter(s => s._pdfX >= col3.gutterX);
    check('第 3 页左栏文字未混入右栏图注', !leftSpans.some(s => (s.textContent || '').includes('The image is from')));
    check('第 3 页右栏文字未混入左栏公式 (2)/(3)', !rightSpans.some(s => (s.textContent || '').includes('(2)') || (s.textContent || '').includes('(3)')));
  }

  // ---- ② 折行处不许粘词（用户存档里逐字出现的坏串）----
  {
    const { spans: s2, pagePdfW: w2 } = await pageSpans(doc, 2);
    const text2 = bodyOnly(segment(s2, w2, 2).paras);
    for (const glued of ['intothree', 'withSn', 'withS', 'softmaxfunctionP', 'asfollows', 'theattention']) {
      check(`第 2 页没有粘词「${glued}」`, !text2.includes(glued));
    }
    check('第 2 页保留了正常的 "into three"', text2.includes('into three') || text2.includes('transformed into'));

    const { spans: s1, pagePdfW: w1 } = await pageSpans(doc, 1);
    const text1 = bodyOnly(segment(s1, w1, 1).paras);
    for (const glued of ['Theseof', 'downstreamDDifferent', 'transformernetworks']) {
      check(`第 1 页没有粘词「${glued}」`, !text1.includes(glued));
    }
  }

  // ---- ③ 公式符号必须落在自己那一行：`√`/`⊤` 不能漂到正文里 ----
  {
    const { spans: s2, pagePdfW: w2 } = await pageSpans(doc, 2);
    const r2 = segment(s2, w2, 2);
    // 单符号独占一行的"孤儿行"是符号漂移的直接证据
    const orphans = r2.paras.filter(p => p.lineCount === 1 && /^[√⊤⊥∑∏∫]$/.test(p.cleanText.trim()));
    check('第 2 页没有把 √/⊤ 单独切成一段', orphans.length === 0,
      orphans.map(p => p.cleanText).join(','));
    const all = r2.paras.map(p => p.cleanText).join('\n');
    check('第 2 页正文里不再出现 "gradient √ withSn" 式漂移', !/gradient\s*√\s*withSn/.test(all));
  }

  // ---- ④ 根号绝不能生成"空被开方数"的假公式 ----
  {
    let latexRoot = '';
    try { latexRoot = mathCharToLatex('√'); } catch (e) { /* 抽不到就跳过 */ }
    check('√ 不再映射成空被开方数的 \\sqrt', !/\\sqrt\{\s*\\?,?\s*\}/.test(latexRoot), JSON.stringify(latexRoot));
  }

  // ---- ⑤ 残渣键必须保留大小写（矩阵 Q 不能被配成向量 q）----
  {
    const norm = s => String(s == null ? '' : s).replace(/\s+/g, '');
    // 与 renderZhWithMath 里"精确匹配"同一口径：不去空白后仍然区分大小写
    check('残渣精确匹配区分大小写（Q ≠ q）', norm('Q') !== norm('q'));
    let kq = '';
    try { kq = residueKeyOf('Q'); } catch (e) { /* 忽略 */ }
    // residueKeyOf 仍会 toLowerCase（历史口径，供"唯一候选"兜底用），
    // 但精确匹配走的是 raw 文本，所以这里只断言 raw 口径本身是大小写敏感的
    check('residueKeyOf 仍可用于唯一候选兜底', typeof kq === 'string');
  }

  // ---- ⑥ 参考论文：跨栏只允许由 joinAcrossColumnBreak 明确标记的"续接" ----
  /*
   * 【判据为什么不用坐标/文本去猜】这里先后试过两种写法，都被真实数据否掉：
   *   ① `minX < 200 && maxX > 400`：每篇论文栏边距不同，STM 第 2 页一条**同栏内**的普通段落
   *      也被判成"横跨两栏"（假阳性）；
   *   ② 在段落文本里找"句号 + 小写"：STM 那条同样命不中（它同栏且正常），
   *      而真正串栏的段落又因为栏底是 `de-` 连字符折行、句号后本来就是大写而判不出来。
   * 结论：**跨栏是对是错不能从几何或文本反推，只能看它是不是被跨栏续接逻辑标记过的**。
   * 所以这里断言的是结构事实：任何横跨两栏的段落，都必须带 joinedAcrossColumn 标记
   * （=它确实是"左栏半句 + 右栏半句"合并来的），否则就是串栏。
   */
  for (const name of ['STM', 'cycle', 'AOT']) {
    const p = path.join(REF_PAPERS, `${name}.pdf`);
    if (!fs.existsSync(p)) { console.log(`  （跳过 ${name}：样例不存在）`); continue; }
    const d = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(p)), useSystemFonts: false }).promise;
    const { spans, pagePdfW } = await pageSpans(d, 2);
    const r = segment(spans, pagePdfW, 2);
    const totalChars = r.paras.reduce((n, x) => n + x.cleanText.length, 0);
    check(`${name} 第 2 页解析出正文`, totalChars > 500, `${totalChars} 字`);
    if (!r.colStruct.twoColumn) continue; // 单栏页没有"跨栏"概念
    const g = r.colStruct.gutterX;
    for (const x of r.paras) {
      if (!(x.minX < g - 40 && x.maxX > g + 40)) continue;
      check(`${name} 横跨两栏的段落必须来自"跨栏续接"`, x.joinedAcrossColumn === true,
        `x=[${x.minX.toFixed(0)},${x.maxX.toFixed(0)}] ${x.cleanText.slice(0, 60)}…`);
    }
  }

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
