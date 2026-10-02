/** 调试沟槽检测：打印行首聚类过程 */
const fs = require('fs');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(__dirname, '..', 'test-papers');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const start = code.indexOf('const detectColumnStructure = (spanList, pageW) => {');
const end = code.indexOf('const colStruct = detectColumnStructure(spans, pagePdfW);');
const fn = new Function(
  'DEBUG',
  `${code.slice(start, end)}\n return detectColumnStructure;`
);

const pdfPath = process.argv[3] || path.join(PAPERS_DIR, 'STM.pdf');
const PAGE = Number(process.argv[2] || 3);

(async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
  const page = await doc.getPage(PAGE);
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  const spans = tc.items
    .filter(i => i.str && i.str.trim())
    .map(i => ({ textContent: i.str, _pdfX: i.transform[4], _pdfY: i.transform[5], _pdfH: i.height, _pdfW: i.width }));

  // 复刻检测内部过程并打印
  const rows = [];
  spans.forEach(s => {
    const y = s._pdfY, x = s._pdfX, w = s._pdfW, len = (s.textContent || '').trim().length;
    let r = rows.find(it => Math.abs(it.y - y) <= 3.5);
    if (!r) rows.push({ y, minX: x, maxX: x + w, textLen: len });
    else { if (x < r.minX) r.minX = x; if (x + w > r.maxX) r.maxX = x + w; r.textLen += len; }
  });
  const BIN = 4;
  const hist = new Map();
  rows.forEach(r => { const b = Math.round(r.minX / BIN) * BIN; hist.set(b, (hist.get(b) || 0) + 1); });
  console.log(`页宽 ${vp.width}  视觉行 ${rows.length}`);
  console.log('\n行首 x 直方图（仅显示计数≥2）:');
  [...hist.entries()].filter(([, n]) => n >= 2).sort((a, b) => a[0] - b[0]).forEach(([x, n]) => console.log(`  x=${String(x).padStart(4)}  n=${n}`));
  const th = Math.max(3, rows.length * 0.06);
  const peaks = [...hist.entries()].filter(([, n]) => n >= th).sort((a, b) => a[0] - b[0]);
  console.log(`\n峰值阈值 = ${th.toFixed(1)}，通过阈值的箱: ${peaks.map(p => p[0] + '(' + p[1] + ')').join(', ') || '（无）'}`);
  const clusters = [];
  peaks.forEach(([x, n]) => {
    const last = clusters[clusters.length - 1];
    if (last && x - last.max <= BIN * 2) { last.max = x; last.count += n; }
    else clusters.push({ min: x, max: x, count: n });
  });
  console.log('合并后的簇:', clusters.map(c => `[${c.min}-${c.max}]×${c.count}`).join(' ') || '（无）');
  if (clusters.length >= 2) {
    let bi = -1, bg = 0;
    for (let i = 1; i < clusters.length; i++) { const g = clusters[i].min - clusters[i - 1].max; if (g > bg) { bg = g; bi = i; } }
    console.log(`最大簇间隔 = ${bg}（需 ≥ ${(vp.width * 0.15).toFixed(1)}），位置 i=${bi}`);
    if (bi >= 0) {
      const lce = clusters[bi - 1].max, rs = clusters[bi].min;
      const leftEnds = rows.filter(r => r.minX <= lce + 8 && r.textLen >= 10).map(r => r.maxX).filter(x => x < rs - 10).sort((a, b) => a - b);
      const leftN = rows.filter(r => r.minX <= lce + 8 && r.textLen >= 10).length;
      const rightN = rows.filter(r => r.minX >= rs - 8 && r.textLen >= 10).length;
      console.log(`左簇右沿=${lce} 右簇起点=${rs}  左栏行=${leftN} 右栏行=${rightN}  左栏右边缘样本数=${leftEnds.length}`);
      if (leftEnds.length >= 5) console.log(`左栏右边缘中位数=${leftEnds[Math.floor(leftEnds.length / 2)]} → 分栏线≈${((leftEnds[Math.floor(leftEnds.length / 2)] + rs) / 2).toFixed(1)}`);
    }
  }
  const det = fn(true);
  console.log('\n检测结果:', JSON.stringify(det(spans, vp.width)));
})();
