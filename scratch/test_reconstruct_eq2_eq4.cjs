const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function testReconstruct() {
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
  
  // Combine all glyphs from y=58 to y=85 (Eq 4 both lines + tag)
  const gEq4 = decoded.glyphs.filter(g => g.y >= 58 && g.y <= 85);
  console.log('Total Eq 4 glyphs:', gEq4.length);
  const res4 = V2.reconstructMath2D(gEq4, [], 10);
  console.log('Eq 4 Reconstructed LaTeX:');
  console.log(res4.latex);
  console.log('Tag:', res4.equationTag);

  // Combine all glyphs from y=265 to y=285 (Eq 2 both lines + tag)
  const gEq2 = decoded.glyphs.filter(g => g.y >= 265 && g.y <= 285);
  console.log('\nTotal Eq 2 glyphs:', gEq2.length);
  const res2 = V2.reconstructMath2D(gEq2, [], 10);
  console.log('Eq 2 Reconstructed LaTeX:');
  console.log(res2.latex);
  console.log('Tag:', res2.equationTag);
}

testReconstruct().catch(console.error);
