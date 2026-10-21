/**
 * 探查 Xu 2020 (Decentralized VI-UWB) 第 4 页的真实文字层坐标。
 * 目的：搞清楚"图注吞掉右栏正文/正文吞掉公式"到底是哪几行的 x/y 区间造成的。
 * 用法: node scratch/probe_xu_p4.js [页码]
 */
const fs = require('fs');
const path = require('path');

const PDF = 'D:\\kx\\上海交大\\UWB融合空中集群\\文献及要求\\Xu 等 - 2020 - Decentralized Visual-Inertial-UWB Fusion for Relative State Estimation of Aerial Swarm.pdf';
const PAGE = Number(process.argv[2] || 4);

(async () => {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(PDF));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise;
  const page = await doc.getPage(PAGE);
  const viewport = page.getViewport({ scale: 1.0 });
  console.log(`页 ${PAGE} 尺寸 ${viewport.width.toFixed(1)} x ${viewport.height.toFixed(1)}`);
  const tc = await page.getTextContent();
  const items = tc.items
    .filter(it => it.str && it.str.trim())
    .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height }));
  items.sort((a, b) => (Math.abs(a.y - b.y) > 3.5 ? b.y - a.y : a.x - b.x));
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!cur || Math.abs(cur.y - it.y) > 3.5) {
      cur = { y: it.y, x: it.x, maxX: it.x + it.w, parts: [it.str] };
      lines.push(cur);
    } else {
      cur.parts.push(it.str);
      cur.maxX = Math.max(cur.maxX, it.x + it.w);
    }
  }
  console.log(`共 ${lines.length} 行   页宽一半=${(viewport.width / 2).toFixed(0)}  分栏线估计=${(viewport.width * 0.495).toFixed(0)}`);
  lines.forEach((l, i) => {
    const text = l.parts.join('').replace(/\s+/g, ' ').trim();
    console.log(
      `[${String(i + 1).padStart(3)}] y=${l.y.toFixed(0).padStart(4)} x=${l.x.toFixed(0).padStart(4)}..${l.maxX.toFixed(0).padStart(4)} len=${String(text.length).padStart(4)} | ${text.slice(0, 160)}`
    );
  });
})();
