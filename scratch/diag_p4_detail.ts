import * as fs from 'fs';
import * as path from 'path';
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

import { decodePageGlyphs } from '../src/core/glyphs/fontDecoder';

async function main() {
  const pdfPath = 'D:/kx/上海交大/基于变分推断的点监督目标检测迭代伪标签优化/文献及要求/Point2RBox-v2_CVPR2025.pdf';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const page = await doc.getPage(4);
  const textContent = await page.getTextContent();
  const { glyphs } = decodePageGlyphs(textContent.items as any[], () => '', 10);
  const gs = glyphs.filter(g => g.y >= 90 && g.y <= 105 && g.x <= 250);
  gs.sort((a, b) => a.x - b.x);
  console.log('Glyphs in lower limit of sum:');
  gs.forEach(g => {
    console.log(`x=${g.x.toFixed(1)}, y=${g.y.toFixed(1)}, text="${g.text}", unicode=${g.text.split('').map(c => c.charCodeAt(0).toString(16)).join(',')}, font=${g.fontName}, role=${g.fontRole}`);
  });
}

main().catch(console.error);
