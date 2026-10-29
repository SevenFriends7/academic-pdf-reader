/**
 * 英文断句回归（逐句对齐失败的主要来源之一）。
 *
 * 用户截图（1312.6114 VAE 第 2 页）：逐句对齐失败，英文句对里出现
 *   `… consisting of N i.i.d.` / `samples of some continuous …`
 *   `… differentiable almost everywhere w.r.t.` / `both θ and z.`
 *   `… above scenario: 1.` / `Efficient approximate ML …`
 * 即断句器把学术缩写、列表编号当成了句末。这里用真实句子做断言。
 *
 * 用法：node scratch/sentence_split_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');
const start = code.indexOf('  function splitEnglishSentencesSmart(text) {');
const end = code.indexOf('  function splitChineseSentences(text) {');
if (start < 0 || end < 0) {
  console.error('❌ 找不到 splitEnglishSentencesSmart');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const split = new Function(`${code.slice(start, end)}\n return splitEnglishSentencesSmart;`)();

let pass = 0;
let fail = 0;
const check = (label, ok, extra) => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  ❌ ${label}${extra ? `\n     ${extra}` : ''}`);
  }
};
const texts = t => split(t).map(s => s.text);

console.log('===== 英文断句：学术缩写 / 列表编号 =====');
{
  const t1 = 'Let us consider some dataset X = { x (i) } N i =1 consisting of N i.i.d. samples of some continuous or discrete variable x.';
  const r1 = texts(t1);
  check('i.i.d. 不当句末', r1.length === 1, JSON.stringify(r1));

  const t2 = 'We assume that the prior p(z) and likelihood p(x | z) come from parametric families, and that their PDFs are differentiable almost everywhere w.r.t. both θ and z.';
  const r2 = texts(t2);
  check('w.r.t. 不当句末', r2.length === 1, JSON.stringify(r2));

  const t3 = 'The process consists of two steps: (1) a value z (i) is generated from some prior distribution p(z); (2) a value x (i) is generated from some conditional distribution p(x | z).';
  const r3 = texts(t3);
  check('; (2) 是列表枚举，不断句', r3.length === 1, JSON.stringify(r3));

  const t4 = 'We are interested in, and propose a solution to, three related problems in the above scenario: 1. Efficient approximate ML estimation for the parameters θ.';
  const r4 = texts(t4);
  check('列表编号 1. 不单独成句', r4.length === 1, JSON.stringify(r4));
}

console.log('\n===== 英文断句：正常句子仍要切开 =====');
{
  const r = texts('We propose a model. It has two parts. Experiments confirm it.');
  check('普通三句仍切成 3 句', r.length === 3, JSON.stringify(r));

  const r2 = texts('See Fig. 2. The model has two branches.');
  check('Fig. 2. 后是正常句末', r2.length === 2, JSON.stringify(r2));

  const r3 = texts('Smith et al. (2020) proposed the method.');
  check('et al. 不断句', r3.length === 1, JSON.stringify(r3));

  const r4 = texts('Small values, e.g. 3.5 and 4.2, are clipped.');
  check('e.g. 后不断句', r4.length === 1, JSON.stringify(r4));
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
