/**
 * 版面诊断基准：对一组 PDF 逐页跑真实 buildAcademicLayout，输出可疑指标。
 *
 * 用法：
 *   node scratch/layout_bench.js <a.pdf> [b.pdf ...] [--pages 1-8]
 *   VIEWER_FILE=旧 viewer.js node scratch/layout_bench.js ...   # 对比改动前后
 *
 * 指标不是"正确率"（没有人工标注），而是**可比较的失败信号**：
 *   huge-body   正文段 > 1200 字（通常是算法/表格被并进正文）
 *   ctrl-glyph  正文含 U+000F 等控制字形（CMMIB 的 ε）
 *   raw-latex   正文含 \leftarrow / \nabla 一类裸命令
 *   lower-start 正文段以小写字母开头（跨页/跨栏断句）
 *   footnote / algorithm 识别数量
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
const graphicsFactory = new Function(`${code.slice(gStart, gEnd)}\n return extractPageGraphics;`)();
const factory = new Function('stubs', 'pageNum', 'textContent', 'textDivs', 'viewport', 'fontNames', `
  const { showVisionBadge, renderTranslationCards, archivePageParagraphs, cloneParagraphs,
          requestVisionSegmentation, vscode, visionPending, visionEngine } = stubs;
  let currentParagraphs = null, localParagraphsSnapshot = null, localParagraphsPage = 0;
  let currentPage = pageNum;
  function restoreModelMathFromArchive() {}
  ${code.slice(mathStart, mathEnd)}
  ${code.slice(sentStart, sentEnd)}
  ${code.slice(sStart, sEnd)}
  ${body}
  return { orderedLines, paras };
`);
const stubs = {
  showVisionBadge() {}, renderTranslationCards() {}, archivePageParagraphs() {},
  cloneParagraphs: l => l, requestVisionSegmentation: async () => {}, vscode: { postMessage() {} },
  visionPending: new Set(), visionEngine: 'local', setTimeout() {}, console,
  /*
   * 跨页续接要用"上一页的段落快照"（真实 webview 里是 pageParaArchive）。
   * 基准里逐页顺序跑，所以这里自己维护一份：每跑完一页就把轻量快照放进去，
   * 下一轮的 buildAcademicLayout 就能像线上一样读到 pageNum-1。
   */
  pageParaArchive: new Map()
};

function parsePages(arg) {
  if (!arg) return [1, 2, 3, 4, 5, 6];
  const m = String(arg).match(/^(\d+)-(\d+)$/);
  if (!m) return [Number(arg) || 1];
  const out = [];
  for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
  return out;
}

(async () => {
  let pageArg = null;
  const pdfs = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pages') pageArg = argv[++i];
    else pdfs.push(argv[i]);
  }
  if (!pdfs.length) {
    console.error('用法: node scratch/layout_bench.js <a.pdf> [b.pdf ...] [--pages 1-8]');
    process.exit(2);
  }
  const pages = parsePages(pageArg);
  const all = [];
  for (const pdfPath of pdfs) {
    if (!fs.existsSync(pdfPath)) { console.error('跳过不存在:', pdfPath); continue; }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
    const paper = { pdf: path.basename(pdfPath), pages: [] };
    stubs.pageParaArchive.clear();
    for (const pageNum of pages) {
      if (pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      const vp = page.getViewport({ scale: 1.0 });
      const tc = await page.getTextContent();
      const opList = await page.getOperatorList();
      const fontNames = {};
      tc.items.forEach(it => {
        if (!it.fontName) return;
        try { const f = page.commonObjs.get(it.fontName); if (f && f.name) fontNames[it.fontName] = f.name; } catch {}
      });
      const divs = tc.items.map((it, i) => ({
        textContent: it.str, _pdfX: it.transform[4], _pdfY: it.transform[5], _pdfW: it.width,
        _pdfH: it.height, _pdfIdx: i, setAttribute() {}
      }));
      stubs.graphics = graphicsFactory(opList, vp.viewBox[3], vp.viewBox[2]);
      const r = factory(stubs, pageNum, tc, divs, vp, fontNames);
      // 与 archivePageParagraphs 同口径：只留轻量字段，模拟"本页已归档，下一页可读"
      stubs.pageParaArchive.set(pageNum, r.paras.map(p => ({
        id: p.id, type: p.type, cleanText: p.cleanText,
        sentencesEn: (p.sentencesEn || []).map(s => ({ text: s.text }))
      })));
      const types = {};
      r.paras.forEach(p => { types[p.type || 'body'] = (types[p.type || 'body'] || 0) + 1; });
      const joined = r.paras.filter(p => p.continuedFromPage).length;
      const findings = [];
      r.paras.forEach(p => {
        const text = String(p.cleanText || '');
        if (p.type === 'body' && text.length > 1200) findings.push({ kind: 'huge-body', id: p.id, len: text.length });
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) findings.push({ kind: 'ctrl-glyph', id: p.id });
        if (/\\[A-Za-z]{2,}/.test(text)) findings.push({ kind: 'raw-latex', id: p.id });
        if (p.type === 'body' && /^[a-z]/.test(text.trim())) findings.push({ kind: 'lower-start', id: p.id });
      });
      const row = { page: pageNum, paras: r.paras.length, types, joined, findings };
      paper.pages.push(row);
      all.push({ pdf: paper.pdf, ...row });
      const flag = findings.length ? findings.map(f => f.kind).join(',') : 'ok';
      console.log(`${paper.pdf.padEnd(44)} p${String(pageNum).padEnd(2)} paras=${String(r.paras.length).padEnd(3)} ${JSON.stringify(types)}${joined ? `  joined=${joined}` : ''}  ${flag}`);
    }
  }
  const outDir = path.join(ROOT, '..', 'output_test');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'layout_bench.json'), JSON.stringify(all, null, 2), 'utf8');
  const counts = {};
  all.forEach(r => r.findings.forEach(f => { counts[f.kind] = (counts[f.kind] || 0) + 1; }));
  const joinedTotal = all.reduce((n, r) => n + (r.joined || 0), 0);
  console.log(`\n汇总失败信号: ${JSON.stringify(counts)}  跨页续接 ${joinedTotal} 段`);
  console.log('明细:', path.join(outDir, 'layout_bench.json'));
})().catch(e => { console.error(e); process.exit(1); });
