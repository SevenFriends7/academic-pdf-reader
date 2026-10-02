/**
 * 定位"照搬原文"校验为何误判：直接调真实 API 拿到译文，再喂给产物里的校验函数。
 */
const fs = require('fs');
const vscodeStub = require('vscode');
const s = JSON.parse(fs.readFileSync(process.env.APPDATA + '\\Antigravity IDE\\User\\settings.json', 'utf8'));
Object.assign(vscodeStub.__store, {
  translationService: s['academicReader.translationService'],
  apiKey: s['academicReader.apiKey'],
  apiEndpoint: s['academicReader.apiEndpoint'],
  modelName: s['academicReader.modelName'],
  targetLanguage: 'zh-CN',
  translationThinkingBudget: 0,
  translateConcurrency: 4
});

const { PaperTranslator } = require('./out/translator.js');

const SENTENCES = [
  'Recent approaches to semi-supervised video object segmentation commonly rely on a matching mechanism between the current frame and a set of memory frames.',
  'The space-time memory network stores both the key and the value of every past frame, as illustrated in Fig. 2.',
  'At inference time, the query encoder produces a query key and a query value, which are matched against all entries in the memory bank.'
];
const PARAGRAPH = SENTENCES.join(' ');
const N = SENTENCES.length;

async function main() {
  const tr = new PaperTranslator(m => console.log('  [log]', m));
  const cfg = vscodeStub.workspace.getConfiguration('academicReader');

  const prompt = `请把下面这段英文学术论文内容翻译为简体中文。

【英文原句，共 ${N} 句】
${SENTENCES.map((x, i) => `[${i + 1}] ${x}`).join('\n')}

【输出要求】
1. "translation"：整段连贯、地道、严谨的中文学术译文。
2. "sentences"：逐句译文数组，长度**必须恰好为 ${N}**，第 i 项只对应第 i 句，不得合并或拆分。
3. 公式、数学符号、变量名、缩写、文献引用编号原样保留。
4. 只输出 JSON 对象，形如 {"translation":"…","sentences":["…","…"]}，不要任何解释。`;

  console.log('=== 直接调用产物里的 callOpenAIChat(jsonMode=true) ===');
  const raw = await tr['callOpenAIChat'](
    '你是一名专业的学术论文翻译专家，只输出严格合法的 JSON 对象。',
    prompt,
    cfg,
    true
  );
  console.log('返回内容:');
  console.log(raw);
  console.log('');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.log('JSON 解析失败:', e.message);
    return;
  }

  const norm = x => (x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  console.log('=== 逐项体检 ===');
  console.log('translation      =', parsed.translation);
  console.log('sentences 数量   =', Array.isArray(parsed.sentences) ? parsed.sentences.length : 'NOT ARRAY', `(应为 ${N})`);
  console.log('');
  console.log('原文 norm 长度        =', norm(PARAGRAPH).length);
  console.log('译文 norm 长度        =', norm(parsed.translation).length);
  console.log('译文 norm 内容        =', JSON.stringify(norm(parsed.translation)));
  console.log('');
  console.log('similarity(原文, 整段译文) =', tr['similarity'](PARAGRAPH, parsed.translation));
  console.log('similarity(原文, 逐句拼接) =', tr['similarity'](PARAGRAPH, parsed.sentences.join(' ')));
  console.log('');
  console.log('countCjk(原文) =', tr['countCjk'](PARAGRAPH));
  console.log('countCjk(译文) =', tr['countCjk'](parsed.translation));
  console.log('');
  console.log('checkTranslationSanity(原文, 整段译文) =', tr['checkTranslationSanity'](PARAGRAPH, parsed.translation, 'zh-CN'));
  console.log('checkTranslationSanity(原文, 逐句拼接) =', tr['checkTranslationSanity'](PARAGRAPH, parsed.sentences.join(' '), 'zh-CN'));
  console.log('');
  console.log('>>> 结论: 上面哪个不为 null，就是误判来源');
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
