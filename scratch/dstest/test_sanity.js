/**
 * checkTranslationSanity / similarity 的回归测试。
 * 全部针对真实触发过的误判场景——尤其是"中文译文里含原文也有的数字"。
 */
const fs = require('fs');
const path = require('path');

const vscodeStub = require('vscode');
Object.assign(vscodeStub.__store, {
  translationService: 'openai-compatible',
  apiKey: 'sk-dummy',
  apiEndpoint: 'https://api.deepseek.com/v1',
  modelName: 'deepseek-chat',
  targetLanguage: 'zh-CN'
});

const { PaperTranslator } = require('./out/translator.js');
const tr = new PaperTranslator(() => {});

const EN =
  'Recent approaches to semi-supervised video object segmentation rely on a matching mechanism between the current frame and memory frames, as illustrated in Fig. 2.';

let pass = 0;
let fail = 0;
function t(name, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        期望: ${JSON.stringify(expected)}\n        实际: ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}
function tNotNull(name, actual) {
  const ok = actual !== null;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('        期望: 非 null（应被标记）  实际: null');
  ok ? pass++ : fail++;
}

console.log('=== similarity 基本行为 ===');
t('完全相同的英文 → 1', tr['similarity'](EN, EN), 1);
t('极短片段不得命中（"2" 是 bug 根源）', tr['similarity'](EN, '2'), 0);
t('极短片段 "ai" 不得命中', tr['similarity'](EN, 'ai'), 0);
t('空串 → 0', tr['similarity'](EN, ''), 0);
t(
  '同一段英文 vs 英文（略长）→ 仍然判为高度相似',
  tr['similarity']('We rely on a matching mechanism between frames.', 'We rely on a matching mechanism between the frames.') > 0.6,
  true
);

console.log('\n=== checkTranslationSanity：正常中文译文必须通过 ===');
t(
  '中文译文含 "图2"（数字在原文也出现）→ 必须通过',
  tr['checkTranslationSanity'](
    EN,
    '近期半监督视频目标分割方法依赖于当前帧与记忆帧之间的匹配机制，如图2所示。',
    'zh-CN'
  ),
  null
);
t(
  '中文译文含域名/缩写关键字（ai 出现在原文）→ 必须通过',
  tr['checkTranslationSanity'](EN, '本文提出的 AI 方法显著提升了分割精度。', 'zh-CN'),
  null
);
t('纯中文译文 → 通过', tr['checkTranslationSanity'](EN, '这是一段完全中文的学术译文。', 'zh-CN'), null);
t(
  '中文译文含年份 2019 → 通过',
  tr['checkTranslationSanity'](EN, '该方法于 2019 年首次提出，并在 DAVIS 上验证。', 'zh-CN'),
  null
);

console.log('\n=== checkTranslationSanity：照搬原文必须被拦下 ===');
tNotNull('整段照抄英文原文 → 标记', tr['checkTranslationSanity'](EN, EN, 'zh-CN'));
tNotNull(
  '英文原文（仅改动标点/空白）→ 标记',
  tr['checkTranslationSanity'](EN, EN.replace(/\s+/g, ' ').replace('Fig.', 'Fig'), 'zh-CN')
);
tNotNull('只回了一个数字 "2" → 标记（未翻译）', tr['checkTranslationSanity'](EN, '2', 'zh-CN'));

console.log('\n=== 边界：不应校验的情形 ===');
t('目标语言非中文 → 不校验', tr['checkTranslationSanity'](EN, EN, 'en'), null);
t('源文本本身含中文 → 不校验', tr['checkTranslationSanity']('这是中文原文', '这是中文原文', 'zh-CN'), null);
t('极短拉丁内容（<8 字母）→ 不校验', tr['checkTranslationSanity']('Fig. 2', 'Fig. 2', 'zh-CN'), null);
t(
  '作者人名（无需翻译，含大量拉丁字母）→ 会被标记（可接受，UI 会显示未通过校验）',
  tr['checkTranslationSanity'](
    'Seoung Wug Oh, Joon-Young Lee, Ning Xu, Seon Joo Kim',
    'Seoung Wug Oh, Joon-Young Lee, Ning Xu, Seon Joo Kim',
    'zh-CN'
  ) !== null,
  true
);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
