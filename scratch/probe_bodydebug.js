/** 调试：打印某页 detectBodyMathFonts 结果与指定字体 item 的 math 归属。 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8').replace(/\r\n/g, '\n');
const start = code.indexOf('  const MATH_FONT_RE');
const end = code.indexOf('  function buildAcademicLayout(pageNum,');
const ML = new Function(`${code.slice(start, end)}
  return { detectBodyMathFonts, buildPageMathModel, isMathTextFontName, isMathFontName };`)();

(async () => {
  const [pdfPath, pg, fontFilter] = process.argv.slice(2);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false }).promise;
  const page = await doc.getPage(Number(pg));
  const tc = await page.getTextContent();
  await page.getOperatorList();
  const real = {};
  tc.items.forEach(it => {
    if (!it.fontName || real[it.fontName]) return;
    try { real[it.fontName] = page.commonObjs.get(it.fontName).name || ''; } catch { real[it.fontName] = ''; }
  });
  const mapped = tc.items.map(it => ({ ...it, font: real[it.fontName] || it.fontName }));
  const body = ML.detectBodyMathFonts(mapped);
  console.log('body fonts:', [...body]);
  const model = ML.buildPageMathModel(tc.items, k => real[k] || k, 10);
  tc.items.forEach((it, i) => {
    const f = real[it.fontName] || it.fontName;
    if (fontFilter && !f.includes(fontFilter)) return;
    const info = model.byIndex[i];
    console.log(`#${String(i).padStart(3)} ${f.padEnd(22)} ${JSON.stringify(it.str.slice(0, 20)).padEnd(24)} math=${!!(info && info.math)} bodyFont=${body.has(f)}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
