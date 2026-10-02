/**
 * 术语处理复核：只查一句，确认生造直译是否消失、英文原词是否保留。
 * 用法：node scratch/dstest/term_probe.js <key>
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const raw = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'settings.json'), 'utf8'));
const conf = {};
Object.keys(raw)
  .filter(k => k.startsWith('academicReader.'))
  .forEach(k => (conf[k.slice('academicReader.'.length)] = raw[k]));
conf.translationService = 'openai-compatible';
conf.apiKey = process.argv[2];

const stub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => (conf[k] !== undefined ? conf[k] : d) }) },
  window: {},
  Uri: {}
};
const ol = Module._load;
Module._load = function (r) {
  if (r === 'vscode') return stub;
  return ol.apply(this, arguments);
};

const { PaperTranslator } = require(path.join(__dirname, 'build', 'translator.js'));

const CASES = [
  'A common idea is to design deep networks capable of object-agnostic segmentation at the test time, given guidance information.',
  'The query encoder takes only an image as the input, while the memory encoder takes both an image and an object mask.'
];

(async () => {
  const t = new PaperTranslator(() => {});
  let bad = 0;
  for (const text of CASES) {
    const r = await t.translateParagraph(text, [text], 'zh-CN');
    console.log('\n原文: ' + text);
    console.log('译文: ' + r.translation);
    const keepsTerm = /\(object-agnostic\)/i.test(r.translation);
    const invents = /对象无关/.test(r.translation);
    console.log('保留英文原词 (object-agnostic): ' + (keepsTerm ? '是' : '否'));
    console.log('仍生造「对象无关」: ' + (invents ? '是 ← 不合格' : '否'));
    if (invents || !keepsTerm) bad++;
  }
  console.log(bad === 0 ? '\n✅ 术语处理合格' : `\n❌ ${bad} 处不合格`);
})();
