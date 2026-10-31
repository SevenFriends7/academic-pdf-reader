const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function run() {
  const data = new Uint8Array(fs.readFileSync('D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf'));
  const doc = await pdfjs.getDocument({ data, cMapUrl: path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'cmaps/'), cMapPacked: true }).promise;
  const page = await doc.getPage(5);
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
  console.log('Resolved fontNames:', fontNames);

  const vp = page.getViewport({ scale: 1.0 });
  const ops = await page.getOperatorList();
  const rawGraphics = V2.extractRawPageVectors(ops, pdfjs.OPS, vp.width, vp.height);
  const mockSpans = (textContent.items || []).map((it, idx) => ({
    textContent: it.str || '',
    _pdfIdx: idx,
    setAttribute() {},
  }));

  const solved = V2.solveAcademicPageLayout({
    pageNum: 5,
    items: textContent.items || [],
    spans: mockSpans,
    pageW: vp.width,
    pageH: vp.height,
    fontNames,
    rawGraphics,
    splitBlockFormula: true,
  });

  const paras = solved.paras || [];
  paras.forEach((p, idx) => {
    if (p.cleanText.includes('18') || p.cleanText.includes('aug') || p.cleanText.includes('19')) {
      console.log(`[P5 #${idx}] type=${p.type} tag=${p.equationTag || ''}`);
      console.log(`   cleanText: ${JSON.stringify(p.cleanText)}`);
      if (p.latex) console.log(`   latex: ${p.latex}`);
      if (p.visionLatex) console.log(`   visionLatex: ${p.visionLatex}`);
    }
  });
}
run().catch(console.error);
