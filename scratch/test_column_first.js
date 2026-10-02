const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function testColumnFirst() {
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

  console.log(`Page 1: ${spans.length} spans.`);

  // 1. 过滤页眉页脚（如 PNAS 2021..., doi..., 页码等）
  const contentSpans = spans.filter(s => {
    if (s.y < 45) return false; // 页脚
    if (s.text.includes('PNAS 2021') || s.text.includes('doi.org/10.1073')) return false;
    return true;
  });

  // 2. 检测页面是否双栏排版及栏目分界线 (Gutter)
  // 统计所有文本在 X 轴上的分布
  const xs = contentSpans.filter(s => s.y < 600).map(s => s.x);
  const leftXs = xs.filter(x => x < 200);
  const rightXs = xs.filter(x => x > 250);
  const isTwoCol = leftXs.length > 10 && rightXs.length > 10;
  console.log('Is two column:', isTwoCol);

  // 找到两栏分界点 gutterX
  let gutterX = 290;
  if (isTwoCol) {
    const maxLeftX = Math.max(...contentSpans.filter(s => s.y < 600 && s.x < 260).map(s => s.x + s.w));
    const minRightX = Math.min(...contentSpans.filter(s => s.y < 600 && s.x > 260).map(s => s.x));
    gutterX = (maxLeftX + minRightX) / 2;
    console.log(`Detected maxLeftX: ${Math.round(maxLeftX)}, minRightX: ${Math.round(minRightX)} => gutterX: ${Math.round(gutterX)}`);
  }

  // 3. 将 Spans 分流：
  // - Top Header (如第一页标题、作者、机构、收稿信息，y >= 600)
  // - Column 1 (x < gutterX)
  // - Column 2 (x >= gutterX)
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

  console.log(`Header spans: ${headerSpans.length}, Col1: ${col1Spans.length}, Col2: ${col2Spans.length}`);

  // 在每个栏目内部，按 Y（自上而下，即 Y 递减）和 X（自左向右）排成行
  function buildLines(spanList) {
    const sorted = [...spanList].sort((a, b) => {
      if (Math.abs(a.y - b.y) > 3.5) return b.y - a.y; // 上到下
      return a.x - b.x; // 左到右
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

  const headerLines = buildLines(headerSpans);
  const col1Lines = buildLines(col1Spans);
  const col2Lines = buildLines(col2Spans);

  console.log(`\n=== Header Lines (${headerLines.length}) ===`);
  headerLines.forEach(l => console.log('  ' + l.spans.map(s => s.text).join(' ')));

  console.log(`\n=== Col 1 Lines (${col1Lines.length}) ===`);
  col1Lines.slice(0, 10).forEach(l => console.log('  ' + l.spans.map(s => s.text).join(' ')));

  console.log(`\n=== Col 2 Lines (${col2Lines.length}) ===`);
  col2Lines.slice(0, 10).forEach(l => console.log('  ' + l.spans.map(s => s.text).join(' ')));
}

testColumnFirst().catch(console.error);
