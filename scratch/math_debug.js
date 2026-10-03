/**
 * 数学层成组的定点调试：用**手工构造的真实坐标**（取自 cycle 第 4 页 pdf.js 的原始 item）
 * 跑 buildPageMathModel，打印每一条公式与它的 item 来源。
 *
 * 【为什么要它】PDF 全页里有上百个 item，出问题时无法判断是"几何判据"还是"数据"的问题。
 * 这里只用一条式子的真实数字，任何偏差都能立刻定位到判据。
 *
 * 用法：node scratch/math_debug.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const s = code.indexOf('  const MATH_FONT_RE');
const e = code.indexOf('  // ====================== 核心：学术文献双栏高保真版面解析器');
if (s < 0 || e < 0) throw new Error('抽片锚点失效');
const ML = new Function(`${code.slice(s, e)}
  return { buildPageMathModel, mathItemsToLatex, isMathFontName };`)();

const mk = (str, x, y, size, width, font) => ({
  str, width, height: size, transform: [size, 0, 0, size, x, y], fontName: font
});

// —— cycle 第 4 页 y=538.4 那一行的真实 item（顺序照抄 math_probe 的输出）
const row = [
  mk('X', 383.208, 538.364, 10, 7.106, 'CMSY10'),
  mk('t', 390.314, 536.870, 7, 3.055, 'CMMI7'),
  mk('−', 393.300, 536.870, 7, 6.209, 'CMSY7'),
  mk('1', 399.600, 536.870, 7, 3.969, 'CMR7'),
  mk('=', 407.605, 538.364, 10, 7.749, 'CMR10'),
  mk('{', 418.938, 538.364, 10, 5.010, 'CMSY10'),
  mk('X', 423.939, 538.364, 10, 8.253, 'CMMI10'),
  mk('1', 432.173, 536.870, 7, 3.972, 'CMR7'),
  mk('}', 436.643, 538.364, 10, 4.981, 'CMSY10'),
  mk('Y', 447.207, 538.364, 10, 6.658, 'CMSY10'),
  mk('t', 453.865, 536.870, 7, 3.055, 'CMMI7'),
  mk('−', 456.900, 536.870, 7, 6.209, 'CMSY7'),
  mk('1', 463.100, 536.870, 7, 3.972, 'CMR7'),
  mk('=', 471.155, 538.364, 10, 7.749, 'CMR10'),
  mk('{', 482.489, 538.364, 10, 5.010, 'CMSY10'),
  mk('Y', 487.498, 538.364, 10, 5.756, 'CMMI10'),
  mk('1', 493.255, 536.870, 7, 3.972, 'CMR7'),
  mk('}', 497.723, 538.364, 10, 4.981, 'CMSY10')
];

const model = ML.buildPageMathModel(row, k => k, 10);
console.log('数学 item 数：', model.items.filter(i => i.math).length);
console.log('公式条数：', model.runs.length);
model.runs.forEach(r => {
  console.log(`  LaTeX: ${r.latex}`);
  console.log(`    来源: ${r.items.map(i => i.str).join(' ')}   box=${JSON.stringify(r.box)}`);
});
console.log('整行一条式子的 LaTeX：', ML.mathItemsToLatex(row));

// ---- 判据复核：把每条判据单独算一遍，看哪一条不成立（不许猜）
const X = row[0];
const t = row[1];
const hGap = 1.6;
const vGap = Math.max(1.2, 10 * 0.18);
const xEnd = X.transform[4] + X.width;
const tX = t.transform[4];
const tXEnd = t.transform[4] + t.width;
console.log('\n判据复核（X 与 t 是否该合并）:');
console.log('  X.xEnd =', xEnd, ' t.x =', tX);
console.log('  横向间隙 =', tX - xEnd, '<= hGap?', tX - xEnd <= hGap);
console.log('  反向重叠 =', tXEnd - X.transform[4], '>= -hGap?', tXEnd - X.transform[4] >= -hGap);
console.log('  垂直 vGap =', vGap, ' t.yBot >= X.yTop - vGap ?', t.transform[5] >= X.transform[5] - vGap);
console.log('  t.yTop <= X.yBot + vGap ?', t.transform[5] <= X.transform[5] + vGap);

