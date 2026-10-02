const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function testWidths() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;

  for (let p = 1; p <= 5; p++) {
    const page = await doc.getPage(p);
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(it => it.str.trim());
    
    // 找出只属于单栏普通正文的典型 span (宽度在 100 到 270 之间)
    const normalSpans = items.filter(it => it.width > 80 && it.width < 270);
    const leftStarts = normalSpans.filter(it => it.transform[4] < 200).map(it => it.transform[4]);
    const rightStarts = normalSpans.filter(it => it.transform[4] > 260).map(it => it.transform[4]);

    console.log(`\nPage ${p}:`);
    console.log(`  Left starts: min=${Math.min(...leftStarts).toFixed(1)}, max=${Math.max(...leftStarts).toFixed(1)}, count=${leftStarts.length}`);
    if (rightStarts.length > 0) {
      console.log(`  Right starts: min=${Math.min(...rightStarts).toFixed(1)}, max=${Math.max(...rightStarts).toFixed(1)}, count=${rightStarts.length}`);
    } else {
      console.log(`  No right column normal spans.`);
    }
  }
}

testWidths().catch(console.error);
