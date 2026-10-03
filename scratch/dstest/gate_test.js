/**
 * 译文质量闸门测试（`npm run test:gate`）。
 *
 * 为什么单独测它：这道闸门决定"译文要不要被判成未翻译"，判严了会把**公式段落**
 * 冤枉成失败（用户真实反馈："公式它就识别为未翻译"），判松了会让"模型把原文照抄回来"
 * 悄悄过关。两类错误都很难在界面上肉眼发现，必须用真实文本钉住。
 *
 * 用真实数据取的样本（cycle.pdf 第 4 页，见 CHANGELOG 1.0.3）：
 *   · 旧判据「汉字 / 非空字符」把一段正常译文算成 47%，差点被 25% 的阈值拦下；
 *     换成「汉字 / (汉字+字母)」后同一段是 73%。
 *   · 纯符号段 `| Ω | ̂` 与集合记号段本来就不该送翻译。
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

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) pass++;
  else fail++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
}

const t = new PaperTranslator(() => {});
const gate = (src, out) => t.checkTranslationSanity(src, out, 'zh-CN');
const density = (s) => t.mathDensity(s);

/** 旧判据：汉字 / 非空字符（公式符号也算分母） */
const oldRatio = (out) => {
  const ns = out.replace(/\s/g, '').length;
  return ns === 0 ? 0 : (out.match(/[\u4e00-\u9fff]/g) || []).length / ns;
};
/** 新判据：汉字 / (汉字 + 拉丁字母) */
const fairRatio = (out) => {
  const cjk = (out.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (out.match(/[A-Za-z]/g) || []).length;
  return cjk + latin === 0 ? 0 : cjk / (cjk + latin);
};
const pct = (r) => `${Math.round(r * 100)}%`;

console.log('===== 译文质量闸门测试 =====');

// ---------------------------------------------------------------- 真实样本
const CAPTION_SRC =
  'Figure 2: Overview of the proposed cyclic mechanism in both training and inference stages of the segmentation network. For simplicity, we take the situation where X t - 1 = { X 1 } and Y t - 1 = { Y 1 } as an example.';
const CAPTION_ZH =
  '图2：分割网络在训练和推理阶段所提出的循环机制概览。为简单起见，我们以 X t − 1 = { X 1 }、Y t − 1 = { Y 1 } 的情况为例。';
const BODY_SRC =
  'With the cyclic reference set, we can obtain the prediction for the initial reference mask in the same manner as sequential processing:';
const BODY_ZH =
  '利用循环参考集，我们可以按照与顺序处理相同的方式获得初始参考掩码的预测：';
const FORMULA_ONLY = '| Ω | ̂';
const FORMULA_SET = 'X ̂ t ⊂ { X ̂ i | i ∈ [2, t] }, Y ̂ t ⊂ { Y i | i ∈ [2, t] }.';

console.log('\n[1] 正常译文必须通过（含大量原样保留的公式/符号）');
check('图表题注（公式符号很多）通过', gate(CAPTION_SRC, CAPTION_ZH) === null, String(gate(CAPTION_SRC, CAPTION_ZH)));
check('正文段通过', gate(BODY_SRC, BODY_ZH) === null, String(gate(BODY_SRC, BODY_ZH)));
check(
  '公平分母让同一段译文的"中文占比"显著提高（这就是公式段被冤枉的根因）',
  fairRatio(CAPTION_ZH) - oldRatio(CAPTION_ZH) > 0.15,
  `题注：旧 ${pct(oldRatio(CAPTION_ZH))} → 新 ${pct(fairRatio(CAPTION_ZH))}；` +
    `正文：旧 ${pct(oldRatio(BODY_ZH))} → 新 ${pct(fairRatio(BODY_ZH))}`
);
check('数学密度：题注 0.09、集合记号 0.54、纯符号 1.00', density(CAPTION_SRC) < 0.15 && density(FORMULA_SET) > 0.5 && density(FORMULA_ONLY) === 1);

console.log('\n[2] 公式段落不该被判成"未翻译"');
check('公式密集段落原样返回 → 放过（不报错）', gate(FORMULA_SET, FORMULA_SET) === null, String(gate(FORMULA_SET, FORMULA_SET)));
check('纯符号段原样返回 → 放过', gate(FORMULA_ONLY, FORMULA_ONLY) === null, String(gate(FORMULA_ONLY, FORMULA_ONLY)));
check(
  '公式密集段落只译出一半内容 → 也放过（阈值放宽到 12%）',
  gate(FORMULA_SET, 'X ̂ t 是集合记号 ⊂ { X ̂ i } 的写法') === null,
  String(gate(FORMULA_SET, 'X ̂ t 是集合记号 ⊂ { X ̂ i } 的写法'))
);

console.log('\n[3] 真正的"没翻译/照抄"必须拦住');
check('散文段原样照抄 → 拦住', gate(BODY_SRC, BODY_SRC) === '译文与原文几乎完全相同（疑似照搬原文）', String(gate(BODY_SRC, BODY_SRC)));
check('散文段只返回英文 → 拦住并说明比例', /疑似未翻译/.test(String(gate(BODY_SRC, 'the cyclic reference set is used'))), String(gate(BODY_SRC, 'the cyclic reference set is used')));
check('空译文 → 拦住', gate(BODY_SRC, '   ') === '译文为空');
check('目标语言不是中文时不做判断（避免中→英误报）', t.checkTranslationSanity(BODY_SRC, BODY_SRC, 'en') === null);
check('源文本本身是中文时不做判断', gate('这是一段中文原文。', '这是一段中文原文。') === null);
check('字母太少（编号/纯缩写）不做判断', gate('Eq. (2)', 'Eq. (2)') === null);

console.log('\n[4] 公平分母的边界（用程序化计数构造，避免手数字符出错）');
const ZH_13 = '循环参考集用于初始掩码预测'; // 13 个汉字
const HALF = `${ZH_13} abcdefghijklm`; // 13 字母 → 恰好 50%
const LOW = `${ZH_13} abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd`; // 56 字母 → ~19%
check(`汉字占字母+汉字 ${pct(fairRatio(HALF))} → 通过`, fairRatio(HALF) >= 0.25 && gate(BODY_SRC, HALF) === null);
check(
  `汉字占字母+汉字 ${pct(fairRatio(LOW))} → 拦住`,
  fairRatio(LOW) < 0.25 && /疑似未翻译/.test(String(gate(BODY_SRC, LOW))),
  String(gate(BODY_SRC, LOW))
);

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
