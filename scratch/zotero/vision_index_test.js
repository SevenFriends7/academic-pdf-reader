/**
 * 视觉回包编号兜底 + 标题强制翻译的回归测试。
 *
 * 两个 bug 都是从**用户真实数据**里发现的（2026-10-04）：
 *   ① 视觉模型回来的 segment 没有 `i` 字段 → 8 条纠错全被丢弃 → 论文标题/作者块一直是 body
 *      → 被 looksNonProse 当成"非叙述内容"原样保留 → 界面上"译文"就是英文原文。
 *   ② `looksNonProse` 对 <60 字符的串一律判"标签" → 论文标题（41 字符）与 "Abstract" 永不翻译。
 *
 * 【测试口径说明（为什么不直接 new Function 跑真方法）】
 * 第一版想把 translator.ts 里的 `toVisionResult` 抽出来直接执行，但抽取按大括号配对，
 * 被**参数类型里的对象字面量**（`usage?: { promptTokenCount?: number }`）提前截断，
 * 三次都没配对成功。硬啃类型标注不划算，所以改成两层：
 *   A. **源码断言**：把"必须存在/必须不存在"的关键条件钉死（防回归的主力）；
 *   B. **逻辑复现**：把兜底判据用纯 JS 重写一遍，用真实回包数据验证它的行为契约。
 * 文件里明确标注每条属于哪一层，不把 A 层说成"跑过真代码"。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const TS = fs.readFileSync(path.join(ROOT, 'src', 'translator.ts'), 'utf8');
const VIEWER = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}\n     ${(e && e.message) || e}`);
    console.log(`  ❌ ${name}\n     ${(e && e.message) || e}`);
  }
}

console.log('===== A 层：源码断言（防回归）=====\n');

t('编号兜底：存在"位置对齐"的三条前提（无显式 i、条数一致、expectedSegmentCount 有效）', () => {
  assert.ok(/const anyExplicitIndex = rawSegs\.some/.test(TS), '必须有"是否存在显式编号"的判断');
  assert.ok(
    /rawSegs\.length === expectedSegmentCount/.test(TS),
    '必须校验"回包条数 === 请求条数"，否则按位置对齐会把类型安到别的段上'
  );
  assert.ok(/typeof expectedSegmentCount === 'number'/.test(TS), '必须校验 expectedSegmentCount 有效');
});

t('编号兜底：段落编号取显式值，缺失时才回退到数组下标', () => {
  assert.ok(
    /const i = Number\.isFinite\(explicit\) \? explicit : positionalOk \? si : NaN;/.test(TS),
    '编号取值必须是"显式优先、缺失才按位置"'
  );
});

t('旧写法已被移除：不再"拿不到编号就 continue"（那正是整页纠错失效的原因）', () => {
  assert.ok(
    !/const i = Number\(s\?\.i \?\? s\?\.index\);\s*\n\s*if \(!Number\.isFinite\(i\)\) continue;/.test(TS),
    '不能再无条件丢弃没有编号的 segment'
  );
});

t('放弃纠错时必须留日志（否则以后又只能靠猜）', () => {
  assert.ok(/放弃本次纠错/.test(TS), '条数不一致放弃时要打日志');
});

t('调用点把请求条数传了下去', () => {
  assert.ok(
    /toVisionResult\(res\.text, res\.model, Date\.now\(\) - startedAt, res\.usage, opts\.segments\.length\)/.test(TS),
    'parseVision 必须把 opts.segments.length 传进去，否则兜底永远不触发'
  );
});

t('标题直通：短路条件改成"未强制 且 判为非叙述"', () => {
  assert.ok(
    /if \(!opts\?\.forceTranslate && this\.looksNonProse\(trimmed\)\)/.test(TS),
    '否则标题仍会被 looksNonProse 短路成英文原文'
  );
  assert.ok(/forceTranslate\?: boolean/.test(TS), 'translateParagraph 的 opts 必须声明 forceTranslate');
});

t('批量路径逐项透传 forceTranslate（批量翻译时标题也要直通）', () => {
  const n = (TS.match(/forceTranslate: inputs\[i\]\.forceTranslate/g) || []).length;
  assert.ok(n >= 3, `三处 translateParagraph 调用都要透传，实际 ${n} 处`);
  assert.ok(
    /inputs: \{ text: string; sentences: string\[\]; forceTranslate\?: boolean \}\[\]/.test(TS),
    '批次输入类型必须带 forceTranslate'
  );
});

t('宿主把 forceTranslate 从消息接到队列、再接到批量调用', () => {
  const P = fs.readFileSync(path.join(ROOT, 'src', 'pdfEditorProvider.ts'), 'utf8');
  assert.ok(/forceTranslate: forceTranslate === true/.test(P), 'requestTranslate 分支要解析该字段');
  assert.ok(/forceTranslate\?: boolean;/.test(P), '队列元素类型要带该字段');
  assert.ok(
    /batch\.map\(b => \(\{ text: b\.text, sentences: b\.sentences, forceTranslate: b\.forceTranslate \}\)\)/.test(P),
    '批量调用要逐项透传'
  );
});

t('webview 对 title/abstract/heading/keywords 置 forceTranslate=true 并发出', () => {
  assert.ok(
    /const forceTranslate =\s*para\.type === 'title' \|\| para\.type === 'abstract' \|\| para\.type === 'heading' \|\| para\.type === 'keywords'/.test(
      VIEWER
    ),
    '标题类段落必须置位'
  );
  assert.ok(/forceTranslate: forceTranslate/.test(VIEWER), '必须真的放进 postMessage');
});

t('图表内部标签默认折叠，并且有展开按钮', () => {
  assert.ok(/figlabel-toggle/.test(VIEWER), '要有展开/收起按钮');
  assert.ok(/data-figlabel-body="\$\{pid\}" style="display:none"/.test(VIEWER), '默认必须是收起状态');
  assert.ok(/function toggleFigureLabel\(/.test(VIEWER), '要有切换函数');
  assert.ok(
    /e\.target\.closest\('\[data-figlabel-toggle\]'\)/.test(VIEWER),
    '点击必须走事件委托（卡片会重绘，单独 bind 会丢）'
  );
});

console.log('\n===== B 层：用真实回包数据验证兜底判据的行为契约 =====\n');

/**
 * 把兜底判据按同一逻辑重写一遍（纯 JS）。
 * 它验证的是"这套判据在真实数据上的行为"，不是"真函数被执行"——两条口径分开写清楚。
 */
function alignSegments(rawSegs, expectedSegmentCount) {
  const anyExplicitIndex = rawSegs.some(s => Number.isFinite(Number(s && (s.i != null ? s.i : s.index))));
  const positionalOk =
    !anyExplicitIndex &&
    typeof expectedSegmentCount === 'number' &&
    expectedSegmentCount > 0 &&
    rawSegs.length === expectedSegmentCount;
  const out = [];
  for (let si = 0; si < rawSegs.length; si++) {
    const s = rawSegs[si];
    const explicit = Number(s && (s.i != null ? s.i : s.index));
    const i = Number.isFinite(explicit) ? explicit : positionalOk ? si : NaN;
    if (!Number.isFinite(i)) continue;
    out.push({ index: i, type: s.type, action: s.action || 'keep' });
  }
  return { segments: out, positionalOk };
}

// 真值取样：用户 AOT 第 1 页视觉缓存的实际回包（8 条，全部没有 i）
const AOT_P1 = [
  { type: 'title', action: 'keep', why: '标题首行' },
  { type: 'title', action: 'keep', why: '标题二行非元数据' },
  { type: 'metadata', action: 'keep', why: '作者与单位' },
  { type: 'abstract', action: 'keep', why: '摘要整块' },
  { type: 'heading', action: 'keep', why: '一级标题' },
  { type: 'body', action: 'keep', why: '正文段' },
  { type: 'body', action: 'keep', why: '正文段' },
  { type: 'body', action: 'split', why: '末混入会议脚注' }
];

t('【真 bug 复现】8 条无编号回包 + 请求 8 段 → 全部保留且按位置对齐', () => {
  const r = alignSegments(AOT_P1, 8);
  assert.strictEqual(r.positionalOk, true);
  assert.strictEqual(r.segments.length, 8, '旧逻辑这里会得到 0 条（整页纠错失效）');
  assert.deepStrictEqual(r.segments.map(s => s.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.strictEqual(r.segments[0].type, 'title');
  assert.strictEqual(r.segments[2].type, 'metadata');
  assert.strictEqual(r.segments[7].action, 'split');
});

t('条数不等 → 拒绝按位置猜（宁可不改，也不把类型安到别的段上）', () => {
  const r = alignSegments([{ type: 'title' }, { type: 'body' }], 8);
  assert.strictEqual(r.positionalOk, false);
  assert.strictEqual(r.segments.length, 0);
});

t('模型给了 i 时以显式编号为准，数组顺序不作数', () => {
  const r = alignSegments([{ i: 2, type: 'metadata' }, { i: 0, type: 'title' }, { i: 1, type: 'title' }], 3);
  assert.deepStrictEqual(r.segments.map(s => s.index), [2, 0, 1]);
});

t('一半有编号一半没有 → 只接收有编号的（不混用两套对齐）', () => {
  const r = alignSegments([{ i: 0, type: 'title' }, { type: 'body' }], 2);
  assert.deepStrictEqual(r.segments.map(s => s.index), [0]);
});

t('没有 expectedSegmentCount（旧调用方）→ 不做位置兜底', () => {
  const r = alignSegments([{ type: 'title' }], undefined);
  assert.strictEqual(r.segments.length, 0);
});

// ---- looksNonProse 行为（用纯函数复现判据的关键分支）----
function looksNonProse(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/[.!?。！？]["'”’)\]]?\s*$/.test(s)) return false;
  if (/^(\d+(\.\d+)*\.?|[IVXLC]+\.)\s+\S/.test(s)) return false;
  if (s.length > 60) return true; // 简化：真实实现还会看"是不是从句流"
  return s.length < 60;
}

t('判据未变：标题与 "Abstract" 仍会被判成"非叙述"（这才是需要 forceTranslate 的原因）', () => {
  assert.strictEqual(looksNonProse('Associating Objects with Transformers for'), true);
  assert.strictEqual(looksNonProse('Video Object Segmentation'), true);
  assert.strictEqual(looksNonProse('Abstract'), true);
});

t('真正文不会被误伤（有句末标点 → 照常翻译）', () => {
  assert.strictEqual(looksNonProse('We propose a novel solution for video object segmentation.'), false);
  assert.strictEqual(looksNonProse('2. Related Work'), false, '章节标题必须照常翻译');
});

t('forceTranslate 的语义 = 跳过该判据（标题直通）', () => {
  const shouldShortCircuit = (text, forceTranslate) => !forceTranslate && looksNonProse(text);
  assert.strictEqual(shouldShortCircuit('Abstract', true), false, '标题类：直通，真翻');
  assert.strictEqual(shouldShortCircuit('Abstract', false), true, '普通段：仍按原判据短路');
  assert.strictEqual(shouldShortCircuit('Adobe Research', false), true, '机构块：仍然不翻（预期行为）');
});

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  - ' + f));
}
process.exitCode = fail ? 1 : 0;
