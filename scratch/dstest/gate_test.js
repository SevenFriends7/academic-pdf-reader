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

console.log('\n[5] "非叙述内容"判据：被切开的正文片段必须照常翻译');
// 【真实反馈】第 4 页有两个正文片段（以 ":" / "," 结尾、通篇没有句末标点）被这条判据
// 误判成"人名/机构/图表标签"，于是宿主**一次 API 都没调**，直接把英文原文当译文写进缓存——
// 用户看到的就是"这一段的译文是英文原文"。视觉手术把"正文+公式+正文"拆开之后，这种片段会变多。
const PROSE_FRAGMENT_1 =
  'With the cyclic reference set, we can obtain the prediction for the initial reference mask in the same manner as sequential processing:';
const PROSE_FRAGMENT_2 =
  'In implementation, we utilize the combination of cross-entropy loss and mask IOU loss as supervision at both sides of the cyclic loop, which can be formulated as,';
check('以冒号结尾的正文片段 → 照常翻译', t.looksNonProse(PROSE_FRAGMENT_1) === false, `looksNonProse=${t.looksNonProse(PROSE_FRAGMENT_1)}`);
check('以逗号结尾的正文片段 → 照常翻译', t.looksNonProse(PROSE_FRAGMENT_2) === false, `looksNonProse=${t.looksNonProse(PROSE_FRAGMENT_2)}`);
// 反例：这些本来就该"原样保留"，不能被误伤（改了判据之后仍必须为 true）
check('单个词 / 图内标签簇 → 仍不翻译', t.looksNonProse('Method') === true && t.looksNonProse('Segmentation Network Loss Key Value Memory') === true);
check('表格表头（有括号数字但无逗号无虚词）→ 仍不翻译', t.looksNonProse('Extra data OL J S (%) J U (%) F S (%) F U (%) G (%) FPS') === true);
check('论文标题（大写词占多数）→ 仍不翻译', t.looksNonProse('Delving into the Cyclic Mechanism in Semi-supervised Video Object Segmentation') === true);
check('公式残渣 / 脚注符号 → 仍不翻译', t.looksNonProse('| Ω | ̂') === true && t.looksNonProse('∗ †') === true);

console.log('\n[6] 历史假译文的定向清理（只在目标语言是中文时动手）');
const fakeCache = {
  translations: {
    A: PROSE_FRAGMENT_1, // 原文当译文（假）
    B: '图2：分割网络在训练和推理阶段所提出的循环机制概览。', // 真译文
    C: 'Extra data OL J S (%) J U (%) F S (%) F U (%) G (%) FPS', // 表头原样保留（合法）
    D: 'Delving into the Cyclic Mechanism in Semi-supervised Video Object Segmentation' // 标题原样保留（合法）
  },
  sentenceTranslations: { A: [PROSE_FRAGMENT_1] },
  alignment: {
    A: { note: '该段像是人名/机构/图表标签等非叙述内容，已原样保留（未调用翻译接口）' },
    B: { note: '' },
    C: { note: '' },
    D: { note: '' }
  }
};
const prunedCount = t.pruneStaleNonProseCache(fakeCache);
check('原文当译文的条目被清掉', prunedCount === 1 && !fakeCache.translations.A && !fakeCache.alignment.A, `pruned=${prunedCount}`);
check('真译文与"合法的原样保留"（表头/标题）一条都没动', !!fakeCache.translations.B && !!fakeCache.translations.C && !!fakeCache.translations.D);
check('幂等：再清理一次为 0', t.pruneStaleNonProseCache(fakeCache) === 0);

console.log('\n[7] 译文里的 LaTeX 不能被当成"没翻译"');
// 提示词现在要求模型把公式转写成 $...$ 的 LaTeX。若闸门照旧数字母，`\mathcal`/`\hat` 这些
// 命令名会把"汉字/(汉字+字母)"拉到阈值以下，含公式的中文译文就会吃一个"疑似未翻译"的红框。
const LATEX_ZH_SHORT = '$\\mathcal{L}_{cycle,t} = \\frac{1}{|\\Omega|}\\sum_{u \\in \\Omega} \\min(Y_{t,u}, Y_{t,u})$ 见前文。';
check('公式很长、中文很短的译文 → 仍然通过（剥掉 LaTeX 后中文占比 100%）', gate(FORMULA_SET, LATEX_ZH_SHORT) === null, String(gate(FORMULA_SET, LATEX_ZH_SHORT)));
const strippedLatex = t.stripLatexForCounting(LATEX_ZH_SHORT);
check('剥掉 LaTeX 后既没有 $ 也没有 \\command', !/\$/.test(strippedLatex) && !/\\[a-zA-Z]/.test(strippedLatex), JSON.stringify(strippedLatex));
check('$$...$$ 与 \\(...\\) 也一并剥掉', !/\$|\\\(|\\\)/.test(t.stripLatexForCounting('行内 $$x=1$$ 与 \\(y=2\\) 结束')));
check(
  '漏洞要堵住：抄一遍原文再补个 $x$ 仍算照搬（相似度拿剥完 LaTeX 的译文比）',
  /照搬|疑似/.test(String(gate(BODY_SRC, `${BODY_SRC} $x$`))),
  String(gate(BODY_SRC, `${BODY_SRC} $x$`))
);

console.log('\n[8] 接线：提示词要求 LaTeX、译文行走公式渲染');
const translatorSrc = fs.readFileSync(path.join(ROOT, 'src', 'translator.ts'), 'utf8');
const viewerSrc = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');
check(
  '所有翻译提示词共用同一条 LaTeX 规则（不再是六处各写一句）',
  /const FORMULA_LATEX_RULE/.test(translatorSrc) && (translatorSrc.match(/\$\{FORMULA_LATEX_RULE\}/g) || []).length >= 5,
  `引用了 ${(translatorSrc.match(/\$\{FORMULA_LATEX_RULE\}/g) || []).length} 处`
);
check('规则本身明确要求 $...$ 包起来', /\$\.\.\.\$/.test(translatorSrc) && /不要保留/.test(translatorSrc));
check('旧的"公式原样保留"要求已全部删除（那等于命令模型抄残渣）', !/公式、数学符号、变量名、缩写、文献引用编号原样保留/.test(translatorSrc));
check('闸门会先剥 LaTeX 再判语言与相似度', /stripLatexForCounting/.test(translatorSrc) && /similarity\(source, oPlain\)/.test(translatorSrc));
check(
  '译文行走公式渲染（逐句两处 + 连贯段落一处）',
  (viewerSrc.match(/sent-zh">\$\{renderEnTextHtml\(/g) || []).length === 2 && /zh-paragraph-plain">\$\{renderEnTextHtml\(/.test(viewerSrc)
);

console.log('\n[9] 专家模式：整篇上下文 + 不限篇幅');
{
  const whole = `【第 1 页】\n我们提出 cycle-ERF……\n${'x'.repeat(200)}`;
  const p = t.buildAssistantPrompt({ question: '这篇论文的核心方法是什么？', selectedText: '', wholePaper: whole, answerStyle: 'expert' });
  check('整篇全文进了提示词（不只当前段 + 检索片段）', p.includes('论文全文') && p.includes('cycle-ERF'));
  check('专家档明确要求"不限篇幅 / 深度优先"', /不限篇幅/.test(p) && /深度优先/.test(p));
  check('涉及本文事实只能依据全文、严禁编造', /严禁编造/.test(p));
  check(
    '输出上限：专家 > 标准 > 简洁（专家等于接口上限，不再人为压到 4096）',
    t.assistantMaxTokens('expert') > t.assistantMaxTokens('standard') &&
      t.assistantMaxTokens('standard') > t.assistantMaxTokens('concise') &&
      t.assistantMaxTokens('expert') >= 16384,
    `expert=${t.assistantMaxTokens('expert')} standard=${t.assistantMaxTokens('standard')} concise=${t.assistantMaxTokens('concise')}`
  );
  check(
    '旧档位 reviewer 归一为 expert，空值回落 standard',
    t.normalizeAnswerStyle('reviewer') === 'expert' &&
      t.normalizeAnswerStyle('expert') === 'expert' &&
      t.normalizeAnswerStyle('') === 'standard' &&
      t.normalizeAnswerStyle('乱写的') === 'standard'
  );
  const long = t.buildWholePaperContext('Y'.repeat(70000));
  check('全文过长时截断，并如实说明"后面部分未提供"', long.length < 70000 && /已截断/.test(long), `${long.length} 字`);
  const fallback = t.buildWholePaperContext('');
  check('拿不到现抽全文时回退到逐页索引（不报错）', typeof fallback === 'string');
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
