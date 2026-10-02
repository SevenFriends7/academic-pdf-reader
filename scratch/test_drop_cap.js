const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function testDropCap() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;
  const page = await doc.getPage(1);
  const textContent = await page.getTextContent();

  const spans = textContent.items.map((it, idx) => {
    let sortY = it.transform[5];
    const h = it.height;
    const txt = it.str.trim();
    // 识别首字巨型下沉大写字母 (Drop Cap, 如 "A", h > 18)
    if (txt.length === 1 && h > 18 && it.width < 35) {
      sortY = it.transform[5] + h - 9; // 提拉到首行基线
      console.log(`Detected Drop Cap "${txt}": original Y=${Math.round(it.transform[5])} -> sortY=${Math.round(sortY)}`);
    }
    return {
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      sortY,
      w: it.width,
      h: it.height,
      idx
    };
  }).filter(s => s.text.trim());

  // 取 col1 位于 y < 400 && y > 330 的 spans
  const col1Spans = spans.filter(s => s.x < 288 && s.y < 400 && s.y > 330);
  
  col1Spans.sort((a, b) => {
    if (Math.abs(a.sortY - b.sortY) > 3.5) return b.sortY - a.sortY;
    return a.x - b.x;
  });

  const lines = [];
  let cur = null;
  col1Spans.forEach(s => {
    if (!cur || Math.abs(cur.sortY - s.sortY) > 3.5) {
      cur = { sortY: s.sortY, spans: [s] };
      lines.push(cur);
    } else {
      cur.spans.push(s);
    }
  });

  console.log('Resulting lines:');
  lines.forEach((l, i) => {
    console.log(`Line ${i}: ${l.spans.map(s => s.text).join(' ')}`);
  });
}

testDropCap().catch(console.error);
