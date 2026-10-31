const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function testEqEval() {
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
  const ops = await page.getOperatorList();
  const rawGraphics = V2.extractRawPageVectors(ops, pdfjs.OPS, vp.width, vp.height);
  const mockSpans = (textContent.items || []).map((it, idx) => ({
    textContent: it.str || '',
    _pdfIdx: idx,
    setAttribute() {},
  }));

  const decoded = V2.decodePageGlyphs(textContent.items, (k) => fontNames[k] || k, 10);
  
  // Let's inspect raw visual lines around eq 2 and eq 4
  // We can replicate evaluateDisplayFormulaLine for lines around y=60-75 and y=265-285
  const gEq4_l1 = decoded.glyphs.filter(g => Math.abs(g.y - 74.4) < 2 || Math.abs(g.y - 72.9) < 2 || Math.abs(g.y - 67.1) < 2);
  const gEq4_l2 = decoded.glyphs.filter(g => Math.abs(g.y - 60.4) < 2 || Math.abs(g.y - 59.0) < 2);
  
  const eval4_1 = V2.evaluateDisplayFormulaLine(gEq4_l1, [], 108, 504, 10);
  const eval4_2 = V2.evaluateDisplayFormulaLine(gEq4_l2, [], 108, 504, 10);
  console.log('Eq 4 Line 1 eval:', eval4_1);
  console.log('Eq 4 Line 2 eval:', eval4_2);

  const gEq2_l1 = decoded.glyphs.filter(g => Math.abs(g.y - 282.4) < 2 || Math.abs(g.y - 280.9) < 2 || Math.abs(g.y - 275.2) < 2);
  const gEq2_l2 = decoded.glyphs.filter(g => Math.abs(g.y - 268.5) < 2 || Math.abs(g.y - 267.0) < 2);

  const eval2_1 = V2.evaluateDisplayFormulaLine(gEq2_l1, [], 108, 504, 10);
  const eval2_2 = V2.evaluateDisplayFormulaLine(gEq2_l2, [], 108, 504, 10);
  console.log('Eq 2 Line 1 eval:', eval2_1);
  console.log('Eq 2 Line 2 eval:', eval2_2);
}

testEqEval().catch(console.error);
