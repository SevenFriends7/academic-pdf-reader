/** 探针：打印某页某段的“送翻译文本”（含 ⟦…⟧ 占位），验证公式包裹/控制字符归一化。 */
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
const helperStart = code.indexOf('  function normalizeMathGlyphs(s) {');
const helperEnd = code.indexOf('  function triggerParagraphTranslate(', helperStart);

const factory = new Function('stubs', 'pageNum', 'textContent', 'textDivs', 'viewport', 'fontNames', `
  const { showVisionBadge, renderTranslationCards, archivePageParagraphs, cloneParagraphs,
          requestVisionSegmentation, vscode, visionPending, visionEngine } = stubs;
  let currentParagraphs = null, localParagraphsSnapshot = null, localParagraphsPage = 0;
  let currentPage = pageNum;
  function restoreModelMathFromArchive() {}
  ${code.slice(mathStart, mathEnd)}
  ${code.slice(sentStart, sentEnd)}
  ${body}
  ${code.slice(helperStart, helperEnd)}
  return { paras, buildMergedMathTranslateInput };
`);
const stubs = {
  showVisionBadge() {}, renderTranslationCards() {}, archivePageParagraphs() {},
  cloneParagraphs: l => l, requestVisionSegmentation: async () => {}, vscode: { postMessage() {} },
  visionPending: new Set(), visionEngine: 'local', setTimeout() {}, console
};

(async () => {
  const [pdfPath, pageArg, ...idxArgs] = process.argv.slice(2);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
  const page = await doc.getPage(Number(pageArg));
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  await page.getOperatorList();
  const fontNames = {};
  tc.items.forEach(it => {
    if (!it.fontName) return;
    try { fontNames[it.fontName] = page.commonObjs.get(it.fontName).name || ''; } catch {}
  });
  const divs = tc.items.map((it, i) => ({
    textContent: it.str, _pdfX: it.transform[4], _pdfY: it.transform[5], _pdfW: it.width,
    _pdfH: it.height, _pdfIdx: i, setAttribute() {}
  }));
  const r = factory(stubs, Number(pageArg), tc, divs, vp, fontNames);
  const idxs = idxArgs.length ? idxArgs.map(Number) : r.paras.map((_, i) => i);
  for (const i of idxs) {
    const p = r.paras[i];
    const input = r.buildMergedMathTranslateInput(p);
    console.log(`\n===== para ${i} type=${p.type} =====`);
    console.log('cleanText:', JSON.stringify(p.cleanText));
    console.log('input:', JSON.stringify(input && input.text));
    console.log('sentences:', JSON.stringify(input && input.sentences));
  }
})().catch(e => { console.error(e); process.exit(1); });
