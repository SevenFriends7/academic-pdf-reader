/**
 * 复现用户截图里的高光错位：拿那句话，检查它的字符区间（startIdx/endIdx）是否指向正确的文字。
 *
 * 用户截图（AOT 第 6 页）点击的句子以 "where" 开头，内容含
 * "Concat(X_l^{m_1}, ..., X_l^{m_T})" 与 "are the input feature embeddings ... frames with indices"。
 *
 * 判据：
 *   ① sentencesEn[i].text 必须**逐字等于** para.cleanText.slice(startIdx, endIdx)
 *      （不等 → 切句索引与 cleanText 脱节 → 高光覆盖的是别的字符区间）
 *   ② 区间端点必须落在合理的词边界上（不能从半个词中间开始）
 *   ③ 输出的高光块数量与覆盖行数是否吻合
 */
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join('D:\\kx\\上海交大\\academic-pdf-reader', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const VIEWER = 'D:\\kx\\上海交大\\academic-pdf-reader\\media\\viewer.js';
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
  const fn = new Function(
    'orderedLines', 'curParaLines', 'curParaType', 'paras', 'textContent', 'mathInfoByIdx',
    'findMathRegions', 'splitEnglishSentencesSmart', 'segmentGap', 'paraSpanGap', 'console',
    `${code.slice(start, end)}\ncurParaLines = orderedLines.map(l => ({ ...l }));\ncommitParagraph();\nreturn paras;`
  );
  return fn(lines.map(l => ({ ...l })), [], 'body', [], { items }, model.byIndex,
    ML.findMathRegions, ML.splitEnglishSentencesSmart, () => null, () => 0,
    { log() {}, warn() {}, error() {} });
}

const PDF = 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf';
const PAGE = 6;

(async () => {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(PDF)), useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
  const page = await doc.getPage(PAGE);
  const tc = await page.getTextContent();
  await page.getOperatorList();
  const fontNames = {};
  tc.items.forEach(it => {
    if (!it.fontName) return;
    try { const f = page.commonObjs.get(it.fontName); if (f && f.name) fontNames[it.fontName] = f.name; } catch { /* 忽略 */ }
  });
  const all = makeLines(makeDivs(tc.items));
  let paras = [];
  bandLines(all).forEach(band => {
    const ys = band.map(x => x.y);
    paras = paras.concat(runCommit(tc.items, fontNames, l => l.y >= Math.min(...ys) - 1 && l.y <= Math.max(...ys) + 1));
  });

  const target = paras.find(p => /input\s*feature|feature\s*embeddings/i.test(p.cleanText) && /Concat/i.test(p.cleanText));
  if (!target) {
    console.log('没找到目标段落。该页段落一览：');
    paras.forEach((p, i) => console.log(`  [${i}] ${JSON.stringify(p.cleanText.slice(0, 90))}`));
    return;
  }
  console.log('=== 目标段落 ===');
  console.log(`段落 #${target.id}  type=${target.type}  cleanText ${target.cleanText.length} 字符`);
  console.log(JSON.stringify(target.cleanText.slice(0, 400)));
  console.log(`\nsentencesEn ${(target.sentencesEn || []).length} 条：`);

  let mismatch = 0;
  (target.sentencesEn || []).forEach((s, i) => {
    const slice = target.cleanText.slice(s.startIdx, s.endIdx);
    const same = slice === s.text;
    if (!same) mismatch++;
    const flag = same ? '✅' : '❌';
    console.log(`  ${flag} [${i}] startIdx=${s.startIdx} endIdx=${s.endIdx}  text=${JSON.stringify(String(s.text).slice(0, 70))}`);
    if (!same) {
      console.log(`        cleanText 同区间实际是: ${JSON.stringify(slice.slice(0, 70))}`);
      console.log(`        ← 索引与文本脱节，高光会盖到这段文字上`);
    }
  });
  console.log(`\n结论：${(target.sentencesEn || []).length} 条句中，${mismatch} 条的区间与文本不一致`);
  if (mismatch) {
    console.log('→ 这就是"高光看起来乱"的直接原因：高光画的是 startIdx..endIdx 这段字符，');
    console.log('  但这段字符与句子的实际位置对不上，于是高光落在别的文字上/长度不对。');
  }
  await doc.destroy();
})().catch(e => { console.error(e); process.exit(1); });
