const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function testRobustFlow() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;

  for (let pageNum = 1; pageNum <= 5; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });

    const rawSpans = textContent.items.map((it, idx) => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height,
      idx
    })).filter(s => s.text.trim());

    // 过滤页眉页脚（如 PNAS 2021..., 页码, doi 等）
    const spans = rawSpans.filter(s => {
      if (s.y < 35 || s.y > 755) return false;
      const t = s.text.trim();
      if (t.startsWith('PNAS 2021') || t.startsWith('https://doi.org') || t === 'NEUROSCIENCE' || /^\d+ of \d+$/.test(t)) {
        return false;
      }
      return true;
    });

    const midX = viewport.width / 2; // ~306
    const gutterX = 288; // 稳定的双栏分界线

    // 辅助行构建器 (同一集合内按 Y 降序、X 升序排成行)
    function spansToLines(spanList) {
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

    // 首先检测是否存在通栏元素（通栏标题、通栏图注等，宽度超过 300 且跨越中线）
    // 通栏判断：宽度 > 280，或者左边界 < 150 且右边界 > 450
    const topHeaders = [];
    const fullWidthCaptions = [];
    const footers = [];
    const col1Spans = [];
    const col2Spans = [];

    spans.forEach(s => {
      if (pageNum === 1 && s.y >= 600) {
        topHeaders.push(s);
      } else if (s.h <= 6.5 && s.y < 160) {
        footers.push(s);
      } else if ((s.w > 280 && s.x < 150) || (s.x < 120 && s.x + s.w > 450)) {
        fullWidthCaptions.push(s);
      } else if (s.x < gutterX) {
        col1Spans.push(s);
      } else {
        col2Spans.push(s);
      }
    });

    const headerLines = spansToLines(topHeaders);
    const col1Lines = spansToLines(col1Spans);
    const col2Lines = spansToLines(col2Spans);
    const captionLines = spansToLines(fullWidthCaptions);
    const footerLines = spansToLines(footers);

    // 对于通栏图注（如 Page 4 的 Fig 2 在中间，Page 2 的 Fig 1 在底部）：
    // 根据其 Y 坐标决定相对栏目的顺序
    let orderedLines = [];
    if (captionLines.length > 0) {
      const captionY = captionLines[0].y;
      const colTopY = Math.max(
        col1Lines.length > 0 ? col1Lines[0].y : 0,
        col2Lines.length > 0 ? col2Lines[0].y : 0
      );
      if (captionY > colTopY) {
        // 图注在双栏正文上方
        orderedLines = [...headerLines, ...captionLines, ...col1Lines, ...col2Lines, ...footerLines];
      } else {
        // 图注在双栏正文下方
        orderedLines = [...headerLines, ...col1Lines, ...col2Lines, ...captionLines, ...footerLines];
      }
    } else {
      orderedLines = [...headerLines, ...col1Lines, ...col2Lines, ...footerLines];
    }

    console.log(`\n================ Page ${pageNum} ================`);
    console.log(`Col1 lines: ${col1Lines.length}, Col2 lines: ${col2Lines.length}, Captions: ${captionLines.length}`);
    console.log(`First 2 lines:`);
    orderedLines.slice(0, 2).forEach(l => console.log('  ' + l.spans.map(s => s.text).join(' ')));
    console.log(`Lines 10..12 of Col1:`);
    col1Lines.slice(10, 13).forEach(l => console.log('  [Col1] ' + l.spans.map(s => s.text).join(' ')));
    console.log(`Lines 0..2 of Col2:`);
    col2Lines.slice(0, 3).forEach(l => console.log('  [Col2] ' + l.spans.map(s => s.text).join(' ')));
  }
}

testRobustFlow().catch(console.error);
