/**
 * 原始文本层探针：把 pdf.js 抽出来的 item 原样打印（含 fontName / transform / width / height）。
 *
 * 【为什么需要它】用户反馈"公式/符号识别不准，残渣和正文其余字体混在一起"。
 * 要判断"是不是字体层的信息被丢掉了"，必须先把 pdf.js 真正给出的字段摊开看：
 * item 上到底有没有 fontName、上下标的基线差是多少、公式片段是不是被切成很多个小 item。
 *
 * 用法：node scratch/raw_text_probe.js <pdf路径> <页码> [--grep 关键词] [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const pdfPath = process.argv[2];
const pageNum = Number(process.argv[3] || 1);
const grepIdx = process.argv.indexOf('--grep');
const kw = grepIdx >= 0 ? process.argv[grepIdx + 1] : null;
const asJson = process.argv.includes('--json');

(async () => {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false }).promise;
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  const items = tc.items.filter(it => typeof it.str === 'string' && it.str.length > 0);
  if (asJson) {
    console.log(JSON.stringify(items.map(it => ({
      str: it.str, fontName: it.fontName, dir: it.dir, width: it.width, height: it.height,
      transform: it.transform, hasEOL: it.hasEOL
    })), null, 1));
    return;
  }
  console.log(`page ${pageNum}: ${items.length} items   styles=${JSON.stringify(Object.keys(tc.styles || {}))}`);
  items.forEach((it, i) => {
    const [a, b, c, d, e, f] = it.transform;
    const line = `${String(i).padStart(3)} x=${e.toFixed(1).padStart(6)} y=${f.toFixed(1).padStart(6)} ` +
      `h=${(it.height || 0).toFixed(1).padStart(5)} w=${(it.width || 0).toFixed(1).padStart(6)} ` +
      `sz=${Math.hypot(b, d).toFixed(1).padStart(4)} font=${String(it.fontName).padEnd(12)} ` +
      `str=${JSON.stringify(it.str)}`;
    if (kw && !line.includes(kw)) return;
    console.log(line);
  });
  // styles 表：fontName -> 字体元数据（pdf.js 用它决定 text layer 的 font-family）
  console.log('\n--- styles ---');
  Object.entries(tc.styles || {}).forEach(([k, v]) => console.log(`${k} => ${JSON.stringify(v)}`));
})().catch(e => { console.error(e); process.exit(1); });
