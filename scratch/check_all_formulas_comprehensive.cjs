const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const katex = require(path.join(__dirname, '..', 'media', 'katex', 'katex.min.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function checkPaper(pdfPath) {
  const baseName = path.basename(pdfPath);
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  
  const results = [];
  
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    let opList = null;
    try { opList = await page.getOperatorList(); } catch (e) {}
    const textContent = await page.getTextContent();
    const fontNames = {};
    for (const it of textContent.items || []) {
      if (it && it.fontName && !fontNames[it.fontName]) {
        try {
          const obj = page.commonObjs && page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null;
          if (obj && obj.name) fontNames[it.fontName] = String(obj.name);
        } catch (e) {}
      }
    }
    const vp = page.getViewport({ scale: 1.0 });
    const pageW = vp.viewBox ? vp.viewBox[2] : vp.width;
    const pageH = vp.viewBox ? vp.viewBox[3] : vp.height;
    
    let rawGraphics = { hLines: [], vLines: [], rects: [] };
    if (opList) {
      try {
        rawGraphics = V2.extractRawPageVectors(opList, pdfjs.OPS, pageW, pageH);
      } catch (e) {}
    }
    
    const mockSpans = (textContent.items || []).map((it, idx) => ({
      textContent: it.str || '',
      _pdfIdx: idx,
      setAttribute() {},
    }));

    const solved = V2.solveAcademicPageLayout({
      pageNum: p,
      items: textContent.items || [],
      spans: mockSpans,
      pageW,
      pageH,
      fontNames,
      rawGraphics,
      splitBlockFormula: true,
    });

    (solved.paras || []).forEach((para, idx) => {
      if (para.type === 'formula') {
        const tex = para.latex || para.visionLatex || '';
        let katexOk = false;
        let katexErr = '';
        if (tex) {
          try {
            katex.renderToString(tex, { throwOnError: true, displayMode: true });
            katexOk = true;
          } catch (e) {
            katexErr = e ? e.message : 'error';
          }
        }
        results.push({
          page: p,
          idx,
          tag: para.equationTag || '',
          cleanText: para.cleanText,
          latex: tex,
          katexOk,
          katexErr
        });
      }
    });
  }
  
  return { baseName, pages: doc.numPages, formulas: results };
}

async function run() {
  const sjtuDir = 'D:\\kx\\上海交大\\基于变分推断的点监督目标检测迭代伪标签优化\\文献及要求';
  const candidateFiles = [];
  if (fs.existsSync(sjtuDir)) {
    for (const f of fs.readdirSync(sjtuDir)) {
      if (f.toLowerCase().endsWith('.pdf')) candidateFiles.push(path.join(sjtuDir, f));
    }
  }
  const localTestDir = path.join(__dirname, '..', 'test-papers');
  if (fs.existsSync(localTestDir)) {
    for (const f of fs.readdirSync(localTestDir)) {
      if (f.toLowerCase().endsWith('.pdf')) candidateFiles.push(path.join(localTestDir, f));
    }
  }
  const parentResnet = path.join(__dirname, '..', '..', 'test_resnet.pdf');
  if (fs.existsSync(parentResnet)) candidateFiles.push(parentResnet);

  console.log(`=== Scanning ${candidateFiles.length} benchmark academic papers for all formulas ===\n`);
  
  let totalFormulas = 0;
  let katexPassCount = 0;
  const katexErrors = [];

  for (const pdfPath of candidateFiles) {
    const res = await checkPaper(pdfPath);
    totalFormulas += res.formulas.length;
    let paperPass = 0;
    res.formulas.forEach(f => {
      if (f.katexOk) {
        katexPassCount++;
        paperPass++;
      } else {
        katexErrors.push({ paper: res.baseName, ...f });
      }
    });
    console.log(`📄 [${res.baseName}] (${res.pages} pages): ${res.formulas.length} formulas extracted, ${paperPass}/${res.formulas.length} KaTeX valid`);
  }

  console.log('\n======================================================================');
  console.log(` Total Formulas: ${totalFormulas}`);
  console.log(` KaTeX Valid: ${katexPassCount} / ${totalFormulas} (${((katexPassCount / totalFormulas) * 100).toFixed(1)}%)`);
  if (katexErrors.length > 0) {
    console.log(` KaTeX Errors: ${katexErrors.length}`);
    katexErrors.slice(0, 10).forEach(e => {
      console.log(`   ❌ [${e.paper} p${e.page}] tag=${e.tag} err=${e.katexErr} latex=${JSON.stringify(e.latex)}`);
    });
  } else {
    console.log(' 🎉 All formulas compile successfully in KaTeX!');
  }
  console.log('======================================================================');
}

run().catch(console.error);
