const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const { AcademicV2 } = require(path.join(ROOT, 'scratch', '.build-v2', 'v2EngineBundle.cjs'));
const { reconstructMath2D } = require(path.join(ROOT, 'scratch', '.build-v2', 'v2EngineBundle.cjs'));

async function testEq4Clean() {
  const pdfPath = 'D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const page = await doc.getPage(4);
  const textContent = await page.getTextContent();
  const opList = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1 });

  const fontNames = {};
  if (page.commonObjs) {
    for (const item of textContent.items) {
      if (item.fontName && !fontNames[item.fontName]) {
        try {
          if (page.commonObjs.has(item.fontName)) {
            const fontObj = page.commonObjs.get(item.fontName);
            if (fontObj && (fontObj.name || fontObj.loadedName)) {
              fontNames[item.fontName] = fontObj.name || fontObj.loadedName;
            }
          }
        } catch (e) {}
      }
    }
  }

  const { glyphs } = AcademicV2.decodePageGlyphs(textContent.items, (k) => fontNames[k] || '', 10);
  const vectors = AcademicV2.extractRawPageVectors(opList, pdfjsLib.OPS, viewport.width, viewport.height);

  // Exact glyphs of Equation (4) ONLY: y >= 246 && y <= 272, x < 300
  const eq4Glyphs = glyphs.filter(g => g.y >= 246 && g.y <= 272 && g.x < 300);
  const eq4Bars = vectors.hLines.filter(b => b.y >= 246 && b.y <= 272 && b.x1 < 300);

  console.log(`Equation (4) glyphs count: ${eq4Glyphs.length}, bars count: ${eq4Bars.length}`);
  const result = AcademicV2.reconstructMath2D(eq4Glyphs, eq4Bars, 10);
  console.log('Resulting LaTeX:');
  console.log(result.latex);
  if (result.equationTag) console.log('Tag:', result.equationTag);
}

testEq4Clean().catch(console.error);
