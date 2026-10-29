/** 扫描 PDF 每页段落，用真实断句器检查"可疑句"（碎片/缩写结尾/列表编号单独成句）。 */
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
  const pdfPath = process.argv[2];
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
  let paragraphs = 0;
  let suspicious = 0;
  for (let pg = 1; pg <= doc.numPages; pg++) {
    const page = await doc.getPage(pg);
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
    const r = factory(stubs, pg, tc, divs, vp, fontNames);
    r.paras.filter(p => p.type === 'body' || p.type === 'abstract').forEach(p => {
      const sents = (p.sentencesEn || []).map(s => s.text.trim()).filter(Boolean);
      paragraphs++;
      sents.forEach((s, i) => {
        const short = s.length < 12;
        const abbrEnd = /(?:^|\s)(?:[A-Za-z]\.){2,}$/.test(s) || /\b(?:i\.e|e\.g|w\.r\.t|et al|fig|eq)\.$/.test(s);
        const listOnly = /^(?:\(?\d{1,2}[.)]?\s*)$/.test(s);
        if (short || abbrEnd || listOnly) {
          suspicious++;
          console.log(`p${pg} para#${p.id} s${i + 1} ${short ? '[SHORT]' : ''}${abbrEnd ? '[ABBR]' : ''}${listOnly ? '[LIST]' : ''} ${JSON.stringify(s)}`);
        }
      });
    });
  }
  console.log(`\n扫描完成：${paragraphs} 段，可疑句 ${suspicious}`);
})().catch(e => { console.error(e); process.exit(1); });
