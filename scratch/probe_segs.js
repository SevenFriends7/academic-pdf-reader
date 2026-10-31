/** 探针：打印某页每个段落的 segments（kind/latex/文本/基线范围），用于公式分段排查。 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8').replace(/\r\n/g, '\n');

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
  const [pdfPath, pageArg, idxArg] = process.argv.slice(2);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
  const page = await doc.getPage(Number(pageArg));
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  await page.getOperatorList();
  const fontNames = {};
  tc.items.forEach(it => {
    if (!it.fontName) return;
    try { fontNames[it.fontName] = page.commonObjs.get(it.fontName).name || ''; } catch { /* ignore */ }
  });
  const divs = tc.items.map((it, i) => ({
    textContent: it.str, _pdfX: it.transform[4], _pdfY: it.transform[5], _pdfW: it.width,
    _pdfH: it.height, _pdfIdx: i, setAttribute() {}
  }));
  const r = factory(stubs, Number(pageArg), tc, divs, vp, fontNames);
  (r.paras[idxArg ? Number(idxArg) : 0]).segments.forEach((s, i) => {
    const ys = (s.items || []).map(it => it.y);
    console.log(`seg#${i} ${s.kind} run=${s.runId} n=${(s.items || []).length} y=${ys.length ? Math.min(...ys).toFixed(1) + '..' + Math.max(...ys).toFixed(1) : '-'} text=${JSON.stringify(String(s.text || '').slice(0, 50))} latex=${JSON.stringify(s.latex || '')}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
