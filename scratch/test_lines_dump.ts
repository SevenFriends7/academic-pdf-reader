import * as fs from 'fs';
import * as path from 'path';
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

import { extractRawPageVectors, classifyPageVectors } from '../src/core/layout/vectorGraphics';
import { decodePageGlyphs } from '../src/core/glyphs/fontDecoder';
import { evaluateDisplayFormulaLine } from '../src/core/math/mathEngine2D';
import { solveAcademicPageLayout } from '../src/core/layout/academicLayoutEngine';

async function main() {
  const pdfPath = 'D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const page = await doc.getPage(4);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const opList = await page.getOperatorList();
  const rawGraphics = extractRawPageVectors(opList, pdfjsLib.OPS, viewport.width, viewport.height);
  const pageW = viewport.width;
  const pageH = viewport.height;

  // Let's run solveAcademicPageLayout and print the result
  const solved = solveAcademicPageLayout({
    pageNum: 4,
    items: textContent.items,
    spans: textContent.items.map((it: any) => ({ textContent: it.str })),
    pageW,
    pageH,
    rawGraphics,
    splitBlockFormula: true
  });

  console.log('--- Paras around 22-24 ---');
  solved.paras.forEach((p, idx) => {
    if (idx >= 21 && idx <= 25) {
      console.log(`\nPARA #${idx} [${p.type}] (sec=${p.section}):`);
      console.log('cleanText:', p.cleanText);
    }
  });
}

main().catch(console.error);
