const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function testCaptionFilter() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;

  for (let pageNum = 1; pageNum <= 5; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(it => it.str.trim());

    // 统计不同高度的文本数量
    const heights = {};
    items.forEach(it => {
      const h = Math.round(it.height * 10) / 10;
      heights[h] = (heights[h] || 0) + 1;
    });

    console.log(`Page ${pageNum} text heights:`, heights);
  }
}

testCaptionFilter().catch(console.error);
