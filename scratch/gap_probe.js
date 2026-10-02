/** 逐 span 打印某一页的某几行，量出左右栏之间的真实间隙 */
const fs = require('fs');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(__dirname, '..', 'test-papers');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const pdfPath = path.join(PAPERS_DIR, 'STM.pdf');
const PAGE = Number(process.argv[2] || 4);
const TARGET_Y = (process.argv[3] || '').split(',').filter(Boolean).map(Number);

(async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false })
    .promise;
  const page = await doc.getPage(PAGE);
  const vp = page.getViewport({ scale: 1.0 });
  const gutter = vp.width * 0.495;
  console.log(`第 ${PAGE} 页 宽=${vp.width} 分栏线=${gutter.toFixed(1)}`);
  const tc = await page.getTextContent();
  const items = tc.items
    .filter(it => it.str && it.str.trim())
    .map(it => ({ s: it.str, x: it.transform[4], x2: it.transform[4] + it.width, y: it.transform[5] }));

  const ys = TARGET_Y.length ? TARGET_Y : [...new Set(items.map(i => Math.round(i.y)))].slice(0, 12);
  for (const ty of ys) {
    const row = items.filter(i => Math.abs(i.y - ty) <= 2).sort((a, b) => a.x - b.x);
    if (!row.length) continue;
    console.log(`\n=== y≈${ty} ===`);
    let prevEnd = null;
    row.forEach(it => {
      const gap = prevEnd === null ? null : it.x - prevEnd;
      const mark =
        gap === null
          ? ''
          : gap < 0
            ? '  ←重叠'
            : gap <= 12
              ? '  ←极小间隙(我的规则会合并)'
              : gap <= 25
                ? '  ←中等间隙'
                : '  ←大间隙(不合并)';
      const crossesGutter = prevEnd !== null && prevEnd < gutter && it.x > gutter;
      console.log(
        `  x=${it.x.toFixed(0).padStart(4)}→${it.x2.toFixed(0).padStart(4)} gap=${gap === null ? '  -' : gap.toFixed(1).padStart(5)}${crossesGutter ? ' 跨分栏线' : ''}${mark}  ${JSON.stringify(it.s)}`
      );
      prevEnd = it.x2;
    });
  }
})();
