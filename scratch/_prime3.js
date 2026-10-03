'use strict';
const fs = require('fs');
let code = fs.readFileSync(require('path').join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const s = code.indexOf('  const MATH_FONT_RE'), e = code.indexOf('  function buildPageMathModel');
let snip = code.slice(s, code.indexOf('\n  /**', e));
snip = snip.replace(
  "          if (/^[′″‴']+$/.test(String(it.str))) { host.str += it.str; return; }",
  "          if (/^[′″‴']+$/.test(String(it.str))) { if (globalThis.__D) console.log('[PRIME]', JSON.stringify({lx:it.lx, ly:it.ly, hostStr:host.str, hostX:host.x, nChars:chars.length, chars:chars.map(c=>[c.str, +c.x.toFixed(2)])})); host.str += it.str; return; }"
);
globalThis.__D = true;
const ML = new Function(snip + '\n return { mathItemsToLatex };')();
const mk = (str, x, y, size, w) => ({ str, width: w, height: size, transform: [size, 0, 0, size, x, y] });
console.log(JSON.stringify(ML.mathItemsToLatex([
  mk('V', 141.22, 425.35, 9.96, 5.81),
  mk('′', 149.24, 429.46, 6.97, 2.30),
  mk('=', 154.80, 425.35, 9.96, 7.75),
  mk('AttID', 165.32, 425.35, 9.96, 28.08),
  mk('(', 193.67, 425.35, 9.96, 3.87)
])));
