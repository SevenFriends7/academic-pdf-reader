/**
 * AI 回答里的公式渲染审计（素材全部来自本机存档 `aiQa[].answer`，0 次 API）。
 *
 * 【为什么要单独审】AI 回答走的是 **Markdown 渲染**（renderMarkdownToHtml → renderInlineMarkdown），
 * 与 PDF 正文的"行内替换表"那条路完全不同：它直接认 `$...$` / `$$...$$` / `\(...\)` / `\[...\]`。
 * 所以"AI 回答里公式渲染失败"要么是 KaTeX 没加载（兜底成 `$源码$`），要么是模型写的写法没被认出来。
 *
 * 输出三类：
 *   A1 渲染结果里出现 katex-error（KaTeX 拒绝该写法）；
 *   A2 渲染后**仍有 `$` 或 LaTeX 命令裸露**（该被渲染却没被认出来的数学片段）；
 *   A3 该条回答里根本没有数学片段（无需渲染）。
 *
 * 用法：node scratch/ai_math_audit.js [--verbose]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(process.env.VIEWER_SRC || path.join(ROOT, 'media', 'viewer.js'), 'utf8');
const verbose = process.argv.includes('--verbose');

let katex = null;
try {
  katex = require(path.join(ROOT, 'media', 'katex', 'katex.min.js'));
  global.window = { katex };
} catch (e) {
  console.log(`（提示：没能加载本地 KaTeX：${e.message}）`);
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const renderMathSpan = (() => {
  // renderMathSpan 依赖 decodeMathEntities（紧邻其上的小函数）→ 一起抽出来
  const s = code.indexOf('  function decodeMathEntities(tex) {');
  const rs = code.indexOf('  function renderMathSpan(tex, displayMode) {');
  const e = code.indexOf('\n  }', rs);
  if ((s < 0 && rs < 0) || e < 0) throw new Error('抽不到 renderMathSpan');
  if (s < 0 || s > rs) {
    // 老版本没有 decodeMathEntities
    // eslint-disable-next-line no-new-func
    return new Function('escapeHtml', `${code.slice(rs, e + 4)}\n return renderMathSpan;`)(esc);
  }
  // eslint-disable-next-line no-new-func
  return new Function(
    'escapeHtml',
    `${code.slice(s, rs)}\n ${code.slice(rs, e + 4)}\n return renderMathSpan;`
  )(esc);
})();
/** renderMarkdownToHtml 依赖 renderInlineMarkdown（两者在源码里是相邻的两个函数），
 *  renderInlineMarkdown 又依赖 looksLikeInlineMath / looksLikeMathCodeSpan / canRenderMath
 *  （canRenderMath 内部还要 decodeMathEntities）→ 一起抽出来传进去。 */
const helpers = (() => {
  const decAt = code.indexOf('  function decodeMathEntities(tex) {');
  const s = decAt >= 0 ? decAt : code.indexOf('  function looksLikeMath(tex) {');
  if (s < 0) throw new Error('抽不到判据片段');
  const endAt = sig => {
    const at = code.indexOf(sig);
    return at < 0 ? -1 : code.indexOf('\n  }', at) + 4;
  };
  const hasCodespan = code.indexOf('  function looksLikeMathCodeSpan(raw) {') >= 0;
  const end = hasCodespan
    ? endAt('  function canRenderMath(tex) {')
    : code.indexOf('  function looksLikeMathCodeSpan(raw) {') >= 0
      ? endAt('  function looksLikeMathCodeSpan(raw) {')
      : endAt('  function looksLikeMath(tex) {');
  if (end < 0) throw new Error('抽不到判据片段的结尾');
  // eslint-disable-next-line no-new-func
  return new Function(
    'escapeHtml',
    'console',
    `${code.slice(s, end)}
     return {
       looksLikeInlineMath: typeof looksLikeInlineMath === 'function' ? looksLikeInlineMath : looksLikeMath,
       looksLikeMathCodeSpan: typeof looksLikeMathCodeSpan === 'function' ? looksLikeMathCodeSpan : () => false,
       canRenderMath: typeof canRenderMath === 'function' ? canRenderMath : () => false
     };`
  )(esc, { log() {}, warn() {} });
})();
const looksLikeInlineMath = helpers.looksLikeInlineMath;

/** A4 的**分类判据**始终取自仓库当前源码。
 *  否则跑"修复前"的目标文件时那里没有 looksLikeMathCodeSpan，回退成"永不判定"，A4 永远是 0，
 *  before/after 就没法比了——判据与被测渲染路径必须分开取。 */
const classifyMathCodeSpan = (() => {
  const repo = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');
  const s = repo.indexOf('  function looksLikeMathCodeSpan(raw) {');
  if (s < 0) return () => false;
  const e = repo.indexOf('\n  }', s);
  // eslint-disable-next-line no-new-func
  return new Function(`${repo.slice(s, e + 4)}\n return looksLikeMathCodeSpan;`)();
})();
const { renderInlineMarkdown, renderMarkdownToHtml } = (() => {  const s = code.indexOf('  function renderInlineMarkdown(text) {');
  const e = code.indexOf('\n  function renderMarkdownToHtml(md) {');
  if (s < 0 || e < 0) throw new Error('抽不到 Markdown 渲染片段');
  // eslint-disable-next-line no-new-func
  return new Function(
    'escapeHtml',
    'renderMathSpan',
    'looksLikeInlineMath',
    'looksLikeMathCodeSpan',
    'canRenderMath',
    `${code.slice(s, e)}
     ${code.slice(e, code.indexOf('\n  }', code.indexOf('while (i < lines.length)', e)) + 4)}
     return { renderInlineMarkdown, renderMarkdownToHtml };`
  )(esc, renderMathSpan, helpers.looksLikeInlineMath, helpers.looksLikeMathCodeSpan, helpers.canRenderMath);
})();

const dir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
const files = fs.readdirSync(dir).filter(f => f.startsWith('paper_') && f.endsWith('.json'));

/**
 * A5：**公式聚焦覆盖率**——存档里的公式段落有多少条带着"规范 LaTeX"。
 *
 * 【为什么值得单独看】问 AI 时带着规范式，模型才能逐符号讲对（而不是照文本层残渣猜）。
 * 这个数字说明"聚焦公式"这条链路有多少能真正用上：
 *   · 有 visionLatex → 提问时作为【规范写法】交给模型；
 *   · 没有 → 只能靠残渣 + 模型自己推断。
 * 数字低不是代码 bug，而是"这一页的视觉回包没标出公式"——那正是该补的地方。
 */
const formulaCoverage = { total: 0, withLatex: 0, withInline: 0, pages: new Set() };
/** A5b：**视觉回包里**的公式片有多少带着 latex —— 这才是"提问时手里有没有规范式"的真答案。
 *  （页存档是导出用的持久化快照，用户机器上的历史数据是旧代码写的、可能还没有这个字段。） */
const visionCoverage = { segs: 0, withLatex: 0 };
files.forEach(f => {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const archive = j.pageArchive || {};
  Object.keys(archive).forEach(pg => {
    const list = Array.isArray(archive[pg]) ? archive[pg] : Object.values(archive[pg] || {});
    list.forEach(p => {
      if (!p || p.type !== 'formula') return;
      formulaCoverage.total++;
      formulaCoverage.pages.add(`${path.basename(j.pdfPath || f)}#${pg}`);
      if (String(p.visionLatex || '').trim()) formulaCoverage.withLatex++;
      if (Array.isArray(p.visionInline) && p.visionInline.length) formulaCoverage.withInline++;
    });
  });
  const vs = j.visionStructure || {};
  Object.keys(vs).forEach(pg => {
    const segs = (vs[pg] && vs[pg].segments) || [];
    segs.forEach(s => {
      const isFormula = s && (s.type === 'formula' || (Array.isArray(s.parts) && s.parts.some(p => p && p.type === 'formula')));
      if (!isFormula) return;
      visionCoverage.segs++;
      const hasLatex = String((s && s.latex) || '').trim() || (Array.isArray(s.parts) && s.parts.some(p => p && String(p.latex || '').trim()));
      if (hasLatex) visionCoverage.withLatex++;
    });
  });
});

let total = 0;
let withMath = 0;
const bad = { A1: [], A2: [] };
const strayDollars = [];
const codePills = [];

/** 把回答里的数学片段按 renderInlineMarkdown 的同一套规则抠出来（含 display/inline 两种）。
 *  ⚠️ renderMarkdownToHtml 是**先把一个段落的多行 join(' ') 再**交给 renderInlineMarkdown 的，
 *  所以跨行的 `$...$` 在渲染器眼里是合法的；审计必须同样对"换行已变空格"的版本再抠一遍，
 *  否则会漏报（实测就是这么漏掉两条的）。 */
function mathFragments(md) {
  const out = [];
  const variants = [String(md || ''), String(md || '').replace(/\r?\n/g, ' ')];
  const push = (src, re, display) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) out.push({ tex: m[1], display, raw: m[0] });
  };
  variants.forEach(src => {
    push(src, /\$\$([^$]+?)\$\$/g, true);
    push(src, /\\\[([\s\S]+?)\\\]/g, true);
    push(src, /\\\(([\s\S]+?)\\\)/g, false);
    push(src, /\$([^$\n]+?)\$/g, false);
  });
  return out;
}

/** 用**真实渲染入口**逐个复核。
 *  ⚠️ 必须走 renderMathSpan（而不是直接问 KaTeX）：它里面含有 HTML 实体还原与行内 `\tag` 改写，
 *  直接拿原始片段问 KaTeX 会报出"实际已经被处理掉"的错，误导排查。 */
function katexErrors(md) {
  const errs = [];
  mathFragments(md).forEach(fr => {
    // 渲染器对单 $ 的片段有 looksLikeInlineMath 判据，拒掉的不会进 KaTeX → 这里也要跳过
    if (!fr.display && !looksLikeInlineMath(fr.tex)) return;
    const html = renderMathSpan(fr.tex, fr.display);
    if (!/katex-error/.test(html)) return;
    const title = /title="([^"]*)"/.exec(html);
    errs.push({
      tex: String(fr.tex).trim(),
      display: !!fr.display,
      err: title
        ? title[1].replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        : '(未知)'
    });
  });
  return errs;
}

files.forEach(f => {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const name = path.basename(j.pdfPath || j.pdfName || f);
  const qas = j.aiQa;
  const list = Array.isArray(qas) ? qas : qas && typeof qas === 'object' ? Object.values(qas) : [];
  list.forEach((qa, i) => {
    const answer = String((qa && qa.answer) || '');
    if (!answer.trim()) return;
    total++;
    const hasMath = /\$|\\\(|\\\[|\\begin\{/.test(answer);
    if (hasMath) withMath++;
    const html = renderMarkdownToHtml(answer);
    const plain = html.replace(/<[^>]+>/g, '');
    const katexErr = /class="katex-error"/.test(html) || /katex-error/.test(html);
    // 渲染后仍裸露的数学写法：`$...$`（成对）或反斜杠命令
    const rawDollar = /\$[^$\n]{1,80}\$/.test(plain) || /\\\(|\\\[|\\begin\{/.test(plain);
    const rawCmd = /\\(?:mathbb|mathcal|hat|frac|sum|mid|times|mathrm|text|subset|in|alpha|beta|gamma|theta)\b/.test(plain);
    if (katexErr) bad.A1.push({ name, i, q: qa && qa.question, answer, html, errs: katexErrors(answer) });
    else if (rawDollar || rawCmd) bad.A2.push({ name, i, q: qa && qa.question, answer, html, plain, rawDollar, rawCmd });
    // A3（信息性）：渲染结果里还剩多少个**可见的字面 $**。
    // 这些是模型漏写/多写定界符造成的（配对出来的"散文片段"被判据拒绝、原样保留），
    // 不是渲染 bug；数量小说明判据没有大面积误伤。
    const stray = (plain.match(/\$/g) || []).length;
    if (stray) strayDollars.push({ name, i, stray });
    // A4：渲染后仍是**代码块样式**、但内容看起来是数学的片段 ——
    // 也就是"本该排版成公式、却显示成灰底代码"的变量/公式（用户最直接的痛点）。
    const codeMath = [];
    html.replace(/<code class="md-code">([\s\S]*?)<\/code>/g, (m, inner) => {
      const text = inner.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      if (classifyMathCodeSpan(text)) codeMath.push(text);
      return m;
    });
    if (codeMath.length) codePills.push({ name, i, n: codeMath.length, sample: codeMath.slice(0, 8) });
  });
});

/** 渲染结果里仍是字面 `$...$` 的片段。
 *  ⚠️ 只在**渲染后的纯文本**上找，不要在原文上重扫：原文重扫会把跨段落/跨代码块的 `$`
 *  也配成对（渲染器是按段落、且先抽代码块的），那样报出来的"被拒片段"是假的。 */
function leftoverDollars(plain) {
  const out = [];
  String(plain || '').replace(/\$([^$\n]{1,120})\$/g, (m, tex) => {
    out.push(tex);
    return m;
  });
  return out;
}

console.log(`\n===== 汇总 =====`);
console.log(`AI 回答 ${total} 条；含数学写法 ${withMath} 条；A1 katex-error ${bad.A1.length} 条；A2 渲染后仍裸露数学 ${bad.A2.length} 条`);
console.log(
  `A3（信息性）渲染后仍可见的字面 $ ${strayDollars.reduce((a, x) => a + x.stray, 0)} 个，` +
    `分布在 ${strayDollars.length} 条回答里 —— 这些是模型漏写/多写定界符造成的，不是渲染 bug`
);
console.log(
  `A4 变量/公式仍显示成灰底代码块的：${codePills.reduce((a, x) => a + x.n, 0)} 个，` +
    `分布在 ${codePills.length} 条回答里（模型爱用反引号包公式；现在这类会被当行内公式渲染）`
);
codePills.slice(0, 4).forEach(x => console.log(`   [${x.name} #${x.i}] ${x.n} 个: ${JSON.stringify(x.sample)}`));
console.log(
  `A5 公式聚焦覆盖率：存档里 ${formulaCoverage.total} 个公式段落，` +
    `${formulaCoverage.withLatex} 个带规范 LaTeX（提问时会作为【规范写法】交给模型；` +
    `${formulaCoverage.total - formulaCoverage.withLatex} 个只能靠字符层残渣推断）` +
    `，${formulaCoverage.withInline} 个带行内公式表；涉及 ${formulaCoverage.pages.size} 页`
);
console.log(
  `A5b 视觉回包里的公式片：${visionCoverage.segs} 片，其中 ${visionCoverage.withLatex} 片给了 latex` +
    ` —— 这才是"提问时手里有没有规范式"的答案（页存档是导出用的快照，历史数据可能是旧代码写的）`
);

const show = (title, arr, fmt) => {
  console.log(`\n--- ${title}：${arr.length} 条 ---`);
  (verbose ? arr : arr.slice(0, 6)).forEach(x => console.log(fmt(x)));
  if (!verbose && arr.length > 6) console.log(`   …还有 ${arr.length - 6} 条（加 --verbose 看全部）`);
};
show('A1 KaTeX 报错', bad.A1, x => {
  const lines = [`[${x.name} #${x.i}] Q=${JSON.stringify(String(x.q || '').slice(0, 40))}`];
  const at = x.html.indexOf('katex-error');
  if (at >= 0) {
    const title = /title="([^"]*)"/.exec(x.html.slice(at, at + 400));
    lines.push(`   渲染结果里报错处: …${x.html.slice(Math.max(0, at - 160), at + 200).replace(/\s+/g, ' ')}…`);
    if (title) lines.push(`   KaTeX: ${title[1]}`);
  }
  (x.errs || []).slice(0, 6).forEach(e => {
    lines.push(`   ❌ ${e.display ? '(display)' : '(inline)'} ${JSON.stringify(e.tex.slice(0, 160))}`);
    lines.push(`      → ${e.err}`);
  });
  if (!(x.errs || []).length) lines.push(`   （没能逐条定位到失败的片段，可能是渲染路径里的其它写法）`);
  return lines.join('\n');
});
show(
  'A2 渲染后仍有裸露的数学写法（没被认出来）',
  bad.A2,
  x => {
    const left = leftoverDollars(x.plain);
    return (
      `[${x.name} #${x.i}] rawDollar=${x.rawDollar} rawCmd=${x.rawCmd} 渲染后仍是字面 $...$ 的片段 ${left.length} 个\n` +
      left.slice(0, 4).map(t => `   ⊘ ${JSON.stringify(t.slice(0, 90))}`).join('\n')
    );
  }
);
