const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function checkSeveredFormulas() {
  const candidateFiles = [];
  const sjtuDir = 'D:\\kx\\上海交大\\基于变分推断的点监督目标检测迭代伪标签优化\\文献及要求';
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

  let severedFound = 0;
  for (const pdfPath of candidateFiles) {
    const baseName = path.basename(pdfPath);
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

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

      const paras = solved.paras || [];
      for (let i = 1; i < paras.length; i++) {
        const prev = paras[i - 1];
        const cur = paras[i];
        if (prev.type === 'formula' && cur.type === 'body') {
          const t = cur.cleanText.trim();
          if (/^[∧∨⇒⇐⇔=+\-−×·≈≤≥∼≡→]/.test(t) || /\b(?:is\s+(?:positive|negative))\b/.test(t)) {
            console.log(`⚠️ Potential severed equation in [${baseName} p${p}] after formula #${prev.id}: "${t.slice(0, 80)}"`);
            severedFound++;
          }
        }
      }
    }
  }

  console.log(`\nScan complete: ${severedFound} severed equations found.`);
}

checkSeveredFormulas().catch(console.error);
