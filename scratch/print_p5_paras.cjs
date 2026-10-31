const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function printVisualLines() {
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
  const res = V2.solveAcademicPageLayout({
    pageNum: 5,
    items: textContent.items || [],
    spans: mockSpans,
    pageW: vp.width,
    pageH: vp.height,
    fontNames,
    rawGraphics,
    splitBlockFormula: true,
  });

  const katex = require('katex');
  for (let i = 0; i < res.paras.length; i++) {
    const p = res.paras[i];
    console.log(`\n======================================================`);
    console.log(`[P${i}] type=${p.type} isMath=${p.type === 'formula'}`);
    console.log(`Text: ${p.cleanText}`);
    if (p.type === 'formula') {
      const tex = p.visionLatex || (p.segments && p.segments[0] && p.segments[0].latex) || '';
      console.log(`LaTeX: ${tex}`);
      try {
        const html = katex.renderToString(tex, { displayMode: true, throwOnError: true });
        console.log(`✅ KaTeX render success! (HTML length: ${html.length})`);
      } catch (err) {
        console.error(`❌ KaTeX render failed:`, err.message);
      }
    }
  }
}

printVisualLines().catch(console.error);
