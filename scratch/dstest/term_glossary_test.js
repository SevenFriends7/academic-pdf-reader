/**
 * 术语兜底逻辑单测（不需要 API）。
 * 用法：node scratch/dstest/term_glossary_test.js
 */
const path = require('path');
const { missingRiskyTerms, applyTermGlossary } = require(path.join(__dirname, 'build', 'translator.js'));

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? '\n       ' + detail : ''}`);
  }
};

console.log('\n===== missingRiskyTerms =====');
check(
  'object-agnostic 硬译成"与对象无关" → 判定缺失',
  JSON.stringify(missingRiskyTerms('capable of object-agnostic segmentation', '进行与对象无关的分割')) ===
    JSON.stringify(['object-agnostic']),
  JSON.stringify(missingRiskyTerms('capable of object-agnostic segmentation', '进行与对象无关的分割'))
);
check(
  '译文里带英文原词 → 判定合格',
  missingRiskyTerms('object-agnostic segmentation', '与目标类别无关（object-agnostic）的分割').length === 0,
  JSON.stringify(missingRiskyTerms('object-agnostic segmentation', '与目标类别无关（object-agnostic）的分割'))
);
check(
  '大小写不敏感',
  missingRiskyTerms('Object-Agnostic segmentation', 'object-agnostic 分割').length === 0
);
check(
  '无风险术语的普通句子 → 不误判',
  missingRiskyTerms('the model is trained end to end on the first frame', '模型在第一帧上端到端训练').length === 0
);
check(
  '多个风险术语一次全部找出',
  JSON.stringify(missingRiskyTerms('category-specific and object-agnostic heads', '类别特定的头')) ===
    JSON.stringify(['category-specific', 'object-agnostic']),
  JSON.stringify(missingRiskyTerms('category-specific and object-agnostic heads', '类别特定的头'))
);

console.log('\n===== applyTermGlossary =====');
const src =
  'A common idea is to design deep networks capable of object-agnostic segmentation at the test time, given guidance information.';
const zh = [
  '一个常见的想法是设计能够在测试时根据给定的引导信息进行与对象无关的分割的深度网络。'
];
const g1 = applyTermGlossary(src, zh[0], [src], zh);
check('整段译文补上术语原文行', /（术语原文：object-agnostic）/.test(g1.translation), g1.translation);
check('逐句译文结尾补上英文原词', /（object-agnostic）$/.test(g1.sentences[0]), g1.sentences[0]);
check('原始中文内容没有被改动', g1.sentences[0].startsWith('一个常见的想法是设计'), g1.sentences[0]);

const g2 = applyTermGlossary(src, '与目标类别无关（object-agnostic）的分割', [src], ['与目标类别无关（object-agnostic）的分割']);
check('已合规时不重复添加', !/术语原文/.test(g2.translation) && !/（object-agnostic）（/.test(g2.sentences[0]), g2.translation);

const plainSrc = 'The query encoder takes only an image as the input.';
const g3 = applyTermGlossary(plainSrc, '查询编码器仅以图像作为输入。', [plainSrc], ['查询编码器仅以图像作为输入。']);
check('普通句子完全不受影响', g3.translation === '查询编码器仅以图像作为输入。' && g3.sentences[0] === '查询编码器仅以图像作为输入。', g3.translation);

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
