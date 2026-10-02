/**
 * 把 viewer.js 里真实的布局分类管线（2.2 聚行 → 8.5 图表区域）抽出来，
 * 喂真实 PDF span 数据，看每一行最终被分成什么段落类型。
 * 这是唯一能确认"用户实际看到什么"的办法。
 */
const fs = require('fs');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(__dirname, '..', 'test-papers');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');

function extractPipeline(src) {
  // 从版面结构检测开始，覆盖聚行/分类/图表区域全流程
  const start = src.indexOf('const detectColumnStructure = (spanList, pageW) => {');
  const end = src.indexOf('// 9. 段落聚合并构建字符级精确映射表');
  if (start < 0 || end < 0) return null;
  const snippet = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    'spans',
    'pagePdfW',
    'pagePdfH',
    'pageNum',
    'console',
    `${snippet}\n return { orderedLines, isSingleColumnPage, gutterX, captionLabelRegex };`
  );
}

const run = extractPipeline(code);
if (!run) {
  console.error('抽取失败');
  process.exit(1);
}

const pdfPath = path.join(PAPERS_DIR, 'STM.pdf');
const PAGE = Number(process.argv[2] || 3);

(async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false })
    .promise;
  const page = await doc.getPage(PAGE);
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();

  // 复刻 webview 里的 span 形状
  const spans = tc.items
    .filter(it => it.str && it.str.trim())
    .map(it => {
      const el = { textContent: it.str, _pdfX: it.transform[4], _pdfY: it.transform[5], _pdfH: it.height, _pdfW: it.width };
      return el;
    });

  const r = run(spans, vp.width, vp.height, PAGE, console);
  console.log(
    `\n第 ${PAGE} 页：${r.isSingleColumnPage ? '单栏' : `双栏(分栏线 x=${r.gutterX.toFixed(0)})`}，共 ${
      r.orderedLines.length
    } 行\n`
  );

  const typeCount = {};
  r.orderedLines.forEach(l => {
    typeCount[l.section] = (typeCount[l.section] || 0) + 1;
  });
  console.log('类型统计:', JSON.stringify(typeCount), '\n');

  console.log('行明细（section | y | 文本）:');
  r.orderedLines.forEach((l, i) => {
    const t = l.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
    const tag = l.section === 'figure-label' ? '★图表标签' : l.section;
    console.log(`[${String(i + 1).padStart(2)}] ${String(tag).padEnd(12)} y=${String(l.y.toFixed(0)).padStart(3)} x=${l.minX.toFixed(0)}→${l.maxX.toFixed(0)}  ${t.slice(0, 78)}`);
  });
})();
