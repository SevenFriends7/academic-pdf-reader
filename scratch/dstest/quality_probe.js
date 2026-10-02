/**
 * 翻译质量对比：用真实代码 + 真实 DeepSeek 翻译出问题的那两句，人工核对改进效果。
 * 用法：node scratch/dstest/quality_probe.js <deepseekKey>
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const KEY = process.argv[2];
if (!KEY) {
  console.error('缺少 key');
  process.exit(2);
}

const settingsPath = path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'settings.json');
const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const conf = {};
Object.keys(raw)
  .filter(k => k.startsWith('academicReader.'))
  .forEach(k => (conf[k.slice('academicReader.'.length)] = raw[k]));
conf.translationService = 'openai-compatible';
conf.apiEndpoint = 'https://api.deepseek.com/v1';
conf.modelName = 'deepseek-chat';
conf.apiKey = KEY;

const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => (conf[k] !== undefined ? conf[k] : d) }) },
  window: {},
  Uri: {}
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const { PaperTranslator } = require(path.join(__dirname, 'build', 'translator.js'));

const CASES = [
  {
    label: '出问题的那句（object-agnostic）',
    text:
      'A common idea is to design deep networks capable of object-agnostic segmentation at the test time, given guidance information.'
  },
  {
    label: '修复后合并的完整句（原本被栏底切断）',
    text:
      'Many of aforementioned methods fine-tune deep network models on the initial object mask in the first frame to remember the appearance of the target object [2,34,26,14,26,11,18] during the test time.'
  },
  {
    label: '带限定词的句子（考察是否漏掉 only/not）',
    text:
      'Our framework does not require online learning, and it only stores the intermediate outputs of the past frames, not their full feature maps.'
  }
];

(async () => {
  const t = new PaperTranslator(() => {});
  for (const c of CASES) {
    console.log(`\n${'='.repeat(78)}\n【${c.label}】\n原文: ${c.text}\n${'='.repeat(78)}`);
    try {
      const split = t.constructor.name ? c.text.split(/(?<=[.!?])\s+/).filter(Boolean) : [c.text];
      const r = await t.translateParagraph(c.text, split, 'zh-CN');
      console.log('整段译文: ' + r.translation);
      if (r.sentences && r.sentences.length) {
        console.log('逐句译文:');
        r.sentences.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
      }
      console.log(`（对齐模式 ${r.mode}，aligned=${r.aligned}${r.note ? '，note=' + r.note : ''}）`);
      if (/对象无关/.test(r.translation)) console.log('⚠️ 仍然出现"对象无关"生造词');
      if (/，\s*给定[^。]*。\s*$/.test(r.translation)) console.log('⚠️ 仍然出现句尾悬空状语');
    } catch (e) {
      console.log(`❌ 失败: ${e.kind || e.name}: ${e.message}`);
    }
  }
})();
