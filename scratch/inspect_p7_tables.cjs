const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function run() {
  const data = new Uint8Array(fs.readFileSync('D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf'));
  const doc = await pdfjs.getDocument({ data, cMapUrl: path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'cmaps/'), cMapPacked: true }).promise;
  const page = await doc.getPage(7);
  await page.getOperatorList();
  
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

  const solved = V2.solveAcademicPageLayout({
    pageNum: 7,
    items: textContent.items || [],
    spans: mockSpans,
    pageW: vp.width,
    pageH: vp.height,
    fontNames,
    rawGraphics,
    splitBlockFormula: true,
  });

  const paras = solved.paras || [];
  console.log(`Total paragraphs on Page 7: ${paras.length}`);
  paras.forEach((p, idx) => {
    console.log(`[P7 #${idx}] type=${p.type} text=${JSON.stringify(p.cleanText.slice(0, 75))}`);
  });
}
run().catch(console.error);
