const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function trace362Row() {
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

  const decoded = V2.decodePageGlyphs(textContent.items, (k) => fontNames[k] || k, 10);
  const bodyFontSize = 10;
  const yTol = Math.max(1.5, bodyFontSize * 0.28);
  const rawRows = [];
  for (const g of decoded.glyphs) {
    let row = rawRows.find((r) => {
      const baseDiff = Math.abs(r.y - g.y);
      if (baseDiff <= yTol) return true;
      if (g.fontSize <= bodyFontSize * 0.85 && baseDiff <= bodyFontSize * 0.58) {
        const rMinX = Math.min(...r.glyphs.map((gl) => gl.x));
        const rMaxX = Math.max(...r.glyphs.map((gl) => gl.right));
        if (g.x >= rMinX - 8 && g.right <= rMaxX + 8) return true;
      }
      return false;
    });
    if (!row) {
      row = { y: g.y, glyphs: [] };
      rawRows.push(row);
    }
    row.glyphs.push(g);
  }

  const rowWith362 = rawRows.find(r => r.glyphs.some(g => g.index === 362));
  console.log('Row with 362 y:', rowWith362.y, 'count:', rowWith362.glyphs.length);
  console.log('Row with 362 text:', rowWith362.glyphs.map(g => g.text).join(' '));
}

trace362Row().catch(console.error);
