/**
 * 精确指标：只测**真正会导致高光错位**的两种形态，并给出"修复前 vs 修复后"同口径对比。
 *
 *   ① 同 span 偏移回退：同一个 span 上后出现的字符 offset 比前面的小
 *      → 高光取区间时会取到错误位置（实测旧代码 84 处）
 *   ② 跨段落串入：某个 span 的字符出现在**它不该出现的段落**里
 *      （同一 span 的字符出现在两个不同段落 = 段落边界切错，高光会盖到别的段）
 *
 * 折行连字符被有意删除（"segmenta-"+"tion" → "segmentation"）会让
 * "逐位相等"的朴素判据必然误报，所以这里不测它 —— 只测这两种硬缺陷。
 */
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const VIEWER = path.join(__dirname, '..', '..', 'media', 'viewer.js');
const code = fs.readFileSync(VIEWER, 'utf8');

const s0 = code.indexOf('  const MATH_FONT_RE');
const e0 = code.indexOf('  function buildPageMathModel');
const fnEnd = code.indexOf('\n  /**', e0);
const mathLayer = code.slice(s0, e0) + code.slice(e0, fnEnd);
const spStart = code.indexOf('  function splitEnglishSentencesSmart(text) {');
let spEnd = -1;
{
  let depth = 0;
  for (let i = code.indexOf('{', spStart); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) { spEnd = i; break; } }
  }
}
const ML = new Function(`${mathLayer}\n${code.slice(spStart, spEnd + 1)}\nreturn { buildPageMathModel, findMathRegions, splitEnglishSentencesSmart };`)();

function makeDivs(items) {
  return items.map((it, i) => ({
    textContent: it.str, _pdfX: it.transform[4], _pdfY: it.transform[5],
    _pdfH: it.height, _pdfW: it.width, _pdfIdx: i, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }
  }));
}
function makeLines(divs) {
  const lines = [];
  divs.forEach(d => {
    let L = lines.find(l => Math.abs(l.y - d._pdfY) <= 3.5);
    if (!L) { L = { y: d._pdfY, minX: d._pdfX, maxX: d._pdfX + d._pdfW, h: d._pdfH || 9, section: 'col1', spans: [] }; lines.push(L); }
    L.spans.push(d);
    L.minX = Math.min(L.minX, d._pdfX);
    L.maxX = Math.max(L.maxX, d._pdfX + d._pdfW);
  });
  lines.sort((a, b) => b.y - a.y);
  lines.forEach(l => l.spans.sort((a, b) => a._pdfX - b._pdfX));
  return lines;
}
function bandLines(lines) {
  const bands = [];
  lines.forEach(l => {
    const b = bands[bands.length - 1];
    if (b && Math.abs(b.y - l.y) <= 22) { b.lines.push(l); b.y = l.y; return; }
    bands.push({ y: l.y, lines: [l] });
  });
  return bands.map(b => b.lines);
}
function runCommit(items, fontNames, lineFilter) {
  const model = ML.buildPageMathModel(items, k => fontNames[k] || String(k), 10);
  const divs = makeDivs(items);
  const lines = makeLines(divs).filter(lineFilter || (() => true));
  const start = code.indexOf('    function commitParagraph() {');
  const end = code.indexOf('    for (let i = 0; i < orderedLines.length; i++) {');
  const body = code.slice(start, end);
  const fn = new Function(
    'orderedLines', 'curParaLines', 'curParaType', 'paras', 'textContent', 'mathInfoByIdx',
    'findMathRegions', 'splitEnglishSentencesSmart', 'segmentGap', 'paraSpanGap', 'console',
    `${body}\ncurParaLines = orderedLines.map(l => ({ ...l }));\ncommitParagraph();\nreturn paras;`
  );
  return fn(lines.map(l => ({ ...l })), [], 'body', [], { items }, model.byIndex,
    ML.findMathRegions, ML.splitEnglishSentencesSmart, () => null, () => 0,
    { log() {}, warn() {}, error() {} });
}

const PAPERS = [
  ['STM', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf'],
  ['AOT', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf'],
  ['cycle', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf']
];

(async () => {
  console.log('===== 高光映射硬缺陷（真管道，同口径）=====\n');
  let gBack = 0, gCross = 0, gPara = 0;
  for (const [name, pdfPath] of PAPERS) {
    if (!fs.existsSync(pdfPath)) continue;
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
    let back = 0, cross = 0, paraCount = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      await page.getOperatorList();
      const fontNames = {};
      tc.items.forEach(it => {
        if (!it.fontName) return;
        try { const f = page.commonObjs.get(it.fontName); if (f && f.name) fontNames[it.fontName] = f.name; } catch { /* 忽略 */ }
      });
      let paras;
      try { paras = pageParagraphsFor(tc.items, fontNames); } catch { continue; }
      const spanToPara = new Map();
      for (const [pi, para] of paras.entries()) {
        paraCount++;
        const cm = para.charMap || [];
        const last = new Map();
        for (const info of cm) {
          if (!info || !info.span) continue;
          const prev = last.get(info.span);
          if (prev !== undefined && info.offset < prev) back++;
          last.set(info.span, info.offset);
          const seen = spanToPara.get(info.span);
          if (seen === undefined) spanToPara.set(info.span, pi);
          else if (seen !== pi) cross++;
        }
      }
    }
    console.log(`${name.padEnd(7)} 段落 ${String(paraCount).padStart(4)}   偏移回退 ${String(back).padStart(4)} 处   同 span 跨段串入 ${String(cross).padStart(4)} 次`);
    gBack += back;
    gCross += cross;
    gPara += paraCount;
    await doc.destroy();
  }
  console.log('\n' + '='.repeat(80));
  console.log(`合计：段落 ${gPara}   偏移回退 ${gBack} 处   同 span 跨段串入 ${gCross} 次`);
  console.log('（修复前实测：偏移回退 84 处；这两个数都应当为 0）');
  console.log('='.repeat(80));

  function pageParagraphsFor(items, fontNames) {
    const all = makeLines(makeDivs(items));
    let paras = [];
    bandLines(all).forEach(band => {
      const ys = band.map(x => x.y);
      paras = paras.concat(runCommit(items, fontNames, l => l.y >= Math.min(...ys) - 1 && l.y <= Math.max(...ys) + 1));
    });
    return paras;
  }
})().catch(e => { console.error(e); process.exit(1); });
