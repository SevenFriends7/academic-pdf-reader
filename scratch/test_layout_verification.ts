import * as fs from 'fs';
import * as path from 'path';
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

import { extractRawPageVectors } from '../src/core/layout/vectorGraphics';
import { solveAcademicPageLayout } from '../src/core/layout/academicLayoutEngine';

async function main() {
  const pdfPath = 'D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  for (const pageNum of [3, 4]) {
    console.log(`\n============================ PAGE ${pageNum} ============================`);
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const opList = await page.getOperatorList();
    const rawGraphics = extractRawPageVectors(opList, pdfjsLib.OPS, viewport.width, viewport.height);

    const fontNames: Record<string, string> = {};
    if (page.commonObjs) {
      for (const item of textContent.items as any[]) {
        if (item.fontName && !fontNames[item.fontName]) {
          try {
            if (page.commonObjs.has(item.fontName)) {
              const fontObj = page.commonObjs.get(item.fontName);
              if (fontObj && (fontObj.name || fontObj.loadedName)) {
                fontNames[item.fontName] = fontObj.name || fontObj.loadedName;
              }
            }
          } catch (e) {}
        }
      }
    }

    const solved = solveAcademicPageLayout({
      pageNum,
      items: textContent.items,
      spans: textContent.items.map((it: any) => ({ textContent: it.str })),
      pageW: viewport.width,
      pageH: viewport.height,
      fontNames,
      rawGraphics,
      splitBlockFormula: true
    });

    console.log(`Total paragraphs on page ${pageNum}: ${solved.paras.length}`);
    solved.paras.forEach((p: any, idx: number) => {
      const txt = p.cleanText || '';
      if (pageNum === 4 && idx >= 20 && idx <= 38) {
        console.log(`\n--- [P${pageNum} #${idx}] type=${p.type} y=${p.y ?? p.box?.y ?? p.minY} ---`);
        console.log(`keys: ${Object.keys(p).join(', ')}`);
        console.log(`cleanText: ${txt}`);
        if (p.segments && p.segments[0] && p.segments[0].latex) {
          console.log(`latex: ${p.segments[0].latex}`);
        }
      }
    });
  }
}

main().catch(console.error);
