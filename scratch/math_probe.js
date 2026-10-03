/**
 * 数学区域诊断：按**字体名**把一页的文本 item 分成「正文 / 数学」两桶，逐行打印
 * ① 当前 viewer 的拼法（所有 span 用空格硬拼）② 字体分组后的真实结构（含 gap、上下标偏移）。
 *
 * 【为什么要它】用户反馈"公式/符号提取不准，残渣和正文其余字体混在一起"。
 * 这条链路可以在本机完全复原：只要拿到每个 item 的 fontName（pdf.js 的 commonObjs 里有真名），
 * 公式属于哪些字面就一目了然（本文三篇论文的公式全部落在 CM 系列与 MS 系列数学字体里）。
 * 【本文件踩过的坑】注释里绝不能写「星号加斜杠」这种字面：它会**提前闭合块注释**，
 * 后面紧跟的中文就被当成标识符，报 `Invalid or unexpected token`（实测就是这么挂的）。
 *
 * 用法：node scratch/math_probe.js <pdf> <page> [--grep 关键词]
 *      node scratch/math_probe.js <pdf> <page> --unique    # 列出该页数学字体里出现的所有字符
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const MATH_FONT_RE = /(^|[+\-])(CM(MI|SY|R|EX|BX|SS|TT|TI|U|Sans)|MS(AM|BM)|LatinModern|LM(Math|Roman)|STIX|XITS|CambriaMath|AsanaMath|TeXGyre|Euler|MathJax|D050000L|Symbol|MTExtra|MathematicalPi|Math\d)/i;

(async () => {
  const pdfPath = process.argv[2];
  const pageNum = Number(process.argv[3] || 1);
  const grepIdx = process.argv.indexOf('--grep');
  const kw = grepIdx >= 0 ? process.argv[grepIdx + 1] : null;
  const unique = process.argv.includes('--unique');

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, disableFontFace: true }).promise;
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  await page.getOperatorList(); // 触发字体加载，之后 commonObjs 里才有真实字体名
  const fontOf = k => {
    try {
      const f = page.commonObjs.get(k);
      return (f && f.name) || String(k);
    } catch { return String(k); }
  };
  const items = tc.items
    .map((it, idx) => ({ ...it, idx, font: fontOf(it.fontName), math: MATH_FONT_RE.test(fontOf(it.fontName)) }))
    .filter(it => it.str && it.str.length);

  if (unique) {
    const set = new Map();
    items.filter(i => i.math).forEach(i => {
      for (const ch of i.str) {
        const key = ch;
        const cp = 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
        if (!set.has(key)) set.set(key, { cp, fonts: new Set(), n: 0, samples: [] });
        const e = set.get(key);
        e.fonts.add(i.font.replace(/^[A-Z]{6}\+/, ''));
        e.n++;
        if (e.samples.length < 3) e.samples.push(`p${pageNum} y=${i.transform[5].toFixed(1)} sz=${Math.hypot(i.transform[1], i.transform[3]).toFixed(1)}`);
      }
    });
    console.log(`page ${pageNum}: 数学字体字符 ${set.size} 个`);
    [...set.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([ch, e]) =>
      console.log(`  ${JSON.stringify(ch)} ${e.cp} x${e.n}  [${[...e.fonts].join(',')}]  ${e.samples[0]}`));
    return;
  }

  // 按 y 聚行（容差 3.5pt），行内按 x 排序
  const lines = [];
  items.forEach(it => {
    const y = it.transform[5];
    let L = lines.find(l => Math.abs(l.y - y) <= 3.5);
    if (!L) { L = { y, items: [] }; lines.push(L); }
    L.items.push(it);
  });
  lines.sort((a, b) => b.y - a.y);

  console.log(`page ${pageNum}: ${items.length} items, ${lines.length} lines`);
  lines.forEach(L => {
    L.items.sort((a, b) => a.transform[4] - b.transform[4]);
    const cur = L.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
    if (kw && !cur.includes(kw)) return;
    const hasMath = L.items.some(i => i.math);
    if (!hasMath) return;
    console.log(`\n=== y=${L.y.toFixed(1)}  ${cur.slice(0, 150)}`);
    L.items.forEach((it, i) => {
      const prev = L.items[i - 1];
      const gap = prev ? it.transform[4] - (prev.transform[4] + (prev.width || 0)) : 0;
      const sz = Math.hypot(it.transform[1], it.transform[3]);
      console.log(
        `   ${it.math ? 'MATH' : 'body'} x=${it.transform[4].toFixed(1).padStart(6)} y=${it.transform[5].toFixed(1).padStart(6)} ` +
        `sz=${sz.toFixed(1).padStart(4)} w=${(it.width || 0).toFixed(1).padStart(6)} gap=${gap.toFixed(1).padStart(5)} ` +
        `${it.font.replace(/^[A-Z]{6}\+/, '').padEnd(22)} ${JSON.stringify(it.str)}`
      );
    });
  });
})().catch(e => { console.error(e); process.exit(1); });
