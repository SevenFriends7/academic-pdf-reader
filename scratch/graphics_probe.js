/** 列出某页所有矢量横线/竖线（PDF 坐标），用于设计通用版式规则。 */
'use strict';
const fs = require('fs');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const OPS = pdfjs.OPS;
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
];
const pt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function extract(ol) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const h = [], v = [], rects = [];
  const addSeg = (x1, y1, x2, y2) => {
    if (Math.abs(y1 - y2) <= 1.2 && Math.abs(x1 - x2) >= 12) h.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: (y1 + y2) / 2 });
    else if (Math.abs(x1 - x2) <= 1.2 && Math.abs(y1 - y2) >= 12) v.push({ x: (x1 + x2) / 2, y1: Math.min(y1, y2), y2: Math.max(y1, y2) });
  };
  const addRect = (x, y, w, hh) => {
    if (w < 0) { x += w; w = -w; }
    if (hh < 0) { y += hh; hh = -hh; }
    if (w <= 2.5 && hh >= 12) v.push({ x: x + w / 2, y1: y, y2: y + hh });
    else if (hh <= 2.5 && w >= 12) h.push({ x1: x, x2: x + w, y: y + hh / 2 });
    else if (w >= 12 && hh >= 12) rects.push({ x, y, w, h: hh });
  };
  const cur = [];
  ol.fnArray.forEach((fn, i) => {
    const args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.moveTo) { const p = pt(ctm, args[0], args[1]); cur.length = 0; cur.push(p); }
    else if (fn === OPS.lineTo) { const p = pt(ctm, args[0], args[1]); if (cur.length) addSeg(cur[0][0], cur[0][1], p[0], p[1]); cur[0] = p; }
    else if (fn === OPS.rectangle) { const p = pt(ctm, args[0], args[1]); const q = pt(ctm, args[0] + args[2], args[1] + args[3]); addRect(p[0], p[1], q[0] - p[0], q[1] - p[1]); }
    else if (fn === OPS.constructPath) {
      const ops = args[0], coords = args[1];
      let k = 0, last = null;
      for (const op of ops) {
        if (op === OPS.moveTo) { last = pt(ctm, coords[k++], coords[k++]); }
        else if (op === OPS.lineTo) { const p = pt(ctm, coords[k++], coords[k++]); if (last) addSeg(last[0], last[1], p[0], p[1]); last = p; }
        else if (op === OPS.rectangle) { const p = pt(ctm, coords[k++], coords[k++]); const w = coords[k++], hh = coords[k++]; const q = pt(ctm, p[0] + w, p[1] + hh); addRect(p[0], p[1], q[0] - p[0], q[1] - p[1]); last = null; }
        else if (op === OPS.curveTo) { k += 6; last = null; }
        else if (op === OPS.closePath) { last = null; }
      }
    }
  });
  return { h, v, rects };
}

(async () => {
  const [pdfPath, pageArg] = process.argv.slice(2);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)) }).promise;
  const page = await doc.getPage(Number(pageArg));
  const ol = await page.getOperatorList();
  const g = extract(ol);
  console.log('page', pageArg, 'h', g.h.length, 'v', g.v.length, 'rects', g.rects.length);
  console.log('\n-- long horizontal (>=60) --');
  g.h.filter(x => x.x2 - x.x1 >= 60).sort((a, b) => b.y - a.y).slice(0, 40).forEach(x => console.log(`y=${x.y.toFixed(1)} x=${x.x1.toFixed(1)}..${x.x2.toFixed(1)} len=${(x.x2 - x.x1).toFixed(1)}`));
  console.log('\n-- long vertical (>=30) --');
  g.v.filter(x => x.y2 - x.y1 >= 30).sort((a, b) => b.x - a.x).slice(0, 30).forEach(x => console.log(`x=${x.x.toFixed(1)} y=${x.y1.toFixed(1)}..${x.y2.toFixed(1)} len=${(x.y2 - x.y1).toFixed(1)}`));
  console.log('\n-- rects (>=20x20) --');
  g.rects.filter(x => x.w >= 20 && x.h >= 20).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 20).forEach(x => console.log(`x=${x.x.toFixed(1)} y=${x.y.toFixed(1)} w=${x.w.toFixed(1)} h=${x.h.toFixed(1)}`));
})().catch(e => { console.error(e); process.exit(1); });
