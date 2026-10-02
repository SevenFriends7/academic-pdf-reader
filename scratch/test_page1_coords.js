const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function checkPage1() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;
  const page = await doc.getPage(1);
  const textContent = await page.getTextContent();
  
  console.log('Total items on page 1:', textContent.items.length);
  const items = textContent.items.map((it, idx) => ({
    idx,
    str: it.str,
    x: Math.round(it.transform[4]),
    y: Math.round(it.transform[5]),
    w: Math.round(it.width),
    h: Math.round(it.height)
  })).filter(it => it.str.trim());

  items.sort((a, b) => b.y - a.y || a.x - b.x);
  
  items.slice(0, 40).forEach(it => {
    console.log(`y=${it.y}, x=${it.x}, w=${it.w}, h=${it.h} | "${it.str}"`);
  });

  console.log('\n--- Checking column distribution ---');
  const xs = items.map(it => it.x);
  console.log('Min x:', Math.min(...xs), 'Max x:', Math.max(...xs));
  const leftCol = items.filter(it => it.x < 250);
  const rightCol = items.filter(it => it.x >= 250);
  console.log('Items with x < 250:', leftCol.length, 'Items with x >= 250:', rightCol.length);
}

checkPage1().catch(console.error);
