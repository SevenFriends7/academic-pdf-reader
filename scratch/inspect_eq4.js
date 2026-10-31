const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const { AcademicV2 } = require(path.join(ROOT, 'scratch', '.build-v2', 'v2EngineBundle.cjs'));

async function inspectEq4() {
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

  const vectors = AcademicV2.extractRawPageVectors(opList, pdfjsLib.OPS, viewport.width, viewport.height);
  const solved = AcademicV2.solveAcademicPageLayout({
    pageNum: 4,
    items: textContent.items,
    spans: textContent.items.map(it => ({ textContent: it.str })),
    pageW: viewport.width,
    pageH: viewport.height,
    fontNames,
    rawGraphics: vectors,
    splitBlockFormula: true
  });

  console.log('All glyphs on Page 4 between y=225 and y=275, left column (x < 300):');
  const eq4Glyphs = solved.glyphs.filter(g => g.y >= 225 && g.y <= 275 && g.x < 300);
  eq4Glyphs.sort((a, b) => b.y - a.y || a.x - b.x);
  eq4Glyphs.forEach(g => {
    console.log(`x=${g.x.toFixed(1).padStart(5)}, y=${g.y.toFixed(1).padStart(5)}, w=${g.w.toFixed(1).padStart(4)}, h=${g.h.toFixed(1).padStart(4)}, fontSize=${g.fontSize.toFixed(1).padStart(4)}, role=${g.fontRole.padEnd(11)}, isTall=${g.isTallDelim}, text="${g.text}", latex="${g.latex}"`);
  });

  console.log('\nMath bars between y=225 and y=275, x < 300:');
  vectors.hLines.filter(b => b.y >= 225 && b.y <= 275 && b.x1 < 300).forEach(b => {
    console.log(`bar: y=${b.y.toFixed(2)}, x1=${b.x1.toFixed(2)}, x2=${b.x2.toFixed(2)}, w=${(b.x2 - b.x1).toFixed(2)}`);
  });
}

inspectEq4().catch(console.error);
