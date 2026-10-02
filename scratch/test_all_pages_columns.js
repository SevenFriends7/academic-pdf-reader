const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function testAllPages() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;

  for (let pageNum = 1; pageNum <= Math.min(5, doc.numPages); pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const spans = textContent.items.map((it, idx) => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height,
      idx
    })).filter(s => s.text.trim());

    // 过滤页脚页眉 (y < 45, y > 750)
    const contentSpans = spans.filter(s => s.y >= 45 && s.y <= 750 && !s.text.includes('PNAS 2021'));

    // 检测多栏
    const xs = contentSpans.map(s => s.x);
    const leftXs = xs.filter(x => x < 200);
    const rightXs = xs.filter(x => x > 280);
    const isTwoCol = leftXs.length > 5 && rightXs.length > 5;

    let gutterX = 290;
    if (isTwoCol) {
      const maxLeftX = Math.max(...contentSpans.filter(s => s.x < 260).map(s => s.x + s.w));
      const minRightX = Math.min(...contentSpans.filter(s => s.x > 260).map(s => s.x));
      gutterX = (maxLeftX + minRightX) / 2;
    }

    console.log(`\n================ Page ${pageNum} (TwoCol: ${isTwoCol}, gutter: ${Math.round(gutterX)}) ================`);

    const col1 = [];
    const col2 = [];
    contentSpans.forEach(s => {
      if (pageNum === 1 && s.y >= 600) {
        // Page 1 title & authors
        col1.push(s);
      } else if (isTwoCol) {
        if (s.x < gutterX) col1.push(s);
        else col2.push(s);
      } else {
        col1.push(s);
      }
    });

    console.log(`Page ${pageNum}: Col 1 spans: ${col1.length}, Col 2 spans: ${col2.length}`);
    if (col1.length > 0) {
      console.log(`  Col 1 first span: "${col1[0].text}"`);
      console.log(`  Col 1 last span:  "${col1[col1.length - 1].text}"`);
    }
    if (col2.length > 0) {
      console.log(`  Col 2 first span: "${col2[0].text}"`);
      console.log(`  Col 2 last span:  "${col2[col2.length - 1].text}"`);
    }
  }
}

testAllPages().catch(console.error);
