/**
 * 探针：用 viewer.js 真实管线（buildAcademicLayout）跑一页，打印段落类型与文本，
 * 用来定位"整页被识别成一堆公式"。
 * 用法: [VIEWER_FILE=其他 viewer.js] node scratch/probe_para.js <pdf> <page>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const ROOT = path.join(__dirname, '..');
const VIEWER_FILE = process.env.VIEWER_FILE || path.join(ROOT, 'media', 'viewer.js');
const code = fs.readFileSync(VIEWER_FILE, 'utf8').replace(/\r\n/g, '\n');

const fnStart = code.indexOf('  function buildAcademicLayout(pageNum, textContent, textDivs, viewport, fontNames) {');
const braceStart = code.indexOf('{', fnStart + 30);
const archIdx = code.indexOf('archivePageParagraphs(pageNum, paras);', braceStart);
const body = code.slice(braceStart + 1, archIdx);
const mathStart = code.indexOf('  const MATH_FONT_RE =');
const mathEnd = code.indexOf('  function buildAcademicLayout(pageNum,');
const sentStart = code.indexOf('  function splitEnglishSentencesSmart(text) {');
const sentEnd = code.indexOf('  function splitChineseSentences(text) {');
const gStart = code.indexOf('  function extractPageGraphics(');
const gEnd = code.indexOf('  /**\n   * 页面自适应统计', gStart);
const sStart = code.indexOf('  function estimatePageStats(');
const sEnd = code.indexOf('  function buildAcademicLayout(', sStart);
const graphicsCode = code.slice(gStart, gEnd);
const statsCode = code.slice(sStart, sEnd);
const graphicsFactory = new Function(`${graphicsCode}\n return extractPageGraphics;`)();
const factory = new Function('stubs', 'pageNum', 'textContent', 'textDivs', 'viewport', 'fontNames', `
  const { showVisionBadge, renderTranslationCards, archivePageParagraphs, cloneParagraphs,
          requestVisionSegmentation, vscode, visionPending, visionEngine } = stubs;
  let currentParagraphs = null, localParagraphsSnapshot = null, localParagraphsPage = 0;
  let currentPage = pageNum;
  function restoreModelMathFromArchive() {}
  ${code.slice(mathStart, mathEnd)}
  ${code.slice(sentStart, sentEnd)}
  ${statsCode}
  ${body}
  return { orderedLines, paras };
`);
const stubs = {
  showVisionBadge() {}, renderTranslationCards() {}, archivePageParagraphs() {},
  cloneParagraphs: l => l, requestVisionSegmentation: async () => {}, vscode: { postMessage() {} },
  visionPending: new Set(), visionEngine: 'local', setTimeout() {}, console
};

(async () => {
  const pdfPath = process.argv[2];
  const pageNum = Number(process.argv[3] || 1);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    useSystemFonts: false, disableFontFace: true, isEvalSupported: false
  }).promise;
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  const opList = await page.getOperatorList();
  const fontNames = {};
  tc.items.forEach(it => {
    if (!it.fontName) return;
    try {
      const f = page.commonObjs.get(it.fontName);
      if (f && f.name) fontNames[it.fontName] = f.name;
    } catch { /* ignore */ }
  });
  const divs = tc.items.map((it, i) => ({
    textContent: it.str, _pdfX: it.transform[4], _pdfY: it.transform[5], _pdfW: it.width,
    _pdfH: it.height, _pdfIdx: i, setAttribute() {}
  }));
  stubs.graphics = graphicsFactory(opList, vp.viewBox[3], vp.viewBox[2]);
  const r = factory(stubs, pageNum, tc, divs, vp, fontNames);
  const counts = {};
  r.paras.forEach(p => { counts[p.type || 'body'] = (counts[p.type || 'body'] || 0) + 1; });
  console.log(`第 ${pageNum} 页：${r.paras.length} 段  ${JSON.stringify(counts)}`);
  r.paras.forEach((p, i) => {
    const math = (p.segments || []).filter(s => s.kind === 'math').length;
    console.log(`\n[${i}] ${p.type || 'body'} mathSegs=${math} len=${p.cleanText.length}${p.visionLatex ? ' latex=' + JSON.stringify(String(p.visionLatex).slice(0, 60)) : ''}`);
    console.log('   ' + JSON.stringify(p.cleanText.slice(0, 220)));
  });
})().catch(e => { console.error(e); process.exit(1); });
