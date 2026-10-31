/** 探针：打印某页 formula 段落的 rawSpans 并集（近似裁图范围）与周边字形范围。 */
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
  const [pdfPath, pageArg] = process.argv.slice(2);
  const pageNum = Number(pageArg);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
  const page = await doc.getPage(pageNum);
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
  const r = factory(stubs, pageNum, tc, divs, vp, fontNames);
  r.paras.forEach((p, i) => {
    if (p.type !== 'formula') return;
    const sp = (p.rawSpans || []).filter(s => s && s._pdfX !== undefined);
    if (!sp.length) { console.log(`[${i}] formula no rawSpans`); return; }
    const x0 = Math.min(...sp.map(s => s._pdfX));
    const x1 = Math.max(...sp.map(s => s._pdfX + (s._pdfW || 0)));
    const y0 = Math.min(...sp.map(s => s._pdfY));
    const y1 = Math.max(...sp.map(s => s._pdfY + (s._pdfH || 0)));
    // 该范围内所有字形（含被过滤掉的 delimiter）的真实范围
    const near = tc.items.filter(it => {
      const y = it.transform[5];
      return y >= y0 - 20 && y <= y1 + 20;
    });
    const ix0 = Math.min(...near.map(it => it.transform[4]));
    const ix1 = Math.max(...near.map(it => it.transform[4] + (it.width || 0)));
    const iy0 = Math.min(...near.map(it => it.transform[5]));
    const iy1 = Math.max(...near.map(it => it.transform[5] + (it.height || 0)));
    console.log(`[${i}] ${JSON.stringify(p.cleanText.slice(0, 28))} spans=${sp.length} spanBox x=${x0.toFixed(1)}..${x1.toFixed(1)} y=${y0.toFixed(1)}..${y1.toFixed(1)} | 邻域字形 x=${ix0.toFixed(1)}..${ix1.toFixed(1)} y=${iy0.toFixed(1)}..${iy1.toFixed(1)}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
