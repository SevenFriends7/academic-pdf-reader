const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const v2BundlePath = path.join(ROOT, 'scratch', '.build-v2', 'v2EngineBundle.cjs');
const v2 = require(v2BundlePath).AcademicV2;

async function run() {
  const pdfPath = 'D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const page = await doc.getPage(4);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const opList = await page.getOperatorList();
  const graphics = v2.extractRawPageVectors(opList, pdfjsLib.OPS, viewport.width, viewport.height);

  // Let's hook or inspect the internal lines or run a diagnostic
  // We can write a diagnostic that prints the decoded glyphs and visual lines
  const solved = v2.solveAcademicPageLayout({
    pageNum: 4,
    items: textContent.items,
    spans: textContent.items.map(it => ({ textContent: it.str })),
    pageW: viewport.width,
    pageH: viewport.height,
    rawGraphics: graphics,
    splitBlockFormula: true
  });

  console.log('Paragraphs around 20-26:');
  solved.paras.forEach((p, idx) => {
    if (idx >= 20 && idx <= 26) {
      console.log(`\n--- Para #${idx} (type=${p.type}) ---`);
      console.log('cleanText:', p.cleanText);
    }
  });
}

run().catch(console.error);
