/**
 * viewer.js 段落产出真值 harness：把 **buildAcademicLayout 的真实代码**（含数学层）原样抽出来，
 * 用真实 PDF 的 text item 跑一遍，打印"用户在界面上实际会看到的段落卡片"。
 *
 * 【为什么必须抽真码】1.6.14 缓存里第 4 页出现「图注吞掉正文前半句 + 右栏公式残渣串进图注」，
 * 而 seg_probe / layout_truth 这类探针都没覆盖 markCrossCaptionBlocks / extendCaptionBlocks /
 * reorderFigureBlocks + 真 commitParagraph，复刻版会给出"看起来没问题"的假结论。
 *
 * 用法: node scratch/paras_truth.js <pdf> <页码> [--commit] [--fonts] [--dump]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
/* VIEWER_SRC 可以指向另一份 viewer.js —— 用来做"改动前/改动后"的同页对照 */
const SRC = process.env.VIEWER_SRC || path.join(ROOT, 'media', 'viewer.js');
const code = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

/** 锚点可选插入：找不到就跳过（用于拿旧版 viewer.js 做 before/after 对照） */
function insertAfterIfAny(src, anchor, extraLines) {
  if (src.indexOf(anchor) < 0) return src;
  return insertAfter(src, anchor, extraLines);
}
const hasAnchor = (src, a) => src.indexOf(a) >= 0;
/**
 * 从 openIdx 处的 '{' 找到配对 '}'。
 *
 * 【必须跳过字符串/注释/正则里的花括号】裸数字符会被两类内容骗到：
 *   · 源码里的字符串 `'a) { shouldStartNew = …'`；
 *   · **正则字符类** `/[∑∏∫…{}∥]/`（给跨栏续接加的那条判据就是这个形态）。
 * 被它们带偏之后配对标到的位置会差几个花括号，报出来的是
 * "括号不配对 @82941" 这种根本看不出原因的错（实测踩到）。
 */
function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  const isRegexStart = k => {
    for (let j = k - 1; j >= 0; j--) {
      const c = src[j];
      if (c === '\n') return true;
      if (/\s/.test(c)) continue;
      return !/[A-Za-z0-9_$)\]}"'`]/.test(c);
    }
    return true;
  };
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (ch === '/' && next === '*') { const e = src.indexOf('*/', i); i = e < 0 ? src.length : e + 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && isRegexStart(i)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error('括号不配对 @' + openIdx);
}

/**
 * 在 anchor 之后插入代码，**按锚点行的缩进对齐**。
 * 锚点找不到就直接抛——绝不静默跳过（实测静默跳过会让探针"看起来没效果"，
 * 排查方向被带偏）。
 */
function insertAfter(src, anchor, extraLines) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error('注入锚点找不到：' + anchor.slice(0, 70));
  const lineStart = src.lastIndexOf('\n', at) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart))[0];
  const pad = '\n' + extraLines.map(l => indent + '  ' + l).join('\n');
  return src.slice(0, at + anchor.length) + pad + src.slice(at + anchor.length);
}

const fnStart = code.lastIndexOf('  function buildAcademicLayout(pageNum, textContent, textDivs, viewport, fontNames) {');
if (fnStart < 0) throw new Error('抽不到 buildAcademicLayout');
const braceStart = code.indexOf('{', fnStart + 30);
const braceEnd = matchBrace(code, braceStart);
/*
 * 抽取范围：MATH_FONT_RE（数学层开头）→ archivePageParagraphs 的真实定义之前。
 * 中间依次是：数学层常量与函数 → buildAcademicLayout（内含 buildPageMathModel）→ 目录 → 各步处理。
 * 【切到哪为止】archivePageParagraphs 及其后的渲染逻辑都用 stub 顶掉（多跑几步，对段落没有影响），
 * 否则会和 stubs 里的同名声明撞车（实测 `Identifier 'archivePageParagraphs' has already been declared`）。
 */
const mathStart = code.indexOf('  const MATH_FONT_RE =');
const archDef = code.indexOf('  function archivePageParagraphs(pageNum, paras) {');
const sliceEnd = archDef > 0 && archDef < braceEnd ? archDef : braceEnd + 1;
if (mathStart < 0 || sliceEnd < 0) throw new Error('抽不到抽取范围');
let body = code.slice(mathStart, sliceEnd);

// ① 图注头（看 extendCaptionBlocks 拿哪一行当基准）
body = insertAfter(
  body,
  '        const below = orderedLines.filter(l => l !== head && l.y < head.y).sort((a, b) => b.y - a.y);',
  [
    'TRACE.headText = textOf(head).slice(0, 40);',
    'TRACE.heads.push({ y: head.y, h: head.h, minX: head.minX, maxX: head.maxX, sec: head.section, t: TRACE.headText,',
    '  belowTop: below.slice(0, 6).map(l => ({ y: +l.y.toFixed(1), sec: l.section, x: [l.minX, l.maxX], t: textOf(l).slice(0, 40) })) });'
  ]
);
// ② 被当作图注折行吞掉的行。
// 【锚点怎么选】`line.section = 'caption';` 在切片里出现 4 次，必须带上**紧跟其后的收尾语句**，
// 而且那个收尾还得只在 extendCaptionBlocks 里出现。踩过两次坑：
//   · 只写 `line.section = 'caption';` → 命中 4 次，insertAfter 插到 processColumnLines 里；
//   · 用 "…line.section='caption';\n…lastY = line.y;\n        }" → 命中了 markCrossCaptionBlocks
//     （那里没有 textOf），STM 第 3 页直接 ReferenceError。
// 现在带上各版本独有的前置语句（新版是 fill 判据，老版是 prevGap 连乘），命中即唯一。
const absorbAnchors = [
  // 新版
  "          if (fill < 0.22) continue;\n          line.section = 'caption';\n          lastY = line.y;",
  // 老版
  "          if (numCount >= 3) break;\n          line.section = 'caption';\n          prevGap = gap > 0 ? gap : prevGap;"
];
let absorbAnchor = null;
for (const a of absorbAnchors) {
  const n = body.split(a).length - 1;
  if (n === 1) { absorbAnchor = a; break; }
  if (n > 1) throw new Error(`图注吸收锚点命中 ${n} 次（应为 1）：${a.slice(0, 40)}`);
}
if (!absorbAnchor) throw new Error('找不到图注吸收锚点（新旧版都对不上）');
body = insertAfter(
  body,
  absorbAnchor,
  [
    "TRACE.capAdd.push({ head: TRACE.headText, y: line.y, gap: (lastY - line.y), gapLimit: (typeof gapLimit !== 'undefined' ? gapLimit : null), sec: line.section, x: [line.minX, line.maxX], fill: (typeof fillRatioOf === 'function' ? fillRatioOf(line) : null), ext: (typeof colExtent !== 'undefined' ? JSON.stringify(colExtent) : null), t: t.slice(0, 70) });"
  ]
);
// ③ 段落主循环：每一行落到哪一段
body = insertAfter(
  body,
  '      curParaLines.push(line);\n      prevLine = line;',
  ['TRACE.commit.push({ i: i, sec: line.section, type: nextType, isNew: shouldStartNew, y: +line.y.toFixed(1), bm: line.__blockMath === true, x: [+line.minX.toFixed(0), +line.maxX.toFixed(0)], h: +line.h.toFixed(1), t: text.slice(0, 46) });']
);
// ③b 中止吸收的那一行（行距超限）。旧版变量名是 limit，新版是 gapLimit —— 两版都兼容
body = insertAfterIfAny(
  body,
  '          if (gap > gapLimit) break;',
  ['TRACE.capBreak.push({ y: line.y, gap: gap, limit: gapLimit, x: [line.minX, line.maxX], sec: line.section, t: textOf(line).slice(0, 70) });']
);
body = insertAfterIfAny(
  body,
  '          if (gap > limit) break;',
  ['TRACE.capBreak.push({ y: line.y, gap: gap, limit: limit, x: [line.minX, line.maxX], sec: line.section, t: textOf(line).slice(0, 70) });']
);
// （诊断注入已移除：确认过主循环会跑之后就没必要再刷屏）
/*
 * ④ 把结果挂到 globalThis。
 * 【为什么不用 return】`paras` 是切片里的 `const`，一旦落在某个内层块里，外层 return 就会
 * `ReferenceError: paras is not defined`，而报错点看起来完全不在逻辑上（实测踩过）。
 * 在最后一次 commitParagraph() 之后挂出去，那一行 `paras` 必然在作用域里。
 */
const tailAnchor = '    // 9.5 跨栏续接';
if (!body.includes(tailAnchor)) throw new Error('找不到段落聚合收尾锚点');
body = body.replace(
  tailAnchor,
  ['    globalThis.__ERRLOG("[harness] 命中收尾锚点 paras=" + paras.length);',
    '    {',
    '      globalThis.__PARAS_TRUTH = { paras: paras, orderedLines: orderedLines, isSingleColumnPage: isSingleColumnPage, gutterX: gutterX, captionLabelRegex: captionLabelRegex };',
    '    }',
    '',
    '    // 9.5 跨栏续接'].join('\n')
);
// 诊断：入口处的两个提前 return（否则"什么都没发生"根本无从判断）
body = insertAfter(
  body,
  '    const rawSpans = Array.from(textDivs).filter(d => (d.textContent || \'\').trim());',
  ['globalThis.__ERRLOG("[harness] buildAcademicLayout 入口: items=" + ((textContent && textContent.items && textContent.items.length) || 0) + " textDivs=" + textDivs.length + " rawSpans=" + rawSpans.length);']
);

const sentStart = code.indexOf('  function splitEnglishSentencesSmart(text) {');
const sentEnd = code.indexOf('  function splitChineseSentences(text) {');
if (sentStart < 0 || sentEnd < 0) throw new Error('抽不到句子拆分器');

const stubs = {
  showVisionBadge() {},
  renderTranslationCards() {},
  archivePageParagraphs() {},
  cloneParagraphs: l => l,
  requestVisionSegmentation: async () => {},
  vscode: { postMessage() {} },
  visionPending: new Set(),
  visionEngine: 'local',
  setTimeout() {},
  console
};

/*
 * window / document 也要喂：切片里夹着 toggleTextLayerDebug 这类"跟段落无关但同在一个文件里"的
 * 函数，定义时不会执行，但一旦引用 window 就 ReferenceError（实测 `window is not defined`，
 * 报错点根本不在要测的逻辑上）。
 *
 * 【必须自己调用 buildAcademicLayout】切片只是"把函数定义搬过来"，不会有人替我们调用它
 * （viewer.js 里是 renderPage 调的）。少这一步的表现是：拼装代码执行完、一行日志都没有、
 * 也拿不到段落 —— 看起来像"注入没生效"，其实是压根没跑（实测卡了很久）。
 * textDivs 要传 span 数组，不是 DOM 元素（renderPage 里传的也是 textLayer 的 span）。
 */
const ASSEMBLED = `
  globalThis.__ERRLOG('[harness] 拼装代码开始执行');
  const { showVisionBadge, renderTranslationCards, archivePageParagraphs, cloneParagraphs,
          requestVisionSegmentation, vscode, visionPending, visionEngine } = stubs;
  /* 归档恢复只影响 latex 回填，与段落切分无关；harness 没有存档，空实现即可 */
  function restoreModelMathFromArchive() {}
  ${code.slice(sentStart, sentEnd)}
  ${code.slice(code.indexOf('  function normalizeVisionType(t) {'), code.indexOf('  function mergeParagraphs('))}
  ${body}
  buildAcademicLayout(pageNum, textContent, textDivs, viewport, fontNames);
`;
let factory;
/*
 * 注入的收尾代码必须落在**函数体的顶层**（不能被包进任何内层块/提前 return 的分支），
 * 否则会静默地永远跑不到。这里打一行自查（正常应打印"含 __PARAS_TRUTH: true"）。
 */
console.log('[harness] 源=%s 拼装 %d 行，含 __PARAS_TRUTH: %s', path.relative(ROOT, SRC), ASSEMBLED.split('\n').length, ASSEMBLED.includes('__PARAS_TRUTH'));
try {
  factory = new Function('stubs', 'pageNum', 'textContent', 'textDivs', 'viewport', 'fontNames', 'TRACE', 'window', 'document', ASSEMBLED);
} catch (e) {
  /*
   * 拼装出来的代码只要有一个字符不对，new Function 只报 `<anonymous_script>:NNNN`，无从下手。
   * 所以语法错时先把拼装结果落盘、再打印出错行附近的源码。
   */
  const f = path.join(ROOT, 'scratch', '_paras_truth_assembled.js');
  fs.writeFileSync(f, ASSEMBLED, 'utf8');
  const m = /<anonymous_script>:(\d+)/.exec(e.stack || '');
  const ln = m ? Number(m[1]) : 0;
  console.error(`拼装代码语法错：${e.message}  已写出 ${f}`);
  if (ln) {
    const lines = ASSEMBLED.split('\n');
    for (let i = Math.max(0, ln - 4); i < Math.min(lines.length, ln + 3); i++) {
      console.error(`${String(i + 1).padStart(5)} | ${lines[i]}`);
    }
  }
  throw e;
}

const pdfPath = process.argv[2];
const PAGE = Number(process.argv[3] || 4);
/* 直写 stderr：拼装代码里的 console 是被参数遮蔽的，用它打诊断信息未必看得见 */
globalThis.__ERRLOG = m => process.stderr.write(String(m) + '\n');
const TRACE = { capAdd: [], capBreak: [], heads: [], headText: '', commit: [] };

(async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
  const page = await doc.getPage(PAGE);
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  /*
   * 真实字体名表：webview 从 page.commonObjs 取（`QZLXPR+CMSY10` 这样的真名）。
   * node 端 harness 拿不到（pdf.js 只在渲染时取字体对象；page.objs.get 的回调在 node 里
   * 永远不触发 —— 实测 callback fired? false），所以用环境变量 FONTMAP 手工喂一份映射，
   * 专门用来验证"数学层打开"时的行为。
   */
  const fontNames = {};
  if (process.env.FONTMAP) {
    try { Object.assign(fontNames, JSON.parse(fs.readFileSync(process.env.FONTMAP, 'utf8'))); } catch (e) { console.warn('fontmap 读取失败', e.message); }
  }
  if (process.argv.includes('--fonts')) console.log('字体表:', JSON.stringify(fontNames));

  const items = tc.items;
  const textDivs = items.map((it, i) => ({
    textContent: it.str,
    _pdfX: it.transform[4],
    _pdfY: it.transform[5],
    _pdfW: it.width,
    _pdfH: it.height,
    _pdfIdx: i,
    setAttribute() {}
  }));

  const fakeWin = { addEventListener() {}, removeEventListener() {} };
  const fakeDoc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }),
    addEventListener() {}, removeEventListener() {}, body: { appendChild() {}, classList: { add() {}, remove() {} } }
  };
  const stubs = {
    showVisionBadge() {},
    renderTranslationCards() {},
    archivePageParagraphs() {},
    cloneParagraphs: l => l,
    requestVisionSegmentation: async () => {},
    vscode: { postMessage() {} },
    visionPending: new Set(),
    visionEngine: 'local',
    setTimeout() {},
    console
  };
  const r = (() => {
    try { return factory(stubs, PAGE, tc, textDivs, vp, fontNames, TRACE, fakeWin, fakeDoc); } catch (err) {
      console.error('factory 执行抛错:', err && err.stack ? err.stack : err);
      return null;
    }
  })();
  const res = r || globalThis.__PARAS_TRUTH;
  if (!res) throw new Error('没有拿到段落结果（注入的收尾代码没跑到）');

  if (process.argv.includes('--commit')) {
    console.log('\n--- 段落主循环：每一行的归属 ---');
    let n = 0;
    TRACE.commit.forEach(c => {
      if (c.isNew) n++;
      console.log(`  #${String(n).padStart(2)}${c.isNew ? '▸' : ' '} [${c.sec}/${c.type}] y=${String(c.y).padStart(6)} bm=${c.bm ? 1 : 0} x=${c.x[0]}~${c.x[1]} 「${c.t}」`);
    });
  }
  if (TRACE.heads.length) {
    console.log('\n--- extendCaptionBlocks 的图注头 ---');
    TRACE.heads.forEach(h => console.log(`head y=${h.y.toFixed(1)} h=${h.h.toFixed(1)} x=[${h.minX.toFixed(0)},${h.maxX.toFixed(0)}] sec=${h.sec} 「${h.t}」`));
  }
  if (TRACE.capAdd.length) {
    console.log('\n--- 被当作图注折行吞掉的行 ---');
    const num = v => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) : 'n/a');
    TRACE.capAdd.forEach(a => console.log(`  y=${a.y.toFixed(1)} gap=${num(a.gap)} gapLimit=${num(a.gapLimit)} sec=${a.sec} x=[${a.x[0].toFixed(0)},${a.x[1].toFixed(0)}] fill=${a.fill === null ? 'n/a' : a.fill.toFixed(2)} ext=${a.ext} 「${a.t}」`));
  }
  if (TRACE.capBreak.length) {
    console.log('\n--- 中止吸收的行 ---');
    const num2 = v => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) : 'n/a');
    TRACE.capBreak.forEach(a => console.log(`  y=${a.y.toFixed(1)} gap=${num2(a.gap)} limit=${num2(a.limit)} sec=${a.sec} x=[${a.x[0].toFixed(0)},${a.x[1].toFixed(0)}] 「${a.t}」`));
  }

  console.log(`\n===== 第 ${PAGE} 页：${res.isSingleColumnPage ? '单栏' : `双栏 gutter=${res.gutterX.toFixed(0)}`}  段落 ${res.paras.length} 段 =====`);
  if (process.argv.includes('--json')) {
    /* 只打一行 JSON，供 before/after 自动对照（含每段的类型与文本前 60 字） */
    console.log('JSON ' + JSON.stringify({
      page: PAGE,
      lines: (res.orderedLines || []).map(l => ({
        y: l.y, minX: l.minX, maxX: l.maxX, sec: l.section,
        block: l.__blockMath === true,
        text: (l.spans || []).map(s => s.textContent || '').join(' ').trim().slice(0, 80)
      })),
      paras: res.paras.map(p => ({
        type: p.type,
        len: (p.cleanText || '').length,
        merged: !!p.mergedMath,
        notation: !!p.notationTable,
        mergedFormula: !!p.formulaByMergedRows,
        head: (p.cleanText || '').slice(0, 60),
        text: p.cleanText || '',
        sentences: p.sentencesEn || [],
        id: p.id,
        segments: (p.segments || []).map(s => ({ kind: s.kind, text: s.text, latex: s.latex, spans: (s.spans || []).length })),
        localMath: p.localMath || [],
        visionLatex: p.visionLatex || '',
        spans: (p.rawSpans || []).map(s => ({
          t: s && s.textContent,
          x: s && s._pdfX,
          y: s && s._pdfY,
          w: s && s._pdfW,
          h: s && s._pdfH,
          idx: s && s._pdfIdx
        })),
        // charMap 里的 span 用 rawSpans 下标表示，便于离线回放（-1 = 合成空格/无名片段）
        charMap: (p.charMap || []).map(c => (c && c.span ? { s: (p.rawSpans || []).indexOf(c.span), o: c.offset } : null))
      }))
    }));
    return;
  }
  res.paras.forEach((p, i) => {
    console.log(`\n#${i} type=${p.type} minX=${(p.minX || 0).toFixed(0)} maxX=${(p.maxX || 0).toFixed(0)} 字符=${(p.cleanText || '').length}`);
    console.log('EN: ' + (p.cleanText || '').replace(/\s+/g, ' '));
  });
})().catch(e => { console.error(e); process.exit(1); });
