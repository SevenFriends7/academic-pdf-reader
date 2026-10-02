const fs = require('fs');
const path = require('path');

// ---- 从 IDE 设置里取真实的 DeepSeek 配置 ----
const settingsPath = process.env.APPDATA + '\\Antigravity IDE\\User\\settings.json';
const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const vscodeStub = require('vscode');
Object.assign(vscodeStub.__store, {
  translationService: s['academicReader.translationService'],
  apiKey: s['academicReader.apiKey'],
  apiEndpoint: s['academicReader.apiEndpoint'],
  modelName: s['academicReader.modelName'],
  geminiApiKey: s['academicReader.geminiApiKey'],
  geminiModel: s['academicReader.geminiModel'] || '',
  targetLanguage: 'zh-CN',
  translationThinkingBudget: 0,
  aiThinkingBudget: -1,
  aiTemperature: 0.4,
  translateConcurrency: 4
});
// 键名要带前缀，因为代码用的是 'academicReader.xxx'
Object.keys({ ...vscodeStub.__store }).forEach(k => {
  vscodeStub.__store['academicReader.' + k] = vscodeStub.__store[k];
});

const { PaperTranslator } = require('./out/translator.js');

const SENTENCES = [
  'Recent approaches to semi-supervised video object segmentation commonly rely on a matching mechanism between the current frame and a set of memory frames.',
  'The space-time memory network stores both the key and the value of every past frame, as illustrated in Fig. 2.',
  'At inference time, the query encoder produces a query key and a query value, which are matched against all entries in the memory bank.'
];
const PARAGRAPH = SENTENCES.join(' ');

const SENTENCES2 = [
  'We use a ResNet-50 backbone pretrained on ImageNet for both the query and the memory encoders.',
  'Training is performed on the DAVIS 2017 training set for 100,000 iterations with a batch size of 8.'
];
const PARAGRAPH2 = SENTENCES2.join(' ');

function report(label, r, ms) {
  console.log(`\n=== ${label} （${ms}ms）===`);
  if (r instanceof Error) {
    console.log('  ❌ 抛错:', r.name, r.message);
    if (r.apiMessage) console.log('     apiMessage:', r.apiMessage);
    if (r.tip) console.log('     tip:', r.tip);
    return;
  }
  console.log('  model      =', r.model);
  console.log('  mode       =', r.mode, '| aligned =', r.aligned);
  console.log('  note       =', r.note || '(无)');
  console.log('  translation:', r.translation);
  console.log('  逐句译文:', Array.isArray(r.sentences) ? r.sentences.length + ' 条' : '(无)');
  if (Array.isArray(r.sentences)) {
    r.sentences.forEach((x, i) => console.log(`    [${i + 1}] ${x}`));
    console.log(`  句数校验: ${r.sentences.length === SENTENCES.length ? '本条按 3 句样例' : ''}`);
  }
}

async function main() {
  const tr = new PaperTranslator(m => console.log('  [log]', m));

  // 1. 单段（就是你点单张卡片时会走的路径）
  let t0 = Date.now();
  const r1 = await tr.translateParagraph(PARAGRAPH, SENTENCES);
  report('T1 translateParagraph（3 句）', r1, Date.now() - t0);

  // 2. 缓存命中（第二次应立即返回，不再打 API）
  t0 = Date.now();
  const r2 = await tr.translateParagraph(PARAGRAPH, SENTENCES);
  console.log(`\n=== T2 再翻同一段（应命中缓存）=== ${Date.now() - t0}ms`);
  console.log('  与 T1 一致:', JSON.stringify(r2) === JSON.stringify(r1));

  // 3. 批量（整页翻译时扩展侧走的路径）
  t0 = Date.now();
  const batch = await tr.translateParagraphsBatch([
    { text: PARAGRAPH, sentences: SENTENCES },
    { text: PARAGRAPH2, sentences: SENTENCES2 },
    { text: 'Video object segmentation requires distinguishing the target from distractors.', sentences: ['Video object segmentation requires distinguishing the target from distractors.'] }
  ]);
  console.log(`\n=== T3 translateParagraphsBatch（3 段，含缓存命中）=== ${Date.now() - t0}ms`);
  batch.forEach((r, i) => {
    if (r instanceof Error) console.log(`  第 ${i + 1} 段 ❌`, r.message);
    else console.log(`  第 ${i + 1} 段 ✅ mode=${r.mode} aligned=${r.aligned} 逐句=${r.sentences ? r.sentences.length : 0} | ${String(r.translation).slice(0, 60)}…`);
  });

  // 4. 划词翻译（短句，走 translateText）
  t0 = Date.now();
  const sel = await tr.translateText('We adopt a space-time memory network for video object segmentation.');
  console.log(`\n=== T4 translateText（划词）=== ${Date.now() - t0}ms`);
  console.log('  ', sel);

  // 5. 照搬原文的防护：给一段"不需要翻译"的内容，看是否如实报错而不是照抄
  t0 = Date.now();
  try {
    const r5 = await tr.translateParagraph(
      'Seoung Wug Oh, Joon-Young Lee, Ning Xu, Seon Joo Kim',
      ['Seoung Wug Oh, Joon-Young Lee, Ning Xu, Seon Joo Kim']
    );
    console.log(`\n=== T5 作者名单（无需翻译）=== ${Date.now() - t0}ms`);
    console.log('  未报错，返回:', r5.translation.slice(0, 80));
    console.log('  → 人名本来就不该翻译，返回原文属正常');
  } catch (e) {
    console.log(`\n=== T5 作者名单 === ${Date.now() - t0}ms`);
    console.log('  抛错（会被显示为"未通过校验"）:', e.message);
  }
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
