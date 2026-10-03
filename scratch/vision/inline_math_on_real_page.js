/**
 * 用真实数据回答"正文段落里的 LaTeX 到底渲染了没有"。
 *
 * 素材（全部来自用户本机，不调用任何 API）：
 *   · 本地分段：scratch/vision/probe_v2_result.json 的 localSegments
 *     （cycle.pdf 第 4 页的本地分段，就是视觉结果里那些 i 指向的东西）
 *   · 视觉结果：globalStorage 里最新存档的 visionStructure[<page>]（真实回包，含 inline 替换表）
 * 代码：从 media/viewer.js 抽出的真实 visionSurgery + 真实 renderEnTextHtml。
 *
 * 输出：手术后的每一段里，哪些残渣**被渲染成公式**、哪些仍是残渣（并给出原因）。
 *
 * 用法：node scratch/vision/inline_math_on_real_page.js [页码=4]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

function extractFn(name) {
  const s = code.indexOf(`  function ${name}(`);
  const e = code.indexOf('\n  }', s);
  if (s < 0 || e < 0) throw new Error(`找不到 ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(`${code.slice(s, e + 4)}\n return ${name};`)();
}
const splitEnglishSentencesSmart = extractFn('splitEnglishSentencesSmart');

// 手术段（含锚点定位与辅助函数）+ 行内公式渲染
const surgStart = code.indexOf('  function normalizeVisionType(t) {');
const surgEnd = code.indexOf('  function applyVisionSegments(pageNum, result) {');
// 从 renderTextWithMath 起切：renderEnTextHtml 依赖它
const htmlStart = code.indexOf('  function renderTextWithMath(text) {');
const htmlEnd = code.indexOf('\n  }', code.indexOf('return out;', htmlStart));
// eslint-disable-next-line no-new-func
const api = new Function(
  'splitEnglishSentencesSmart',
  'escapeHtml',
  'renderMathSpan',
  'locateAnchorIndex',
  `${code.slice(surgStart, surgEnd)}
   ${code.slice(htmlStart, htmlEnd + 4)}
   return { visionSurgery: visionSurgery, renderEnTextHtml: renderEnTextHtml };`
)(
  splitEnglishSentencesSmart,
  s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  // KaTeX 桩：把 tex 原样包起来，便于断言"确实走了渲染分支"
  (tex, display) => `<KATEX${display ? '-DISPLAY' : ''}>${tex}</KATEX>`,
  null // locateAnchorIndex 由下面这段源码自身提供（它在切片里）
);
// 上面把 locateAnchorIndex 传成 null 会被函数声明覆盖，这里再确认一次可用
const M = new Function(
  'splitEnglishSentencesSmart',
  'escapeHtml',
  'renderMathSpan',
  `${code.slice(surgStart, surgEnd)}
   ${code.slice(htmlStart, htmlEnd + 4)}
   return { visionSurgery, renderEnTextHtml, locateAnchorIndex };`
)(splitEnglishSentencesSmart, s => String(s == null ? '' : s), (tex, d) => `<KATEX${d ? '-DISPLAY' : ''}>${tex}</KATEX>`);

// ---- 真实素材 ----
const probe = JSON.parse(fs.readFileSync(path.join(__dirname, 'probe_v2_result.json'), 'utf8'));
const page = Number(process.argv[2]) || Number(probe.page) || 4;
const dir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
const newest = fs
  .readdirSync(dir)
  .filter(f => f.startsWith('paper_') && f.endsWith('.json'))
  .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0].f;
const paper = JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8'));
const vs = (paper.visionStructure || {})[String(page)];
if (!vs) {
  console.error(`存档里没有第 ${page} 页的视觉结果`);
  process.exit(2);
}

let seq = 0;
const local = (probe.localSegments || []).map(s => {
  const text = s.cleanText || '';
  const charMap = [];
  for (let i = 0; i < text.length; i++) charMap.push({ span: { attrs: {}, setAttribute() {} }, offset: i });
  return {
    id: Number(s.id),
    type: s.type || 'body',
    cleanText: text,
    charMap,
    rawSpans: charMap.map(c => c.span),
    sentencesEn: splitEnglishSentencesSmart(text),
    sentenceTranslations: [],
    translation: ''
  };
});
const result = { version: vs.version, model: vs.model, fixes: vs.fixes, segments: vs.segments };

console.log(`第 ${page} 页 ｜ 本地 ${local.length} 段 ｜ 视觉回包 ${result.segments.length} 条 ｜ ${vs.model}（${new Date(vs.at).toLocaleString('zh-CN')}）`);
const withInline = result.segments.filter(s => Array.isArray(s.inline) && s.inline.length);
console.log(`\n模型给出的行内公式替换表：${withInline.length} 段`);
withInline.forEach(s => {
  (s.inline || []).forEach(m => console.log(`  i=${s.index} (${s.type}, action=${s.action || 'keep'})  find=${JSON.stringify(m.find)}  →  ${m.latex}`));
});

const stats = M.visionSurgery(local, result);
console.log(`\n手术后：${local.length} 段（合并 ${stats.merged} / 拆分 ${stats.split} / 丢弃 ${stats.dropped}）；带上替换表的段：${local.filter(p => (p.visionInline || []).length).length}`);

console.log('\n逐段检查正文里的残渣渲染情况：');
local.forEach(p => {
  if (!p.cleanText) return;
  const inline = p.visionInline || [];
  const sents = p.sentencesEn && p.sentencesEn.length ? p.sentencesEn.map(s => s.text) : [p.cleanText];
  sents.forEach((text, idx) => {
    const html = M.renderEnTextHtml(text, inline);
    const rendered = html.match(/<KATEX[^>]*>[\s\S]*?<\/KATEX>/g) || [];
    // 粗判"这段里还有没有残渣"：有数学符号/上下标字符但没被渲染
    const looksResidue = /[⊂∈∑∫Ω̂^_=]|\bY t\b|\bX t\b/.test(text);
    if (!rendered.length && !looksResidue) return;
    const tag = rendered.length ? '✅ 渲染' : looksResidue ? '⚠️ 仍是残渣' : '—';
    console.log(`  [${p.id}] ${String(p.type).padEnd(8)} 句${idx + 1} ${tag}`);
    console.log(`        原文：${text.replace(/\s+/g, ' ').slice(0, 96)}`);
    if (rendered.length) console.log(`        渲染：${rendered.map(r => r.slice(0, 60)).join(' + ')}`);
    else if (looksResidue && inline.length === 0) console.log('        原因：这一段模型没给行内公式替换表');
    else if (looksResidue) console.log(`        原因：给了 ${inline.length} 条，但没有一条能在这句里定位到`);
  });
});

const totalRendered = local.reduce((n, p) => {
  const inline = p.visionInline || [];
  const sents = p.sentencesEn && p.sentencesEn.length ? p.sentencesEn.map(s => s.text) : [p.cleanText];
  return (
    n +
    sents.filter(t => /<KATEX/.test(M.renderEnTextHtml(t, inline))).length
  );
}, 0);
const missing = local.filter(p => {
  const hasResidue = /[⊂∈∑∫Ω̂]|\bY t\b|\bX t\b/.test(p.cleanText || '');
  return hasResidue && (!p.visionInline || p.visionInline.length === 0);
}).length;
console.log(`\n小结：${totalRendered} 句渲染出了公式；${missing} 段含残渣但模型没给替换表（这些仍是残渣——显示层只做"模型确认过的替换"，不自己猜）。`);
