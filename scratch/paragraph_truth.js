/**
 * 段落切分真相工具：用 viewer.js 里**真实的排版 + 段落聚合代码**跑某一页，
 * 打印最终生成的段落（类型 + 英文原文 + 长度），用于定位"一行一段 / 段落串味 / 漏翻译"。
 *
 * 用法：PAPERS_DIR=<论文目录> node scratch/paragraph_truth.js <页码> [文件名]
 */
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(ROOT, 'test-papers');
const PAGE = Number(process.argv[2] || 6);
const FILE = process.argv[3] || 'STM.pdf';

const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

/** 抽出排版管线（到 orderedLines 生成为止） */
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
    `${src.slice(start, end)}\n return { orderedLines, gutterX, isSingleColumnPage, captionLabelRegex };`
  );
}

/** 抽出段落聚合（commitParagraph + 主循环） */
function extractParagraphizer(src) {
  const start = src.indexOf('    function commitParagraph() {');
  const endMarker = '    let bodyCount = 0;';
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) return null;
  // eslint-disable-next-line no-new-func
  return new Function(
    'orderedLines',
    'captionLabelRegex',
    'pageNum',
    'splitEnglishSentencesSmart',
    'isSingleColumnPage',
    'gutterX',
    'console',
    `let paras = [];
     let curParaLines = [];
     let curParaType = 'body';
     ${src.slice(start, end)}
     return paras;`
  );
}

const layout = extractLayout(code);
const paragraphize = extractParagraphizer(code);
if (!layout || !paragraphize) {
  console.error('代码抽取失败');
  process.exit(1);
}

const simpleSplitter = t =>
  (t || '')
    .split(/(?<=[.!?])\s+(?=[A-Z(“"'])/)
    .map(s => s.trim())
    .filter(Boolean);

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
      setAttribute() {} // commitParagraph 会写 data-para-id，这里给个空实现
    }));

  const r = layout(spans, vp.width, vp.height, PAGE, { log() {} });
  const paras = paragraphize(
    r.orderedLines,
    r.captionLabelRegex,
    PAGE,
    simpleSplitter,
    r.isSingleColumnPage,
    r.gutterX,
    { log() {} }
  );

  console.log(`\n第 ${PAGE} 页：${r.isSingleColumnPage ? '单栏' : `双栏(分栏线 x=${r.gutterX.toFixed(0)})`}，行 ${r.orderedLines.length}，段落 ${paras.length}\n`);
  console.log('行高分布（判断 isHeading 用的均值）：');
  const hs = r.orderedLines.map(l => l.h).filter(h => h > 5 && h < 13);
  if (hs.length) {
    const mean = hs.reduce((a, b) => a + b, 0) / hs.length;
    console.log(`  参与统计 ${hs.length} 行，均值 ${mean.toFixed(2)}，阈值(×1.28) ${(mean * 1.28).toFixed(2)}`);
    const over = r.orderedLines.filter(l => l.h > mean * 1.28 && l.spans.length <= 5).length;
    console.log(`  被判为「高行=headings」的行数：${over}\n`);
  }

  const stat = {};
  paras.forEach(p => (stat[p.type] = (stat[p.type] || 0) + 1));
  console.log('段落类型统计:', JSON.stringify(stat), '\n');

  paras.forEach((p, i) => {
    const t = (p.cleanText || '').replace(/\s+/g, ' ').trim();
    const flag = t.length < 90 ? '  ⚠️ 过短（疑似一行一段）' : '';
    console.log(`[${String(i).padStart(2)}] ${p.type.padEnd(12)} ${String(t.length).padStart(4)} 字${flag}`);
    console.log(`     ${t.slice(0, 120)}`);
  });
})();
