/**
 * 译文公式替换的回归测试：模型抄下来的残渣（⟦…⟧）必须被**本地抽出的规范 LaTeX** 换掉。
 *
 * 【为什么必须测这个】旧提示词让模型"把公式转写成 LaTeX"，实测它会转错
 * （真实回包：`$X_{Tl}$` 而原文是 `X_l^t`、`$tHW \times CEq$` 而原文是 `X_l^t \in R^{HW\times C}`）。
 * KaTeX 对错式子照样渲染 —— 用户看到"漂亮但内容错误"的公式，比残渣更危险。
 * 现在提示词改成让模型照抄残渣并用 ⟦…⟧ 括起来，由本文件的被测函数配上本地 LaTeX。
 *
 * 用法：node scratch/zh_math_subst_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const katex = require(path.join(__dirname, '..', 'media', 'katex', 'katex.min.js'));
global.window = { katex };
const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const esc = x => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 按"顶层函数结束行恰好是 两个空格+花括号"来切（viewer.js 的缩进约定） */
function grab(name) {
  const lines = code.split('\n');
  const st = lines.findIndex(l => l.startsWith(`  function ${name}(`));
  if (st < 0) throw new Error(`抽不到 ${name}`);
  for (let i = st + 1; i < lines.length; i++) {
    if (lines[i] === '  }') return lines.slice(st, i + 1).join('\n');
  }
  throw new Error(`${name} 没闭合`);
}

let src = '';
['RESIDUE_HAT_RE', 'RESIDUE_CARET_RE', 'RESIDUE_SUB_RE'].forEach(n => {
  const m = new RegExp(`^  const ${n} = .*$`, 'm').exec(code);
  if (m) src += m[0] + '\n';
});
{
  const lines = code.split('\n');
  const st = lines.findIndex(l => l.startsWith('  const VISION_CHAR_EQUIV = {'));
  if (st >= 0) for (let i = st; i < lines.length; i++) { src += lines[i] + '\n'; if (lines[i] === '  };') break; }
}
const need = ['looksLikeMath', 'looksLikeInlineMath', 'canRenderMath', 'decodeMathEntities', 'renderMathSpan',
  'residueToLatex', 'renderTextWithMath', 'normalizeForMatch', 'bigramDice', 'locateAnchorIndex', 'locateAnchorRange',
  'looksLikeMathResidue', 'renderVisionMathHtml', 'renderEnTextHtml', 'residueToLiteralLatex', 'residueKeyOf',
  'escHtml', 'renderZhWithMath'];
need.forEach(h => { try { src += grab(h) + '\n'; } catch (e) { console.log(`（跳过 ${h}）`); } });
const API = new Function('escapeHtml', 'console', `${src}
  return { renderZhWithMath };`)(esc, { log() {}, warn() {}, error() {} });

let pass = 0; let fail = 0;
const check = (label, ok, extra) => { if (ok) pass++; else { fail++; console.log(`  ❌ ${label}${extra ? `   ${extra}` : ''}`); } };
/**
 * 把 HTML 还原成"渲染后的可见文字"。
 * 【注意】不能用简单的 `replace(/<[^>]+>/g,'')`：KaTeX 输出里 `<span class="katex">` 这类标签
 * 去掉之后，源码级别的特征串（`Concat`）**不会出现**——它已经被拆成一个个字形 span 了。
 * 所以"本地 LaTeX 有没有进去"要靠 `data-math-source="local-zh"` 这类标记判断；
 * 只有"残渣兜底"这条路径才会在可见文字里留下源码（`\textbackslash`、`\textasciicircum`）。
 */
const plain = h => String(h).replace(/<[^>]+>/g, '');

// 真实存档里的段落数据（AOT 第 6 页）
const para3 = {
  localMath: [{ text: 'X l m', latex: 'X_{l}^{m}=Concat(X_{l}^{m1}, ..., X_{l}^{mT})' }],
  visionInline: []
};
const para1 = {
  localMath: [
    { text: 'X l t', latex: 'X_{l}^{t}' },
    { text: '∈ R HW × C', latex: '\\in R^{HW\\times C}' }
  ],
  visionInline: []
};

console.log('===== 译文公式替换 =====');
{
  const zh = '其中 ⟦X l m⟧ 与 ⟦Y m⟧ 分别是输入特征与目标掩码。';
  const html = API.renderZhWithMath(zh, para3);
  check('⟦…⟧ 被换成 KaTeX 公式', html.includes('class="katex"'), html.slice(0, 120));
  check('带 data-math-source=local-zh 指纹', html.includes('data-math-source="local-zh"'));
  check('残渣与括号标记都不再出现在可见文字里', !plain(html).includes('⟦') && !plain(html).includes('X l m'), plain(html).slice(0, 80));
  // 本地 latex 进没进渲染，看 KaTeX 生成的字形里有没有 C/o/n/c/a/t 这些字符
  check('本地 LaTeX 的字形真的渲染出来了（含 Concat 的字母）',
    ['C', 'o', 'n', 'c', 'a', 't'].every(ch => html.includes(`>${ch}<`) || html.includes(`${ch}</span>`)),
    'Concat 的字形没找到');
}
{
  /*
   * 精确匹配：残渣与表里的 `text` 逐字一致时取**对应那条**，而不是按顺序瞎取。
   * 【为什么用 visionInline 里的 find 当"模型会抄下来的残渣"】
   * `localMath[].text` 存的是原段落里被切出来的字符（`t HW × C` 这种，与真实残渣写法不同），
   * 而**视觉模型给的 find 才是真正的残渣写法**（`X T l`、`n = { t − 1, ..., t − n }`），
   * 也就是模型照抄时会写在 ⟦…⟧ 里的东西。
   */
  const zh = '设 ⟦X T l⟧ 表示特征。';
  const html = API.renderZhWithMath(zh, { localMath: [], visionInline: [{ find: 'X T l', latex: 'X_l^{\\mathbf{m}}' }] });
  check('visionInline 的 find 能对上 ⟦…⟧（不是按顺序乱取）',
    html.includes('local-zh') || html.includes('class="katex"'),
    html.slice(0, 160));
}
{
  // 表里没有 → 原样排版残渣，但**绝不丢内容**
  const zh = '这里有一个 ⟦Z z z⟧ 记号。';
  const html = API.renderZhWithMath(zh, { localMath: [], visionInline: [] });
  check('表里没有时退化成"原样排版残渣"而不是丢掉', html.includes('vision-residue-math'), html.slice(0, 140));
  check('退化路径仍然渲染了内容（不是空盒子）', plain(html).includes('Z') && plain(html).includes('z'), plain(html).slice(0, 80));
}
{
  // 模型没照规矩写（还是老样子输出 $...$）时，原有路径仍要能渲染
  const zh = '设 $X_l^t$ 表示特征。';
  const html = API.renderZhWithMath(zh, para1);
  check('模型仍写 $...$ 时照旧渲染', html.includes('class="katex"'), html.slice(0, 120));
}
{
  // 没有任何公式的普通译文
  const zh = '这是一段没有公式的中文译文。';
  const html = API.renderZhWithMath(zh, { localMath: [], visionInline: [] });
  check('无公式译文原样输出', plain(html) === zh, plain(html));
}

{
  /*
   * 【用户截图的真实样本】cycle 第 5 页 id=0：
   * 模型抄下来的是 `⟦Y ̂ t⟧`（帽子是组合字符 U+0302），而 **localMath 是空数组**，
   * 只有 visionInline 里有 `{find:"Y ̂ t", latex:"\\hat{Y}_t"}`。
   * 旧实现只查 localMath → 退化成"把残渣当字面 LaTeX 渲染"，
   * 而 `\hat` 在数学模式里会被 KaTeX 当成 `\h`（水平间距）+ "at"，
   * 界面上就出现 `maskY t`（用户截图右边的样子）。
   */
  const zh = '更准确的预测掩码 ⟦Y ̂ t⟧ 会为 ⟦Y1⟧ 带来更小的重建误差。';
  const html = API.renderZhWithMath(zh, {
    localMath: [],
    visionInline: [{ find: 'Y ̂ t', latex: '\\hat{Y}_t' }, { find: 'Y 1', latex: 'Y_1' }]
  });
  const text = plain(html);
  check('残渣 ⟦Y ̂ t⟧ 配到了 visionInline 的 \\hat{Y}_t（样本来自用户截图）',
    html.includes('data-math-source="local-zh"') && html.includes('class="katex"'), text.slice(0, 80));
  check('没有把 \\hat 渲染成字面 "hat" 文本', !/hat/.test(text.replace(/<[^>]*>/g, '')), text.slice(0, 90));
  check('⟦Y1⟧ 也配到了 Y_1', (html.match(/class="katex"/g) || []).length >= 2, `KaTeX 数=${(html.match(/class="katex"/g) || []).length}`);
}
{
  // 表里完全没有这条：退化成**纯文字**（等宽），绝不进数学模式（否则 \hat 会被吃掉）
  const html = API.renderZhWithMath('这里 ⟦\\hat{Y}_t⟧ 没有表。', { localMath: [], visionInline: [] });
  check('表里没有时退化成纯文字、不进数学模式',
    html.includes('vision-residue-math') && !html.includes('class="katex"'), html.slice(0, 140));
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
