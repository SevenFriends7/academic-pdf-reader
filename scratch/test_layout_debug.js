const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function debugLayout() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;
  const page = await doc.getPage(1);
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.25 });

  console.log('Items count:', textContent.items.length);
  
  // 模拟 viewer.js 的 spans
  const spans = textContent.items.map((it, idx) => {
    return {
      textContent: it.str,
      _pdfX: it.transform[4],
      _pdfY: it.transform[5],
      _pdfW: it.width,
      _pdfH: it.height,
      _pdfIdx: idx
    };
  }).filter(s => s.textContent.trim());

  console.log('Filtered spans:', spans.length);

  // 复制 viewer.js 的逻辑
  const sortedSpans = [...spans].sort((a, b) => {
    const ya = a._pdfY !== undefined ? a._pdfY : 0;
    const yb = b._pdfY !== undefined ? b._pdfY : 0;
    if (Math.abs(ya - yb) > 3.5) return yb - ya;
    const xa = a._pdfX !== undefined ? a._pdfX : 0;
    const xb = b._pdfX !== undefined ? b._pdfX : 0;
    return xa - xb;
  });

  const lines = [];
  let curLine = null;
  for (const span of sortedSpans) {
    const sy = span._pdfY;
    const sx = span._pdfX;
    const sh = span._pdfH;
    const sw = span._pdfW;

    if (!curLine || Math.abs(curLine.y - sy) > 3.5) {
      curLine = { y: sy, h: sh, minX: sx, maxX: sx + sw, spans: [span] };
      lines.push(curLine);
    } else {
      curLine.spans.push(span);
      curLine.minX = Math.min(curLine.minX, sx);
      curLine.maxX = Math.max(curLine.maxX, sx + sw);
      curLine.h = Math.max(curLine.h, sh);
    }
  }

  console.log('Lines count:', lines.length);

  lines.forEach((l, i) => {
    const txt = l.spans.map(s => s.textContent).join(' ');
    console.log(`L${i.toString().padStart(2)} [y=${Math.round(l.y)}, minX=${Math.round(l.minX)}, maxX=${Math.round(l.maxX)}, spans=${l.spans.length}]: ${txt.slice(0, 80)}`);
  });
}

debugLayout().catch(console.error);
