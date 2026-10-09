/**
 * 段落切分真值探针：把 **viewer.js 里真正的切分代码**（栏检测 / 行聚类 / 段落边界规则）
 * 原样抽出来，喂真实 PDF 的 text item，打印每页的段落清单。
 *
 * 【为什么要抽真码而不是复刻】仓库里已经有一份复刻版（test_final_page1_pipeline.js），
 * 它随 viewer.js 演进而失同步，于是"复刻版通过、真界面依旧切碎"。用户反馈的
 * 「一段文字被切分识别为好几段」「左右栏没区分好」只有在真码上跑才有意义。
 *
 * 用法：node scratch/seg_probe.js <pdf路径> <页码[,页码...]> [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const ROOT = path.join(__dirname, '..');
/*
 * viewer.js 在本仓库是 **CRLF** 换行，而下面所有用于抽取的锚点字符串都是 LF 写的。
 * 不统一换行，`code.indexOf('    const topHeaders = [];')` 会永远返回 -1
 * （实测直接报"抽不到行聚类/分栏分流代码块"）。这里统一成 LF 再抽。
 */
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8').replace(/\r\n/g, '\n');

/** 按大括号配对，从 startIdx 处的 `{` 找到配对的 `}` */
function matchBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('括号不配对');
}

/** 从 `function name(` 或 `const name = (` 起，抽出一整段（含函数体） */
function extractFn(src, header) {
  const s = src.indexOf(header);
  if (s < 0) throw new Error(`抽不到：${header}`);
  const bodyStart = src.indexOf('{', s + header.length - 1);
  const end = matchBrace(src, bodyStart);
  return src.slice(s, end + 1);
}

// ---- 抽取真码片段 ----------------------------------------------------------
const detectColumnStructure = extractFn(code, 'const detectColumnStructure = (spanList, pageW) =>');
const spansToLines = extractFn(code, 'function spansToLines(spanList, yTol)');
/*
 * 行聚类 + 分栏分流：**必须与 viewer.js 里那两段一字不差地抽出来用**。
 * 【教训】本探针最早的版本把这段"复刻"了一遍，于是修好 viewer.js 之后探针输出纹丝不动，
 * 差点把已修好的 bug 当成没修（仓库里 test_final_page1_pipeline.js 就是这么腐烂的）。
 * 这里改成从源码里按括号配对准去抽，源码一改探针立刻跟着改。
 */
const groupStart = code.indexOf('    const lineGroups = [];');
const groupCode = code.slice(groupStart, code.indexOf('    // 3. 通用学术图表注起始标签正则', groupStart));
/*
 * 【临时诊断注入】把"同一行合并"判定里的每个 return false 都记一条日志。
 * 直接改 viewer.js 不合适（那是产品代码），所以在抽出来的源码字符串上做替换。
 * 用字符串拼接而不是模板字符串，避免 ${} 在 new Function 的模板里被提前求值。
 */
const traceCode = process.argv.includes('--trace')
  ? groupCode
      .replace('const gap = gapEnd - gapStart;',
        'const gap = gapEnd - gapStart; __trace.push({ y: y, xs: [oMin, oMax, sMin, sMax], gap: gap, gutterX: gutterX, single: isSingleColumnPage });')
      .replace(/return false;/g, 'return false;')
  : groupCode;
/*
 * 分栏分流那一整块（`const topHeaders = []` 起的桶声明 + `spans.forEach(...)`），原样抽出。
 * 【锚点顺序】topHeaders 的声明在 GUTTER_CLEARANCE 之前，所以必须从 0 开始找；
 * 曾经写成"从 GUTTER_CLEARANCE 之后找 topHeaders"→ 永远 -1 → 直接抛"抽不到"。
 */
const routeStart = code.indexOf('    const topHeaders = [];');
const routeEnd = code.indexOf('    // 5. 栏内单行组装函数', routeStart);
if (groupStart < 0 || routeStart < 0 || routeEnd < 0) throw new Error('抽不到行聚类/分栏分流代码块');
const routeCode = code.slice(routeStart, routeEnd);
/*
 * 跨栏续接（9.5）：同样原样抽出。它是"串栏"的第二现场——
 * 行聚类修好之后，若这里仍按"左栏段 + 右栏段 → 合并"，仍会把左栏底部的段落
 * 和右栏顶部的段落粘成一段（合并后 minX 留在左栏、maxX 跑到右栏，整段跨栏）。
 */
const joinCode = extractFn(code, '(function joinAcrossColumnBreak() {') + ')();';
// 段落边界主循环：从 `for (let i = 0; i < orderedLines.length; i++)` 到 commitParagraph() 调用结束
const loopStart = code.indexOf('    for (let i = 0; i < orderedLines.length; i++) {');
const loopEnd = code.indexOf('commitParagraph();', loopStart);
if (loopStart < 0 || loopEnd < 0) throw new Error('抽不到段落主循环');
// 收尾要连 `}`（for 循环闭合）+ 循环后的那次 commitParagraph() 一起带上，
// 否则抽出来的代码块括号不配对（new Function 直接语法报错）。
const tail = code.indexOf('    commitParagraph();', loopEnd + 1);
if (tail < 0) throw new Error('抽不到收尾的 commitParagraph()');
const paraLoop = code.slice(loopStart, tail + '    commitParagraph();'.length);

const splitSentences = extractFn(code, 'function splitEnglishSentencesSmart(text)');

const buildHarness = new Function(`
  ${detectColumnStructure};
  ${splitSentences};
  ${spansToLines};
  /**
   * 复刻 renderPage 里"行聚类 → 分栏 → 段落边界"这条链路，但不碰 DOM。
   * 与 viewer.js 的差异只有：line.section 直接由 lineCenterX 与 effectiveGutterX 比较得出
   * （viewer 里那一段还夹着页眉/元数据/图注桶，本探针只关心正文分栏是否正确）。
   */
  return function segment(spans, pagePdfW, pageNum, opts) {
    opts = opts || {};
    const fakes = { textContent: '', setAttribute() {} };
    const commitParagraph = () => {
      if (curParaLines.length === 0) return;
      const seen = new Set();
      const orderedSpans = [];
      curParaLines.forEach(l => l.spans.forEach(s => { if (!seen.has(s)) { seen.add(s); orderedSpans.push(s); } }));
      const text = curParaLines.map(l => l.spans.map(s => (s.textContent || '').trim()).filter(Boolean).join(' '))
        .join(' ').replace(/\\s+/g, ' ').trim();
      if (!text) { curParaLines = []; curParaType = 'body'; return; }
      paras.push({
        id: paras.length, type: curParaType, cleanText: text,
        sentences: splitEnglishSentencesSmart(text).map(x => x.text),
        lineCount: curParaLines.length,
        firstLine: (curParaLines[0] ? curParaLines[0].spans.map(s => s.textContent).join(' ').slice(0, 60) : ''),
        lastLine: (curParaLines[curParaLines.length - 1] || { spans: [] }).spans.map(s => s.textContent).join(' ').slice(-60),
        minX: Math.min(...curParaLines.map(l => l.minX)),
        maxX: Math.max(...curParaLines.map(l => l.maxX)),
        firstY: curParaLines[0].y, lastY: curParaLines[curParaLines.length - 1].y,
        section: curParaLines[0].section,
        // 跨栏续接要用到（真实 viewer 里这两个字段由 commitParagraph 一并产出）
        rawSpans: orderedSpans, charMap: [], sentencesEn: [], translation: ''
      });
      curParaLines = [];
      curParaType = 'body';
    };

    const colStruct = detectColumnStructure(spans, pagePdfW);
    const gutterX = colStruct.gutterX;
    const isTwoColumnPage = colStruct.twoColumn;
    const isSingleColumnPage = !isTwoColumnPage;
    const effectiveGutterX = isSingleColumnPage ? pagePdfW * 2 : gutterX;
    // 两栏之间的空白带（viewer.js 从 detectColumnStructure 的返回值里取，同口径）
    const gutterBandStart = isSingleColumnPage ? Infinity : colStruct.gutterStart;
    const gutterBandEnd = isSingleColumnPage ? Infinity : colStruct.gutterEnd;

    const RUN_Y_TOL = 3.5;
    const RUN_GAP_TOL = pagePdfW * 0.041;
    const GUTTER_GAP_MIN = pagePdfW * 0.02;
    // 同一行的纵向容差：viewer.js 按页面基准字号算（LINE_Y_TOL），探针同口径复现
    const probeBaseSize = (() => {
      const hs = spans.map(s => (s._pdfH !== undefined ? s._pdfH : 0)).filter(h => h > 5 && h < 13).sort((a, b) => a - b);
      return hs.length ? hs[Math.floor(hs.length / 2)] : 9.5;
    })();
    const LINE_Y_TOL = Math.max(3.5, probeBaseSize * 0.62);

    // ↓↓↓ 以下是 viewer.js 里**原样抽出**的真码（行聚类 + 分栏分流）↓↓↓
${groupCode}
${routeCode}
    // ↑↑↑ 真码结束 ↑↑↑

    const col1Lines = spansToLines(col1Spans, LINE_Y_TOL);
    const col2Lines = spansToLines(col2Spans, LINE_Y_TOL);
    // viewer 里左栏全部排在右栏之前（栏内自上而下）
    const orderedLines = [...col1Lines, ...col2Lines];
    // 本探针只按栏给 section（真实代码还夹着页眉/图注桶）
    col1Lines.forEach(l => l.section = 'col1');
    col2Lines.forEach(l => l.section = 'col2');
    const otherBuckets = {
      topHeaders, metadataSpans, crossColumnCaptionSpans, footnoteSpans
    };
    if (opts.dumpGroups) {
      const wide = lineGroups.filter(g => g.spans.length > 1);
      console.log('--- 行组总计 ' + lineGroups.length + '（多 span 的 ' + wide.length + '）；span 总数 ' + spans.length +
        '，落在多 span 组里的 ' + wide.reduce((n, g) => n + g.spans.length, 0));
      wide.slice(0, 25).forEach(g => console.log('  y=' + g.y.toFixed(1) + ' x=[' + g.minX.toFixed(0) + ',' + g.maxX.toFixed(0) + '] ' +
        JSON.stringify(g.spans.map(s => (s.textContent || '').trim()).join(' | ').slice(0, 110))));
    }
    /*
     * 诊断：把"同一基线上、彼此相邻"的 span 间隙全量打出来。
     * 【为什么需要】分栏沟槽与"同一行内合法的大间隙"（公式左右、表头列、双栏被判单栏时）
     * 只能用**真实间隙分布**来分界，靠猜阈值必然要么串栏要么劈行。
     */
    if (opts.dumpGaps) {
      const rows = new Map();
      spans.forEach(s => {
        const key = Math.round((s._pdfY || 0) * 2) / 2;
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(s);
      });
      const gaps = [];
      [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([y, list]) => {
        const sorted = [...list].sort((a, b) => a._pdfX - b._pdfX);
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1];
          const gap = sorted[i]._pdfX - (prev._pdfX + prev._pdfW);
          if (gap > 5) {
            gaps.push({ y: y, gap: gap,
              left: (prev.textContent || '').trim().slice(-14) + '@' + (prev._pdfX + prev._pdfW).toFixed(0),
              right: (sorted[i].textContent || '').trim().slice(0, 14) + '@' + sorted[i]._pdfX.toFixed(0) });
          }
        }
      });
      gaps.sort((a, b) => a.gap - b.gap);
      console.log('--- 同一基线上的 span 间隙 ≥5pt（共 ' + gaps.length + '）---');
      gaps.slice(0, 45).forEach(g => console.log('  gap=' + g.gap.toFixed(1) + '  y=' + g.y.toFixed(1) + '  ' + g.left + '  ||  ' + g.right));
    }

    let normalLineHeight = 9.5;
    const heights = orderedLines.map(l => l.h).filter(h => h > 5 && h < 13);
    if (heights.length > 0) normalLineHeight = heights.reduce((a, b) => a + b, 0) / heights.length;

    const paras = [];
    let curParaLines = [];
    let curParaType = 'body';
    let prevLine = null;
    let curParaTypeRef = null;

    ${paraLoop}
    // 跨栏续接：viewer.js 原样抽出（它是"串栏"的第二现场）
    ${joinCode}

    const __col1Top = col1Lines.length ? col1Lines[0].y : 0;
    const __col1Bottom = col1Lines.length ? col1Lines[col1Lines.length - 1].y : 0;
    const __col2Top = col2Lines.length ? col2Lines[0].y : 0;
    const __col2Bottom = col2Lines.length ? col2Lines[col2Lines.length - 1].y : 0;
    const __h1 = Math.max(1, __col1Top - __col1Bottom);
    const __h2 = Math.max(1, __col2Top - __col2Bottom);
    return { colStruct, normalLineHeight, paras, col1LineCount: col1Lines.length, col2LineCount: col2Lines.length,
      depth: {
        col1Top: __col1Top, col1Bottom: __col1Bottom, col2Top: __col2Top, col2Bottom: __col2Bottom,
        // 每段在所属栏里的相对纵向位置：0 = 栏顶，1 = 栏底
        of: p => ((p.minX + p.maxX) / 2 < gutterX ? (__col1Top - p.firstY) / __h1 : (__col2Top - p.firstY) / __h2),
        foot: p => ((p.minX + p.maxX) / 2 < gutterX ? (__col1Top - p.lastY) / __h1 : (__col2Top - p.lastY) / __h2)
      },
      dumpLines: opts.dumpLines ? { col1Lines, col2Lines } : null };
  };
`);
const segment = buildHarness();

// ---- 驱动真实 PDF ----------------------------------------------------------
const pdfPath = process.argv[2];
const pages = (process.argv[3] || '1').split(',').map(Number);
const asJson = process.argv.includes('--json');

(async () => {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false }).promise;
  const out = {};
  for (const pageNum of pages) {
    const page = await doc.getPage(pageNum);
    const tc = await page.getTextContent();
    const view = page.view;
    const pagePdfW = view[2] - view[0];
    const spans = tc.items
      .filter(it => typeof it.str === 'string' && it.str.trim().length > 0)
      .map((it, idx) => ({
        textContent: it.str,
        _pdfX: it.transform[4],
        _pdfY: it.transform[5],
        _pdfW: it.width,
        _pdfH: it.height,
        _pdfIdx: idx,
        setAttribute() {}
      }));
    const r = segment(spans, pagePdfW, pageNum, { dumpLines: process.argv.includes('--lines'), dumpGaps: process.argv.includes('--gaps'), dumpGroups: process.argv.includes('--groups') });
    out[pageNum] = r;
    if (asJson) continue;
    if (r.dumpLines) {
      for (const [name, list] of [['col1', r.dumpLines.col1Lines], ['col2', r.dumpLines.col2Lines]]) {
        console.log(`\n--- ${name} 行（${list.length}） ---`);
        list.forEach(l => console.log(`  y=${l.y.toFixed(1).padStart(6)} x=[${l.minX.toFixed(0)},${l.maxX.toFixed(0)}] ${JSON.stringify(l.spans.map(s => s.textContent).join(' ').slice(0, 96))}`));
      }
    }
    console.log(`\n================ PAGE ${pageNum} ================`);
    console.log(`版面判断：${r.colStruct.twoColumn ? '双栏' : '单栏'}  分栏线 x=${r.colStruct.gutterX.toFixed(1)}  ` +
      `左${r.colStruct.leftN || 0}/右${r.colStruct.rightN || 0}  页宽=${pagePdfW.toFixed(0)}` +
      `  行数 左${r.col1LineCount}/右${r.col2LineCount}  普通行高=${r.normalLineHeight.toFixed(1)}`);
    console.log(`切出 ${r.paras.length} 段：`);
    r.paras.forEach(p => {
      const ySpan = `${p.firstY.toFixed(0)}→${p.lastY.toFixed(0)}`;
      const joined = (p.joinedAcrossColumn ? ' ★跨栏合并' : '') + ' 顶深=' + r.depth.of(p).toFixed(2) + ' 底深=' + r.depth.foot(p).toFixed(2);
      console.log(`  #${String(p.id).padStart(2)} [${p.section}/${p.type}] 行数=${p.lineCount} x=[${p.minX.toFixed(0)},${p.maxX.toFixed(0)}] y=${ySpan} 句数=${p.sentences.length}${joined}`);
      console.log(`      「${p.cleanText.slice(0, 150)}${p.cleanText.length > 150 ? '…' : ''}」`);
    });
  }
  if (asJson) console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
