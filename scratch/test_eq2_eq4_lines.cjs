const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

async function inspectLines() {
  const file = 'D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/ICLR-2025-pointobb-v2-towards-simpler-faster-and-stronger-single-point-supervised-oriented-object-detection-Paper-Conference.pdf';
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data }).promise;
  const page = await doc.getPage(5);
  const textContent = await page.getTextContent();
  const fontNames = {};
  for (const it of textContent.items || []) {
    if (it && it.fontName && !fontNames[it.fontName]) {
      try {
        const obj = page.commonObjs.get(it.fontName);
        if (obj && obj.name) fontNames[it.fontName] = String(obj.name);
      } catch (e) {}
    }
  }

  const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;
  const vp = page.getViewport({ scale: 1.0 });
  const ops = await page.getOperatorList();
  const rawGraphics = V2.extractRawPageVectors(ops, pdfjs.OPS, vp.width, vp.height);
  const mockSpans = (textContent.items || []).map((it, idx) => ({
    textContent: it.str || '',
    _pdfIdx: idx,
    setAttribute() {},
  }));

  const decoded = V2.decodePageGlyphs(textContent.items, (k) => fontNames[k] || k, 10);
  
  // Let's filter glyphs around y = 40 to 180 (where eq 2, 3, 4 are located)
  const mathGlyphs = decoded.glyphs.filter(g => g.y >= 265 && g.y <= 315);
  console.log('Math glyphs count:', mathGlyphs.length);
  // Sort by Y descending
  const yMap = new Map();
  for (const g of mathGlyphs) {
    const yKey = g.y.toFixed(1);
    if (!yMap.has(yKey)) yMap.set(yKey, []);
    yMap.get(yKey).push(g);
  }
  const sortedYs = Array.from(yMap.keys()).sort((a,b) => parseFloat(b) - parseFloat(a));
  for (const y of sortedYs) {
    const list = yMap.get(y);
    list.sort((a,b) => a.x - b.x);
    console.log(`y=${y} (minX=${list[0].x.toFixed(1)}, maxX=${list[list.length-1].right.toFixed(1)}): ${list.map(g => g.text).join(' ')}`);
  }
}

inspectLines().catch(console.error);
