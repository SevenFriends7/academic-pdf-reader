/**
 * 抽 viewer.js 里**真实的**版面分类管线（detectColumnStructure → 8.6 阅读顺序重排），
 * 喂真实 PDF 的 span，打印每行最终 section 与 orderedLines 顺序 —— 用来定位
 * "图注吞掉整栏正文 / 公式残渣串进正文"到底发生在哪一步。
 *
 * 【与 layout_truth.js 的差别】那份止于 8.5 之前；本次 bug 就发生在
 * markCrossCaptionBlocks / extendCaptionBlocks / reorderFigureBlocks 这三步里，
 * 所以必须一直抽到 "// 9. 段落聚合并构建字符级精确映射表" 之前。
 *
 * 用法: node scratch/layout_trace.js <pdf> <页码> [--lines]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8').replace(/\r\n/g, '\n');

const start = code.indexOf('const detectColumnStructure = (spanList, pageW) => {');
const end = code.indexOf('// 9. 段落聚合并构建字符级精确映射表');
if (start < 0 || end < 0) {
  console.error('抽取失败: start=' + start + ' end=' + end);
  process.exit(1);
}
const snippet = code.slice(start, end);

const run = new Function(
  'spans',
  'pagePdfW',
  'pagePdfH',
  'pageNum',
  'console',
  `${snippet}\n return { orderedLines, isSingleColumnPage, gutterX, captionLabelRegex,
      col1Lines, col2Lines, crossCaptionLines, lineGroups };`
);

const pdfPath = process.argv[2];
const PAGE = Number(process.argv[3] || 4);
const showLines = process.argv.includes('--lines');

(async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
  const page = await doc.getPage(PAGE);
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  const spans = tc.items
    .filter(it => it.str && it.str.trim())
    .map((it, idx) => ({
      textContent: it.str,
      _pdfX: it.transform[4],
      _pdfY: it.transform[5],
      _pdfH: it.height,
      _pdfW: it.width,
      _pdfIdx: idx,
      setAttribute() {}
    }));

  const r = run(spans, vp.width, vp.height, PAGE, console);
  console.log(`\n第 ${PAGE} 页：${r.isSingleColumnPage ? '单栏' : `双栏(分栏线 x=${r.gutterX.toFixed(0)})`}  orderedLines=${r.orderedLines.length}`);
  const typeCount = {};
  r.orderedLines.forEach(l => { typeCount[l.section] = (typeCount[l.section] || 0) + 1; });
  console.log('类型统计:', JSON.stringify(typeCount), '\n');
  r.orderedLines.forEach((l, i) => {
    const t = l.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
    console.log(`[${String(i + 1).padStart(2)}] ${String(l.section).padEnd(12)} y=${String(l.y.toFixed(1)).padStart(6)} x=${l.minX.toFixed(0)}→${l.maxX.toFixed(0)}  ${t.slice(0, 100)}`);
  });
  if (showLines) {
    console.log('\n--- crossCaptionLines 原始（markCrossCaptionBlocks 之前） ---');
    r.crossCaptionLines.forEach(l => console.log(`  y=${l.y.toFixed(1)} ${l.section || '(未标)'} x=${l.minX.toFixed(0)}→${l.maxX.toFixed(0)} ${JSON.stringify(l.spans.map(s => s.textContent).join(' ').slice(0, 90))}`));
  }
})().catch(e => { console.error(e); process.exit(1); });
