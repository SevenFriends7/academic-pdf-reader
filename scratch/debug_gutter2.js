/** 调试沟槽检测（片段版）：打印片段行首直方图与聚类结果 */
const fs = require('fs');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(__dirname, '..', 'test-papers');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const pdfPath = process.argv[2] || path.join(PAPERS_DIR, 'cycle.pdf');
const PAGE = Number(process.argv[3] || 1);

(async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
  const page = await doc.getPage(PAGE);
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  const spans = tc.items
    .filter(i => i.str && i.str.trim())
    .map(i => ({ textContent: i.str, _pdfX: i.transform[4], _pdfY: i.transform[5], _pdfH: i.height, _pdfW: i.width }));

  const pageW = vp.width;
  const SEG_GAP = Math.max(4, pageW * 0.01);
  console.log(`页宽 ${pageW}  SEG_GAP=${SEG_GAP.toFixed(1)}  跨度数 ${spans.length}`);

  const rows = [];
  spans.forEach(s => {
    const y = s._pdfY, x = s._pdfX, w = s._pdfW, len = (s.textContent || '').trim().length;
    let r = rows.find(it => Math.abs(it.y - y) <= 3.5);
    if (!r) { r = { y, segs: [], textLen: 0 }; rows.push(r); }
    r.textLen += len;
    let placed = false;
    for (const sg of r.segs) {
      if (Math.min(sg.maxX, x + w) - Math.max(sg.minX, x) >= -SEG_GAP) {
        sg.minX = Math.min(sg.minX, x); sg.maxX = Math.max(sg.maxX, x + w); placed = true; break;
      }
    }
    if (!placed) r.segs.push({ minX: x, maxX: x + w });
  });
  console.log(`视觉行 ${rows.length}`);

  const BIN = 4;
  const hist = new Map();
  rows.forEach(r => r.segs.forEach(sg => { const b = Math.round(sg.minX / BIN) * BIN; hist.set(b, (hist.get(b) || 0) + 1); }));
  const th = Math.max(3, rows.length * 0.08);
  console.log(`\n片段行首直方图（阈值 ${th.toFixed(1)}）:`);
  [...hist.entries()].sort((a, b) => a[0] - b[0]).forEach(([x, n]) => {
    if (n >= 2) console.log(`  x=${String(x).padStart(4)} n=${String(n).padStart(3)} ${n >= th ? '←峰值' : ''}`);
  });

  const peaks = [...hist.entries()].filter(([, n]) => n >= th).sort((a, b) => a[0] - b[0]);
  const clusters = [];
  peaks.forEach(([x, n]) => {
    const last = clusters[clusters.length - 1];
    if (last && x - last.max <= BIN * 3) { last.max = x; last.count += n; } else clusters.push({ min: x, max: x, count: n });
  });
  console.log('\n簇:', clusters.map(c => `[${c.min}-${c.max}]×${c.count}`).join(' ') || '（无）');
  if (clusters.length >= 2) {
    let bi = -1, bg = 0;
    for (let i = 1; i < clusters.length; i++) { const g = clusters[i].min - clusters[i - 1].max; if (g > bg) { bg = g; bi = i; } }
    console.log(`最大间隔 ${bg}（需 ≥ ${(pageW * 0.15).toFixed(1)}）i=${bi}`);
    if (bi >= 0) {
      const lce = clusters[bi - 1].max, rs = clusters[bi].min;
      let leftN = 0, rightN = 0; const leftEnds = []; const rightWidths = [];
      rows.forEach(r => {
        let lm = -1, rm = -1;
        r.segs.forEach(sg => {
          if (sg.minX <= lce + 8 && sg.maxX < rs - 10) lm = Math.max(lm, sg.maxX);
          if (sg.minX >= rs - 8) rm = Math.max(rm, sg.maxX);
        });
        if (lm > 0) { leftN++; if (r.textLen >= 10) leftEnds.push(lm); }
        if (rm > 0) { rightN++; if (r.textLen >= 10) rightWidths.push(rm - rs); }
      });
      leftEnds.sort((a, b) => a - b);
      console.log(`左簇右沿=${lce} 右簇起点=${rs} 左栏行=${leftN} 右栏行=${rightN} 左边缘样本=${leftEnds.length} 右宽度样本=${rightWidths.length}`);
      const spread = arr => {
        if (arr.length < 5) return Infinity;
        const s = [...arr].sort((a, b) => a - b);
        const p10 = s[Math.floor(s.length * 0.1)], p90 = s[Math.floor(s.length * 0.9)], med = s[Math.floor(s.length / 2)];
        return med > 0 ? (p90 - p10) / med : Infinity;
      };
      console.log(`左边缘离散度=${spread(leftEnds).toFixed(3)}（需 ≤ 0.2）`);
      const maxRW = Math.max(...rightWidths, 1);
      const longR = rightWidths.filter(w => w >= maxRW * 0.5).length;
      console.log(`右栏宽行数=${longR}（需 ≥ 5，maxRW=${maxRW.toFixed(0)}）`);
      if (leftEnds.length) console.log(`左栏右边缘中位数=${leftEnds[Math.floor(leftEnds.length / 2)]} → 分栏线≈${((leftEnds[Math.floor(leftEnds.length / 2)] + rs) / 2).toFixed(1)}`);
    }
  }
})();
