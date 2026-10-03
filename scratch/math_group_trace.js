/**
 * 成组决策逐条追踪：按真实 PDF 的 item 顺序打印"每个字形被并进了哪个组"。
 *
 * 【为什么要它】成组判据有 4 条分支，出问题时只看最终 LaTeX 无法判断是哪一条误判/漏判。
 * 这里把每次归并的**宿主现状**也打出来（宿主包含哪些字符、x 跨度、基线、基准字号），
 * 一眼就能看出"该并的没并"还是"不该并的并了"。
 *
 * 用法：node scratch/math_group_trace.js <pdf> <page> [x下限] [x上限]
 */
'use strict';
globalThis.__MATH_DBG = true;
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const s = code.indexOf('  const MATH_FONT_RE');
const e = code.indexOf('  // ====================== 核心：学术文献双栏高保真版面解析器');
const ML = new Function(`${code.slice(s, e)}\n return { buildPageMathModel };`)();

const pdfPath = process.argv[2];
const pageNum = Number(process.argv[3] || 1);
const xLo = process.argv[4] ? Number(process.argv[4]) : -Infinity;
const xHi = process.argv[5] ? Number(process.argv[5]) : Infinity;

(async () => {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  await page.getOperatorList();
  const cache = new Map();
  const fontNameOf = k => {
    if (cache.has(k)) return cache.get(k);
    let n = String(k);
    try {
      const f = page.commonObjs.get(k);
      if (f && f.name) n = f.name;
    } catch { /* 保持 loadedName */ }
    cache.set(k, n);
    return n;
  };
  const origLog = console.log;
  console.log = (...a) => {
    const line = a.join(' ');
    try {
      const o = JSON.parse(line.replace(/^\[GRP\] /, ''));
      if (o.x < xLo || o.x > xHi) return;
    } catch { /* 非 JSON 日志照旧输出 */ }
    origLog(...a);
  };
  ML.buildPageMathModel(tc.items, fontNameOf, 10);
  console.log = origLog;
})().catch(err => { console.error(err); process.exit(1); });
