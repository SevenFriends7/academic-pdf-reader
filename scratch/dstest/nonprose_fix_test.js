/**
 * 用**真实数据**验证两处修复（不调用任何 API）：
 *
 * ① 宿主侧 looksNonProse() 不再把"被切开的正文片段"当成图表标签（否则那段会"原样保留"=没翻译）；
 *    —— 样本取自用户真实反馈：cycle.pdf 第 4 页那两段以 `:` / `,` 结尾的正文片段。
 * ② pruneStaleNonProseCache() 只清掉"原文当译文"的历史假缓存，标题/机构/图注/公式残渣一个不动。
 *    —— 直接跑用户 globalStorage 里的真实论文数据（只读，不写回）。
 *
 * 用法：node scratch/dstest/nonprose_fix_test.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');

// 把 TS 现编成 CJS（translator.ts 依赖 vscode，用桩顶掉）
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

const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  window: {},
  Uri: {},
  ProgressLocation: { Notification: 15 }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const { PaperTranslator } = require(bundle);
Module._load = origLoad;

let fail = 0;
function check(label, ok, extra) {
  if (!ok) fail++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
}

const t = new PaperTranslator(() => {});
/** looksNonProse 是私有的：这里按 JS 的运行时语义直接取（测的是真实实现，不是复刻） */
const looksNonProse = s => t.looksNonProse(s);

console.log('\n[1] 被切开的正文片段不能再被判成"非叙述内容"');
const proseFragments = [
  // 用户真实反馈：这两段的"译文"曾经是英文原文
  'With the cyclic reference set, we can obtain the prediction for the initial reference mask in the same manner as sequential processing:',
  'In implementation, we utilize the combination of cross-entropy loss and mask IOU loss as supervision at both sides of the cyclic loop, which can be formulated as,',
  'For the sake of mitigating error propagation during training, we incorporate the cyclical process into the offline training process to explicitly bridge the relationship between the initial reference and',
  'This is a long sentence without any terminal punctuation but with commas, and it clearly is prose'
];
proseFragments.forEach(s =>
  check(`正文片段 → 送去翻译：${s.slice(0, 46)}…`, looksNonProse(s) === false, `looksNonProse=${looksNonProse(s)}`)
);

console.log('\n[2] 真正的标签/机构/公式残渣仍然不翻译（不能被误伤）');
const stillNonProse = [
  ['Method', '单个词'],
  ['Extra data OL J S (%) J U (%) F S (%) F U (%) G (%) FPS', '表格表头（无逗号无虚词）'],
  ['Segmentation Network Loss Key Value Key Value Memory Past frames Read First', '图内标签簇'],
  ['Delving into the Cyclic Mechanism in Semi-supervised Video Object Segmentation', '论文标题（大写词占多数）'],
  ['| Ω | ̂', '公式残渣'],
  ['∗ †', '脚注符号'],
  ['Zhejiang University, Hangzhou, China', '机构（无虚词比例支撑）']
];
stillNonProse.forEach(([s, why]) => check(`${why} → 保持不翻译：「${s.slice(0, 40)}」`, looksNonProse(s) === true, `looksNonProse=${looksNonProse(s)}`));

console.log('\n[3] 用真实的论文缓存验证定向清理');
const dir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
if (!fs.existsSync(dir)) {
  console.log('   ⚠️  找不到 globalStorage，跳过真实数据核对');
} else {
  /*
   * 【必须挑"含有这些键的那份存档"，不能拿最新的】
   * 这条测试验的是真实数据上的一次清理（键是内容指纹，只属于 cycle.pdf）。
   * 原先取"mtime 最新的存档"，但用户随手翻另一篇论文（AOT/STM）就会把最新的换成别的，
   * 那几个键自然找不到 → 测试变红，看着像代码坏了，其实是数据指错了。
   * 现在改成"在所有存档里找**含目标键**的那一份"，找不到才回退到最新的一份。
   */
  const allPapers = fs
    .readdirSync(dir)
    .filter(f => f.startsWith('paper_') && f.endsWith('.json'))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const probeKeys = ['4_74b30526_d0790fd7-135', '4_74b30526_1bc10d44-162'];
  const newest =
    (allPapers.find(p => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, p.f), 'utf8'));
        return probeKeys.every(k => j.translations && j.translations[k] !== undefined);
      } catch (e) {
        return false;
      }
    }) || allPapers[0]).f;
  const paper = JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8'));
  const before = {
    translations: Object.keys(paper.translations || {}).length,
    align: Object.keys(paper.alignment || {}).length
  };
  // 只读一份副本，绝不写回用户数据
  const copy = JSON.parse(JSON.stringify(paper));
  const pruned = t.pruneStaleNonProseCache(copy);
  console.log(`   存档 ${newest}：清理前 translations ${before.translations} 条，清理掉 ${pruned} 条`);

  const poisoned = ['4_74b30526_d0790fd7-135', '4_74b30526_1bc10d44-162'];
  /*
   * 【判据要拿"值"而不是"键"】旧的假译文被清掉后，webview 会重新翻译同一段，
   * 于是**同一个键**又会带着中文回来（键是内容指纹，本来就是同一个）。
   * 所以这里验的是"值不再是英文原文"，不是"键不存在"——我第一版就是这么写错的。
   */
  const stillFake = poisoned.filter(k => {
    const v = String(copy.translations[k] || '');
    if (!v) return false;
    return (v.match(/[\u4e00-\u9fff]/g) || []).length === 0;
  });
  check(
    '两条"原文当译文"的记录已不存在（值已是中文；键相同是正常的，重新翻译会写回同一个键）',
    stillFake.length === 0,
    poisoned.map(k => `${k.slice(-18)}=${JSON.stringify(String(copy.translations[k] || '(无)').slice(0, 26))}`).join('  ')
  );
  check(
    '重新翻译后的值确实是中文',
    poisoned.every(k => ((String(copy.translations[k] || '').match(/[\u4e00-\u9fff]/g) || []).length >= 5))
  );
  // 真标题（id0）与表格表头（p6 id6）不能被清：它们本来就该原样保留
  const mustKeep = Object.keys(paper.translations || {}).filter(k => {
    const a = (paper.alignment || {})[k];
    return a && String(a.note || '').indexOf('未调用翻译接口') >= 0;
  });
  const wronglyRemoved = mustKeep.filter(k => !copy.translations[k] && !poisoned.includes(k));
  check(
    '真正该"原样保留"的条目一条都没被误删（标题/机构/图注/公式残渣）',
    wronglyRemoved.length === 0,
    wronglyRemoved.map(k => `${k}:${String(paper.translations[k]).slice(0, 26)}`).join(' | ')
  );
  check(
    '标题/表头这类"原文=译文"的合法条目仍在（没有从句结构，不该被当成散文）',
    ['1_74b30526_a1a58980-36', '6_74b30526_43f41cda-55'].every(k => !!copy.translations[k]),
    ['1_74b30526_a1a58980-36', '6_74b30526_43f41cda-55'].map(k => `${k}=${copy.translations[k] ? '在' : '被删了'}`).join(' ')
  );
  check('幂等：再清理一次不会再删任何东西', t.pruneStaleNonProseCache(copy) === 0);

  // 目标语言不是中文时一律不动（否则会把"翻成英文"的正常结果删掉）
  const copy2 = JSON.parse(JSON.stringify(paper));
  const origCfg = t.cfg.bind(t);
  t.cfg = () => ({ get: (_k, d) => (_k === 'targetLanguage' ? 'en' : d) });
  const prunedEn = t.pruneStaleNonProseCache(copy2);
  t.cfg = origCfg;
  check('目标语言是英文时不清理（避免误删正常译文）', prunedEn === 0, `pruned=${prunedEn}`);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项没通过`}`);
process.exit(fail === 0 ? 0 : 1);
