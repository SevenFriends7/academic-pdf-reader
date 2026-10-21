/**
 * 打印 viewer.js 真实管线产出的 orderedLines 顺序（section + y + 文本），
 * 用来解释"某个段落为什么横跨两栏"。
 * 用法: node scratch/order_trace.js <pdf> <页码>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8').replace(/\r\n/g, '\n');

function matchBrace(src, openIdx) {
  let d = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (!d) return i; }
  }
  throw new Error('括号不配对');
}
const fnStart = code.indexOf('  function buildAcademicLayout(pageNum, textContent, textDivs, viewport, fontNames) {');
const braceStart = code.indexOf('{', fnStart + 30);
const archIdx = code.indexOf('archivePageParagraphs(pageNum, paras);', braceStart);
const body = code.slice(braceStart + 1, archIdx);
const mathStart = code.indexOf('  const MATH_FONT_RE =');
const mathEnd = code.indexOf('  function buildAcademicLayout(pageNum,');
const sentStart = code.indexOf('  function splitEnglishSentencesSmart(text) {');
const sentEnd = code.indexOf('  function splitChineseSentences(text) {');
const factory = new Function('stubs', 'pageNum', 'textContent', 'textDivs', 'viewport', 'fontNames', `
  const { showVisionBadge, renderTranslationCards, archivePageParagraphs, cloneParagraphs,
          requestVisionSegmentation, vscode, visionPending, visionEngine } = stubs;
  let currentParagraphs = null, localParagraphsSnapshot = null, localParagraphsPage = 0;
  let currentPage = pageNum;
  function restoreModelMathFromArchive() {}
  ${code.slice(mathStart, mathEnd)}
  ${code.slice(sentStart, sentEnd)}
  ${body}
  return { orderedLines, paras };
`);
const stubs = {
  showVisionBadge() {}, renderTranslationCards() {}, archivePageParagraphs() {},
  cloneParagraphs: l => l, requestVisionSegmentation: async () => {}, vscode: { postMessage() {} },
  visionPending: new Set(), visionEngine: 'local', setTimeout() {}, console
};
(async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(process.argv[2])), useSystemFonts: false }).promise;
  const page = await doc.getPage(Number(process.argv[3] || 4));
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  const divs = tc.items.map((it, i) => ({
    textContent: it.str, _pdfX: it.transform[4], _pdfY: it.transform[5], _pdfW: it.width,
    _pdfH: it.height, _pdfIdx: i, setAttribute() {}
  }));
  const r = factory(stubs, Number(process.argv[3] || 4), tc, divs, vp, null);
  r.orderedLines.forEach((l, i) => {
    const t = l.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
    console.log(`[${String(i + 1).padStart(3)}] ${String(l.section).padEnd(12)} y=${l.y.toFixed(1).padStart(6)} x=${l.minX.toFixed(0)}→${l.maxX.toFixed(0)}  ${JSON.stringify(t.slice(0, 72))}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
