/** 逐篇逐页打印版面判定（用于验证泛化性） */
const fs = require('fs');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(__dirname, '..', 'test-papers'); // 论文 PDF 目录（可用 PAPERS_DIR 覆盖）
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const a = code.indexOf('const detectColumnStructure = (spanList, pageW) => {');
const b = code.indexOf('const colStruct = detectColumnStructure(spans, pagePdfW);');
const det = new Function(`${code.slice(a, b)}\n return detectColumnStructure;`)();

const dir = PAPERS_DIR;

(async () => {
  for (const f of fs.readdirSync(dir).filter(x => x.toLowerCase().endsWith('.pdf'))) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(dir, f))), useSystemFonts: false })
      .promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const pg = await doc.getPage(p);
      const vp = pg.getViewport({ scale: 1.0 });
      const tc = await pg.getTextContent();
      const spans = tc.items
        .filter(i => i.str && i.str.trim())
        .map(i => ({ textContent: i.str, _pdfX: i.transform[4], _pdfY: i.transform[5], _pdfH: i.height, _pdfW: i.width }));
      if (spans.length < 5) continue;
      const r = det(spans, vp.width);
      out.push(`${p}:${r.twoColumn ? '双' + r.gutterX.toFixed(0) : '单'}`);
    }
    console.log(`${f.padEnd(14)} ${out.join('  ')}`);
  }
})();
