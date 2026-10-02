const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function testParas() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;
  const page = await doc.getPage(1);
  const textContent = await page.getTextContent();

  const spans = textContent.items.map((it, idx) => ({
    text: it.str,
    x: it.transform[4],
    y: it.transform[5],
    w: it.width,
    h: it.height,
    idx
  })).filter(s => s.text.trim());

  // 过滤页眉页脚
  const contentSpans = spans.filter(s => {
    if (s.y < 45) return false;
    if (s.text.includes('PNAS 2021') || s.text.includes('doi.org/10.1073')) return false;
    return true;
  });

  // 检测双栏
  const xs = contentSpans.filter(s => s.y < 600).map(s => s.x);
  const leftXs = xs.filter(x => x < 200);
  const rightXs = xs.filter(x => x > 250);
  const isTwoCol = leftXs.length > 10 && rightXs.length > 10;

  let gutterX = 290;
  if (isTwoCol) {
    const maxLeftX = Math.max(...contentSpans.filter(s => s.y < 600 && s.x < 260).map(s => s.x + s.w));
    const minRightX = Math.min(...contentSpans.filter(s => s.y < 600 && s.x > 260).map(s => s.x));
    gutterX = (maxLeftX + minRightX) / 2;
  }

  const headerSpans = [];
  const col1Spans = [];
  const col2Spans = [];

  contentSpans.forEach(s => {
    if (s.y >= 600) {
      headerSpans.push(s);
    } else if (isTwoCol) {
      if (s.x < gutterX) {
        col1Spans.push(s);
      } else {
        col2Spans.push(s);
      }
    } else {
      col1Spans.push(s);
    }
  });

  function buildLines(spanList) {
    const sorted = [...spanList].sort((a, b) => {
      if (Math.abs(a.y - b.y) > 3.5) return b.y - a.y;
      return a.x - b.x;
    });

    const lines = [];
    let curLine = null;
    for (const span of sorted) {
      if (!curLine || Math.abs(curLine.y - span.y) > 3.5) {
        curLine = { y: span.y, h: span.h, minX: span.x, maxX: span.x + span.w, spans: [span] };
        lines.push(curLine);
      } else {
        curLine.spans.push(span);
        curLine.minX = Math.min(curLine.minX, span.x);
        curLine.maxX = Math.max(curLine.maxX, span.x + span.w);
        curLine.h = Math.max(curLine.h, span.h);
      }
    }
    return lines;
  }

  const col1Lines = buildLines(col1Spans);
  const col2Lines = buildLines(col2Spans);

  // 检查 col1 的所有行
  console.log('=== Col 1 All Lines ===');
  col1Lines.forEach((l, idx) => {
    console.log(`L${idx.toString().padStart(2)} [y=${Math.round(l.y)}, minX=${Math.round(l.minX)}, h=${Math.round(l.h)}]: ${l.spans.map(s => s.text).join(' ')}`);
  });

  console.log('\n=== Col 2 All Lines ===');
  col2Lines.forEach((l, idx) => {
    console.log(`L${idx.toString().padStart(2)} [y=${Math.round(l.y)}, minX=${Math.round(l.minX)}, h=${Math.round(l.h)}]: ${l.spans.map(s => s.text).join(' ')}`);
  });
}

testParas().catch(console.error);
