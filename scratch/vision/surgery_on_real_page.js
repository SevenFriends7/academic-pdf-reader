/**
 * 在**真实数据**上离线跑一次"视觉手术"——不发任何 API 请求。
 *
 * 素材：
 *   · 本地分段：scratch/vision/probe_v2_result.json 里的 localSegments
 *     （就是 cycle.pdf 第 4 页真实的本地分段，含 "Y ̂ t" 这种带组合抑扬符的残渣文本）
 *   · 模型回包：同一个文件里的 rawResponse（deepseek-flash 针对该页的真实 v2 回包）
 * 代码：从 media/viewer.js 里**抽出来的真实 visionSurgery**（不是复刻一份逻辑）。
 *
 * 验的是三件在真实文本上才容易出问题的事：
 *   ① 锚点能不能在真实残渣文本里定位到（定位不到就该跳过，不许乱切）；
 *   ② 拆完/合完之后 charMap 是否仍与 cleanText 严格 1:1、逐句下标是否仍自洽；
 *   ③ 文本守恒：结果里不该多出字、也不该丢字（合并折行时去掉的连字符除外）。
 *
 * 用法：node scratch/vision/surgery_on_real_page.js [页码，默认取 probe 里的页]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PROBE = path.join(__dirname, 'probe_v2_result.json');

let fail = 0;
function check(label, ok, extra) {
  if (!ok) fail++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
}

const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

// ---- 抽真实的 splitEnglishSentencesSmart ----
function extractFn(name) {
  const start = code.indexOf(`  function ${name}(`);
  const end = code.indexOf('\n  }', start);
  if (start < 0 || end < 0) throw new Error(`找不到 ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(`${code.slice(start, end + 4)}\n return ${name};`)();
}
const splitEnglishSentencesSmart = extractFn('splitEnglishSentencesSmart');

// ---- 抽真实的 visionSurgery 整段（含锚点定位与全部辅助函数）----
const surgStart = code.indexOf('  function normalizeVisionType(t) {');
const surgEnd = code.indexOf('  function applyVisionSegments(pageNum, result) {');
if (surgStart < 0 || surgEnd <= surgStart) throw new Error('找不到手术代码段');
// eslint-disable-next-line no-new-func
const M = new Function(
  'splitEnglishSentencesSmart',
  `${code.slice(surgStart, surgEnd)}
   return { visionSurgery, locateAnchorIndex, sentencesConsistent };`
)(splitEnglishSentencesSmart);

// ---- 真实素材 ----
const probe = JSON.parse(fs.readFileSync(PROBE, 'utf8'));
const raw = probe.rawResponse;
if (!raw || !Array.isArray(raw.segments)) {
  console.error('probe_v2_result.json 里没有 rawResponse.segments');
  process.exit(2);
}
const pageNum = Number(process.argv[2]) || probe.page || 4;

let spanSeq = 0;
const mkSpans = text => {
  const charMap = [];
  const rawSpans = [];
  for (let i = 0; i < text.length; i++) {
    const span = { id: `s${spanSeq++}`, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    if (i === 0) rawSpans.push(span);
    charMap.push({ span, offset: i });
  }
  return { charMap, rawSpans: rawSpans.length ? rawSpans : charMap.map(c => c.span) };
};
const local = (probe.localSegments || []).map(s => {
  const text = s.cleanText || s.text || '';
  const { charMap, rawSpans } = mkSpans(text);
  return {
    id: Number(s.id),
    type: s.type || 'body',
    cleanText: text,
    charMap,
    rawSpans,
    sentencesEn: splitEnglishSentencesSmart(text),
    sentenceTranslations: [],
    translation: ''
  };
});
const result = {
  version: 2,
  model: probe.model,
  fixes: probe.fixes,
  segments: raw.segments.map(s => ({
    index: Number(s.i),
    type: s.type,
    order: s.order,
    group: s.group,
    action: s.action,
    why: s.why,
    latex: s.latex,
    parts: s.parts,
    splitAt: s.splitAt,
    inline: s.inline
  }))
};

console.log(`真实视觉手术演练：第 ${pageNum} 页 ｜ 本地 ${local.length} 段 ｜ 模型回包 ${result.segments.length} 条 ｜ ${probe.model}\n`);
console.log('改动前的本地分段：');
local.forEach(p => console.log(`  [${p.id}] ${String(p.type).padEnd(9)} ${p.cleanText.replace(/\s+/g, ' ').slice(0, 78)}`));
const withAction = result.segments.filter(s => s.action && s.action !== 'keep');
console.log(
  `\n模型的动作：${withAction.length ? withAction.map(s => `[${s.index}] ${s.action}`).join('  ') : '（全是 keep）'}` +
    `　组：${result.segments.filter(s => s.group).map(s => `[${s.index}]→g${s.group}`).join(' ') || '（无）'}\n`
);

const before = local.map(p => p.cleanText);
const stats = M.visionSurgery(local, result);

console.log('手术后的分段：');
local.forEach(p => {
  const mark = p.visionFromSplit ? '⇢拆' : p.joinedByVision ? '⇢合' : '   ';
  console.log(`  ${mark} [${p.id}] ${String(p.type).padEnd(9)} ${p.cleanText.replace(/\s+/g, ' ').slice(0, 78)}`);
});
console.log(`\n统计：${JSON.stringify({ ...stats, notes: undefined })}`);
(stats.notes || []).forEach(n => console.log(`  备注：${n}`));

// ---- 核对 ----
const wc = s => String(s || '').replace(/\s+/g, '');
const noHyphen = s => wc(s).replace(/[-‐]/g, '');
console.log('\n核对：');
check(
  '不变量：每段 cleanText 与 charMap 严格 1:1',
  local.every(p => p.cleanText.length === p.charMap.length),
  local.map(p => `${p.cleanText.length}/${p.charMap.length}`).join(' ')
);
check(
  '不变量：逐句下标与文本严格自洽（切片相等）',
  local.every(p => (p.sentencesEn || []).every(s => p.cleanText.slice(s.startIdx, s.endIdx) === s.text))
);
check(
  '文本守恒：结果不多字、不丢字（合并折行去掉的连字符除外）',
  noHyphen(before.join('')) === noHyphen(local.map(p => p.cleanText).join('')),
  `原 ${noHyphen(before.join('')).length} 字 → 现 ${noHyphen(local.map(p => p.cleanText).join('')).length} 字`
);
check(
  'id 重新编号成 0..n-1',
  local.every((p, i) => p.id === i),
  local.map(p => p.id).join(',')
);
check(
  'data-para-id 跟着改到新编号',
  local.every((p, i) => (p.rawSpans || []).every(sp => !sp.setAttribute || sp.attrs['data-para-id'] === undefined || sp.attrs['data-para-id'] === String(i)))
);
const splitSegs = result.segments.filter(s => s.action === 'split' && Array.isArray(s.parts) && s.parts.length >= 2);
if (splitSegs.length) {
  const anySplit = local.some(p => p.visionFromSplit);
  check(`模型标了 ${splitSegs.length} 处拆分，实际${anySplit ? '发生了' : '没有发生'}手术`, true, anySplit ? '（锚点定位成功）' : `（锚点没定位到 → 已跳过，annotated: ${stats.anchorMissed}）`);
}
check('每段都还在（没有任何一段被手术弄丢）', local.length > 0 && local.every(p => p.cleanText.trim().length > 0));

console.log(`\n${fail === 0 ? '✅ 真实数据演练全部通过' : `❌ 有 ${fail} 项没通过`}`);
process.exit(fail === 0 ? 0 : 1);
