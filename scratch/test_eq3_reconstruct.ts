import * as fs from 'fs';
import * as path from 'path';
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

import { extractRawPageVectors } from '../src/core/layout/vectorGraphics';
import { solveAcademicPageLayout } from '../src/core/layout/academicLayoutEngine';

async function main() {
  const pdfPath = 'D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const page = await doc.getPage(3);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const opList = await page.getOperatorList();
  const rawGraphics = extractRawPageVectors(opList, pdfjsLib.OPS, viewport.width, viewport.height);

  const solved = solveAcademicPageLayout({
    pageNum: 3,
    items: textContent.items,
    spans: textContent.items.map((it: any) => ({ textContent: it.str })),
    pageW: viewport.width,
    pageH: viewport.height,
    rawGraphics,
    splitBlockFormula: true
  });

  // Let's check solved.glyphs
  console.log('Searching for glyph [ in solved.glyphs:');
  const bracketGlyphs = solved.glyphs.filter(g => g.text === '[' || g.text === ']');
  bracketGlyphs.forEach(g => {
    console.log(`bracket glyph: text="${g.text}", x=${g.x.toFixed(1)}, y=${g.y.toFixed(1)}, isDelimExt=${g.isDelimiterExt}, fontRole=${g.fontRole}`);
  });
}

main().catch(console.error);
