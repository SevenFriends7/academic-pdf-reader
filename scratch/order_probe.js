/**
 * 阅读顺序临时探针：打印某一页 orderedLines 的 section / 坐标 / 文本，
 * 用于修 reorderFigureBlocks 时看真实版面数据。
 *
 * 用法：PAPERS_DIR=<论文目录> node scratch/order_probe.js <页码> [文件名]
 *   VIEWER_SRC=<另一个 viewer.js>   用别的版本（如 git show HEAD:media/viewer.js）跑，做 before/after 对照
 *   DEBUG_LAYOUT=1                  把 viewer 内部的 console.log 放出来（viewer 拿到的是形参 console）
 */
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(ROOT, 'test-papers');
const PAGE = Number(process.argv[2] || 6);
const FILE = process.argv[3] || 'STM.pdf';

const code = fs.readFileSync(process.env.VIEWER_SRC || path.join(ROOT, 'media', 'viewer.js'), 'utf8');

function extractLayout(src) {
  const start = src.indexOf('const detectColumnStructure = (spanList, pageW) => {');
  const end = src.indexOf('// 9. 段落聚合并构建字符级精确映射表');
  if (start < 0 || end < 0) return null;
  // eslint-disable-next-line no-new-func
  return new Function(
    'spans',
    'pagePdfW',
    'pagePdfH',
    'pageNum',
    'console',
    `${src.slice(start, end)}\n return { orderedLines, gutterX, isSingleColumnPage, captionLabelRegex, col1Lines, col2Lines, crossCaptionLines };`
  );
}

const layout = extractLayout(code);
if (!layout) {
  console.error('代码抽取失败');
  process.exit(1);
}

const textOf = l => l.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
const colOfLine = (l, gutterX) => ((l.minX + l.maxX) / 2 < gutterX ? 'col1' : 'col2');

(async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(PAPERS_DIR, FILE))), useSystemFonts: false })
    .promise;
  const page = await doc.getPage(PAGE);
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  const spans = tc.items
    .filter(i => i.str && i.str.trim())
    .map(i => ({
      textContent: i.str,
      _pdfX: i.transform[4],
      _pdfY: i.transform[5],
      _pdfH: i.height,
      _pdfW: i.width,
      setAttribute() {}
    }));

  const r = layout(spans, vp.width, vp.height, PAGE, process.env.DEBUG_LAYOUT ? console : { log() {} });
  console.log(`第 ${PAGE} 页 gutterX=${r.gutterX.toFixed(1)} 单栏=${r.isSingleColumnPage} 共 ${r.orderedLines.length} 行`);
  console.log('idx  section       y      minX   maxX   自然栏  文本');
  r.orderedLines.forEach((l, i) => {
    console.log(
      `${String(i).padStart(3)}  ${String(l.section).padEnd(12)} ${String(l.y.toFixed(1)).padStart(6)} ` +
        `${String(l.minX.toFixed(0)).padStart(5)} ${String(l.maxX.toFixed(0)).padStart(6)}  ` +
        `${colOfLine(l, r.gutterX).padEnd(5)}  ${textOf(l).slice(0, 62)}`
    );
  });
})();
