/**
 * 译文栏公式残渣处理的回归测试（1.6.22）。
 *
 * 守两件事：
 *   ① 长公式（>24 字符）必须仍被认成公式 —— 旧上限直接把它判成"不是公式"，
 *      于是整串符号原样贴进中文句子（实测 Xu 2020 第 4 页）。
 *   ② 认成公式但配不上规范写法时，译文里**不能再出现裸残渣**，只留 `⟨公式⟩` 占位。
 *
 * 用真源码切片 + stub 注入（同 scratch/math_layer_test.js 的做法），不复制业务逻辑。
 *
 * 用法：node scratch/zh_math_residue_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  ❌ ${label}${extra ? `   ${extra}` : ''}`);
  }
}

function cut(startAnchor, endAnchor) {
  const s = code.indexOf(startAnchor);
  if (s < 0) throw new Error(`找不到起点锚：${startAnchor}`);
  const e = code.indexOf(endAnchor, s + startAnchor.length);
  if (e <= s) throw new Error(`找不到终点锚：${endAnchor}`);
  return code.slice(s, e);
}

const segResidue = cut('  function looksLikeFormulaResidue(', '\n  /**');
const segKey = cut('  function residueKeyOf(', '\n  /**');
const segZh = cut('  function renderZhWithMath(', '  /**\n   * 英文原文里的行内公式渲染');

// eslint-disable-next-line no-new-func
const M = new Function(
  'renderVisionMathHtml',
  'renderEnTextHtml',
  'residueKeyOf',
  'looksLikeFormulaResidue',
  'escapeHtml',
  'residueToLiteralLatex',
  `
  ${segKey}
  ${segResidue}
  ${segZh}
  return { renderZhWithMath, looksLikeFormulaResidue, residueKeyOf };`
)(
  (tex) => `<KATEX>${tex}</KATEX>`,
  (t) => `TEXT(${t})`,
  (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(),
  // looksLikeFormulaResidue 在下面用真实现覆盖（先给个占位，避免自引用）
  () => false,
  (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  (s) => String(s == null ? '' : s)
);

// 用真实现再做一份（new Function 里已经定义了同名的，前面那个入参只是占位）
// eslint-disable-next-line no-new-func
const R = new Function(
  'renderVisionMathHtml',
  'renderEnTextHtml',
  'residueToLiteralLatex',
  'escapeHtml',
  `
  ${segKey}
  ${segResidue}
  ${segZh}
  return { renderZhWithMath, looksLikeFormulaResidue };`
)(
  (tex) => `<KATEX>${tex}</KATEX>`,
  (t) => `TEXT(${t})`,
  (s) => String(s == null ? '' : s),
  (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
);

// ---------------------------------------------------------------- ① 长度判据
console.log('\n--- ① 长公式不能再被"长度"挡掉 ---');
{
  const long45 = 'j ‖ (5) (i,j,t) ∈ DT} ∑ ‖ () − 1() ‖ − Vt1 −';
  check('45 字符的编号式子被认成公式', R.looksLikeFormulaResidue(long45) === true);

  const short = 'Y ∈ R^{HW×C}';
  check('短公式仍然认成公式', R.looksLikeFormulaResidue(short) === true);

  const prose = 'S is // the set of all VIO // ego motion measurements. // // z t is the residual of distance';
  check('长正文（含 // ）不被认成公式', R.looksLikeFormulaResidue(prose) === false, String(prose.length));

  const tableish = 'OL J (%) F (%) mAP (%) 64.8 72.1 68.3 70.2 74.5 71.0';
  check('表格数字串不被认成公式', R.looksLikeFormulaResidue(tableish) === false);
}

// ---------------------------------------------------------------- ② 渲染结果
console.log('\n--- ② 配不上写法时，译文里不能有裸残渣 ---');
{
  const para = {
    id: 7,
    type: 'body',
    segments: [
      { kind: 'body', text: 'where ' },
      { kind: 'math', text: 'min ∑ (i,j,t)∈DT', latex: '\\min\\sum_{(i,j,t)\\in DT}' },
      { kind: 'body', text: ' is the residual' }
    ]
  };

  // 能配上（精确）
  const hit = R.renderZhWithMath('其中 ⟦min ∑ (i,j,t)∈DT⟧ 是残差。', para);
  check('精确匹配 → 渲染成公式', hit.includes('KATEX'), hit);
  check('精确匹配 → 不留协议符号', !hit.includes('\u27e6'), hit);

  // 配不上（翻译模型抄歪了）
  const miss = R.renderZhWithMath('其中 ⟦j ‖ (5)(i, j, t) ∈ DT} ∑ ‖ 0 − 1() ‖ − Vt1 −⟧ 是残差。', para);
  check('配不上 → 输出占位 ⟨公式⟩', miss.includes('⟨公式⟩'), miss);
  // 只看**肉眼可见的文字**：title 属性里留着完整残渣是故意的（悬停可查），不算"贴了残渣"
  const visibleText = miss.replace(/<[^>]+>/g, '');
  check('配不上 → 可见文字里没有裸残渣', !visibleText.includes('Vt1'), visibleText);
  check('配不上 → 中文照常显示', miss.includes('是残差'), miss);
  check('占位符把原残渣放进 title（信息不丢）', /title="[^"]*Vt1/.test(miss), miss);
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
