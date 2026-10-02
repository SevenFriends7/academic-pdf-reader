const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function inspectPage4All() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;
  const page = await doc.getPage(4);
  const textContent = await page.getTextContent();
  const items = textContent.items.filter(it => it.str.trim());

  items.filter(it => it.str.includes('Fig. 2') || it.transform[5] > 400).forEach(it => {
    console.log(`y=${Math.round(it.transform[5])}, x=${Math.round(it.transform[4])}, w=${Math.round(it.width)}, h=${Math.round(it.height)} | "${it.str}"`);
  });
}

inspectPage4All().catch(console.error);
