/**
 * 探针：打印某页 textContent item 的字体真名（page.commonObjs）+ 前若干 span 的文本，
 * 用来判断"整页被当公式"是否由数学字体族误判引起。
 * 用法: node scratch/probe_fonts.js <pdf> <page>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const ROOT = path.join(__dirname, '..');

(async () => {
  const pdfPath = process.argv[2];
  const pageNum = Number(process.argv[3] || 1);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false
  }).promise;
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  await page.getOperatorList();
  const names = new Map();
  for (const it of tc.items) {
    if (!it.fontName || names.has(it.fontName)) continue;
    let real = '';
    try {
      const f = page.commonObjs.get(it.fontName);
      real = (f && f.name) || '';
    } catch (e) { real = '(未取到:' + e.message + ')'; }
    names.set(it.fontName, real);
  }
  console.log('字体表：');
  for (const [k, v] of names) console.log(`  ${k} -> ${v}`);
  console.log('\n前 60 个 item：');
  tc.items.slice(0, 60).forEach((it, i) => {
    console.log(`  #${String(i).padStart(3)} font=${it.fontName} real=${names.get(it.fontName)} size=${(it.height || 0).toFixed(1)} x=${it.transform[4].toFixed(1)} y=${it.transform[5].toFixed(1)} ${JSON.stringify(it.str)}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
