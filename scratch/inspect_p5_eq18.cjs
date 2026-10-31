const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const V2 = require(path.join(__dirname, '.build-v2', 'v2EngineBundle.cjs')).AcademicV2;

async function run() {
  const data = new Uint8Array(fs.readFileSync('D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf'));
  const doc = await pdfjs.getDocument({ data, cMapUrl: path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'cmaps/'), cMapPacked: true }).promise;
  const page = await doc.getPage(5);
  await page.getOperatorList();
  
  const textContent = await page.getTextContent();
  const fontNames = {};
  for (const it of textContent.items || []) {
    if (it && it.fontName && !fontNames[it.fontName]) {
      try {
        const obj = page.commonObjs.get(it.fontName);
        if (obj && obj.name) fontNames[it.fontName] = String(obj.name);
      } catch (e) {}
    }
  }

  const decoded = V2.decodePageGlyphs(textContent.items, (k) => fontNames[k] || k, 10);
  const g18 = decoded.glyphs.find(g => g.text === '(18)' || g.text.includes('(18)'));
  const y18 = g18.y;
  
  const eq18Glyphs = decoded.glyphs.filter(g => g.x >= 370 && g.x <= 560 && Math.abs(g.y - y18) < 22);
  const coreGlyphs = eq18Glyphs.filter(g => !g.isDelimiterExt && g.text.trim().length > 0 && g.text !== '(18)');
  
  const leftBrace = coreGlyphs.find(g => g.text.trim() === '{');
  const rhs = coreGlyphs.filter((g) => g !== leftBrace && g.x >= leftBrace.x + 1);
  const bodyFontSize = 10;
  
  // Custom split function:
  const sorted = rhs.slice().sort((a, b) => b.y - a.y);
  const rows = [];
  for (const g of sorted) {
    if (rows.length === 0) {
      rows.push({ minY: g.y, maxY: g.y, glyphs: [g] });
      continue;
    }
    const cur = rows[rows.length - 1];
    const gap = cur.minY - g.y;
    const overlapsX = cur.glyphs.some(cg => Math.abs(cg.x - g.x) < 4);
    const isNewMainRow = (gap >= bodyFontSize * 0.65 && g.fontSize >= bodyFontSize * 0.88) || (gap >= bodyFontSize * 0.35 && overlapsX);
    
    if (!isNewMainRow && gap <= bodyFontSize * 1.15) {
      cur.glyphs.push(g);
      cur.minY = Math.min(cur.minY, g.y);
      cur.maxY = Math.max(cur.maxY, g.y);
    } else {
      rows.push({ minY: g.y, maxY: g.y, glyphs: [g] });
    }
  }
  
  console.log(`Custom split rows count: ${rows.length}`);
  rows.forEach((r, i) => {
    r.glyphs.sort((a,b) => a.x - b.x);
    const tex = V2.reconstructMath2D(r.glyphs, [], 10, 1).latex;
    console.log(`Row ${i}: ${tex}`);
  });
}
run().catch(console.error);
