const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function inspectPage2() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;
  const page = await doc.getPage(2);
  const textContent = await page.getTextContent();
  console.log('Page 2 total items:', textContent.items.length);
  const items = textContent.items.filter(it => it.str.trim());
  console.log('Page 2 non-empty items:', items.length);

  items.forEach((it, i) => {
    console.log(`item ${i}: y=${Math.round(it.transform[5])}, x=${Math.round(it.transform[4])}, w=${Math.round(it.width)}, h=${Math.round(it.height)} | "${it.str.slice(0, 60)}"`);
  });
}

inspectPage2().catch(console.error);
