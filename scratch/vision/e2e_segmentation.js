/**
 * 端到端验证「视觉分割」：用**我们自己的实现**（PaperTranslator.segmentPageWithVision）
 * 对真实的第 4 页做一次判断，并打印"本地类型 → 视觉类型"的逐条对照。
 *
 * 用法：node scratch/vision/e2e_segmentation.js [视觉模型名]
 * 会真实调用一次 API（约 2~3k token）。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const VISION_MODEL = process.argv[2] || 'deepseek-flash';

const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Code', 'User', 'settings.json'), 'utf8'));
const conf = {
  translationService: 'openai-compatible',
  apiEndpoint: settings['academicReader.apiEndpoint'] || 'https://api.deepseek.com/v1',
  apiKey: settings['academicReader.apiKey'],
  modelName: settings['academicReader.modelName'] || 'deepseek-chat',
  visionModel: VISION_MODEL,
  visionMaxTokens: Number(process.env.VISION_TOKENS || 8000)
};
if (!conf.apiKey) {
  console.error('设置里没有 academicReader.apiKey');
  process.exit(2);
}

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

// 编译我们自己的实现（走真实代码，不是复刻）
const esbuild = require('esbuild');
const buildDir = path.join(ROOT, 'scratch', '.build');
fs.mkdirSync(buildDir, { recursive: true });
const bundle = path.join(buildDir, 'translator.cjs');
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src', 'translator.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: bundle,
  external: ['vscode'],
  logLevel: 'error'
});
const { PaperTranslator } = require(bundle);

// 真实的第 4 页分段（本地结果）
const storeDir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
const newest = fs
  .readdirSync(storeDir)
  .filter(f => f.startsWith('paper_') && f.endsWith('.json'))
  .map(f => ({ f, t: fs.statSync(path.join(storeDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0].f;
const paper = JSON.parse(fs.readFileSync(path.join(storeDir, newest), 'utf8'));
const local = ((paper.pageArchive || {})['4'] || []).map(p => ({
  id: p.id,
  type: p.type,
  text: p.cleanText || ''
}));

const imageBase64 = fs.readFileSync(path.join(__dirname, 'p4_full.png')).toString('base64');

(async () => {
  console.log(`视觉模型：${VISION_MODEL}　端点：${conf.apiEndpoint}　Key：已读取（不打印）\n`);
  console.log('本地分段：');
  local.forEach(p => console.log(`  [${p.id}] ${String(p.type).padEnd(10)} ${p.text.replace(/\s+/g, ' ').slice(0, 60)}`));

  const t = new PaperTranslator(m => console.log('  · ' + m));
  const t0 = Date.now();
  const r = await t.segmentPageWithVision({
    imageBase64,
    mimeType: 'image/jpeg',
    pageNum: 4,
    segments: local
  });

  console.log(`\n✅ 视觉判断完成：${((Date.now() - t0) / 1000).toFixed(1)}s ｜ 模型 ${r.model} ｜ 用量 ${JSON.stringify(r.usage || {})}`);
  console.log(`栏数：${r.columns ?? '(未给)'}　模型自述：${r.fixes || '(无)'}\n`);

  const byId = new Map(r.segments.map(s => [Number(s.index), s]));
  console.log('逐条对照（本地 → 视觉）：');
  local.forEach(p => {
    const s = byId.get(p.id);
    const same = s && s.type === p.type;
    console.log(
      `  [${p.id}] ${String(p.type).padEnd(10)} → ${(s?.type || '?').padEnd(15)} order=${s?.order ?? '-'} action=${s?.action ?? '-'} ${same ? '' : '← 改动'} ${s?.why ? '｜' + s.why : ''}`
    );
  });
  const changed = local.filter(p => byId.get(p.id) && byId.get(p.id).type !== p.type).length;
  const drops = r.segments.filter(s => s.action === 'drop').length;
  const merges = r.segments.filter(s => s.action === 'merge_next').length;
  const splits = r.segments.filter(s => s.action === 'split').length;
  console.log(`\n汇总：类型改动 ${changed} 处 ｜ 建议丢弃 ${drops} ｜ 建议合并 ${merges} ｜ 建议拆分 ${splits}`);

  fs.writeFileSync(path.join(__dirname, 'e2e_result.json'), JSON.stringify({ local, vision: r }, null, 2), 'utf8');
  console.log('原始结果已存：scratch/vision/e2e_result.json');
})();
