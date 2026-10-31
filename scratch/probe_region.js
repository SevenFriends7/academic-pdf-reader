/** 打印某页指定 y 区间内所有 item（字体/字号/坐标/文本），用于公式吸收规则调参。 */
'use strict';
const fs = require('fs');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
(async () => {
  const [pdf, p, y0, y1] = process.argv.slice(2);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), useSystemFonts: false }).promise;
  const page = await doc.getPage(Number(p));
  const tc = await page.getTextContent();
  await page.getOperatorList();
  const real = {};
  for (const it of tc.items) {
    if (!it.fontName || real[it.fontName]) continue;
    try { real[it.fontName] = page.commonObjs.get(it.fontName).name || ''; } catch { real[it.fontName] = '?'; }
  }
  tc.items.forEach((it, i) => {
    const y = it.transform[5];
    if (y < Number(y0) || y > Number(y1)) return;
    console.log(`#${String(i).padStart(3)} y=${y.toFixed(1)} x=${it.transform[4].toFixed(1)} w=${(it.width || 0).toFixed(1)} h=${(it.height || 0).toFixed(1)} ${String(real[it.fontName] || it.fontName).padEnd(22)} ${JSON.stringify(it.str)}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
