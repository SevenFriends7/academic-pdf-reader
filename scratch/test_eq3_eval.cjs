const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function testEq3() {
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

  const vp = page.getViewport({ scale: 1.0 });
  const decoded = V2.decodePageGlyphs(textContent.items, (k) => fontNames[k] || k, 10);
  const gEq3 = decoded.glyphs.filter(g => Math.abs(g.y - 170.3) < 2 || Math.abs(g.y - 168.8) < 2);
  const ev = V2.evaluateDisplayFormulaLine(gEq3, [], 108, 504, 10);
  console.log('Eq 3 eval:', ev);
}

testEq3().catch(console.error);
