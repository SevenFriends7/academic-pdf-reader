const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const v2BundlePath = path.join(ROOT, 'scratch', '.build-v2', 'v2EngineBundle.cjs');
const v2 = require(v2BundlePath).AcademicV2;

async function run() {
  const pdfCandidates = [
    'D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf',
    'd:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf'
  ];
  let pdfPath = pdfCandidates.find(p => fs.existsSync(p));
  if (!pdfPath) {
    console.log('PDF not found');
    return;
  }
  console.log('Testing PDF:', pdfPath);
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  for (const pageNum of [3, 4]) {
    console.log(`\n=================== PAGE ${pageNum} ===================`);
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const opList = await page.getOperatorList();

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

    const graphics = v2.extractRawPageVectors(opList, pdfjsLib.OPS, viewport.width, viewport.height);
    const solved = v2.solveAcademicPageLayout({
      pageNum,
      items: textContent.items,
      spans: textContent.items.map(it => ({ textContent: it.str })),
      pageW: viewport.width,
      pageH: viewport.height,
      fontNames: fontNames,
      rawGraphics: graphics,
      splitBlockFormula: true
    });

    console.log(`Page ${pageNum} total paragraphs:`, solved.paras.length);
    solved.paras.forEach((p, i) => {
      const txt = p.cleanText || '';
      if (p.type === 'formula' || p.type === 'heading' || txt.includes('(2)') || txt.includes('(3)') || txt.includes('(4)') || txt.includes('(5)') || txt.includes('(6)') || txt.includes('0 h/2') || txt.includes('i ̸= j') || txt.includes('Gaussian overlap')) {
        console.log(`[P${pageNum} #${i} type=${p.type}]: ${txt}`);
        if (p.localLatex) console.log(`   localLatex: ${p.localLatex}`);
      }
    });
  }
}

run().catch(console.error);
