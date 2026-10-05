'use strict';
/**
 * 用**真实存档段落**跑一遍译文渲染，确认 ⟦…⟧ 占位符被换成本地 LaTeX。
 * 针对用户截图（cycle 第 4/5 页）那两段，逐字符核对输出里还有没有 "\hat" 这种字面残留。
 */
const fs = require('fs');
const path = require('path');
const katex = require(path.join(__dirname, '..', 'media', 'katex', 'katex.min.js'));
global.window = { katex };
const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const esc = x => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function grab(name) {
  const lines = code.split('\n');
  const st = lines.findIndex(l => l.startsWith(`  function ${name}(`));
  if (st < 0) throw new Error(`抽不到 ${name}`);
  for (let i = st + 1; i < lines.length; i++) if (lines[i] === '  }') return lines.slice(st, i + 1).join('\n');
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
['looksLikeMath', 'looksLikeInlineMath', 'canRenderMath', 'decodeMathEntities', 'renderMathSpan',
  'residueToLatex', 'renderTextWithMath', 'normalizeForMatch', 'bigramDice', 'locateAnchorIndex',
  'locateAnchorRange', 'looksLikeMathResidue', 'renderVisionMathHtml', 'renderEnTextHtml',
  'residueToLiteralLatex', 'residueKeyOf', 'looksLikeFormulaResidue', 'escHtml', 'renderZhWithMath'
].forEach(h => { try { src += grab(h) + '\n'; } catch (e) { console.log(`（跳过 ${h}）`); } });
const API = new Function('escapeHtml', 'console', `${src}\n  return { renderZhWithMath };`)(esc, { log() {}, warn() {}, error() {} });

const dir = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
const paras = [];
for (const f of fs.readdirSync(dir)) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!/cycle/.test(j.pdfPath || '')) continue;
  for (const [pg, arr0] of Object.entries(j.pageArchive || {})) {
    (Array.isArray(arr0) ? arr0 : Object.values(arr0)).forEach(p => {
      if (String(p.translation || '').includes('⟦')) paras.push({ pg, p });
    });
  }
}
console.log(`带 ⟦…⟧ 占位符的存档段落共 ${paras.length} 段\n`);

let bad = 0;
let placeholderLeft = 0;
let literalLatex = 0;
let katexCount = 0;
const strip = h => String(h).replace(/<[^>]+>/g, '');

paras.slice(0, 40).forEach(({ pg, p }) => {
  const html = API.renderZhWithMath(String(p.translation || ''), p);
  const text = strip(html);
  const leftCount = (text.match(/⟦|⟧/g) || []).length;
  // 可见文字里出现 \hat / \times 这类源码 = 没渲染成公式
  const litCount = (text.match(/\\[a-zA-Z]+/g) || []).length;
  katexCount += (html.match(/class="katex"/g) || []).length;
  if (leftCount) {
    placeholderLeft++;
    console.log(`  ⚠️ p${pg} id${p.id}: 还有 ${leftCount} 个未替换的括号`);
    // 定位：括号在**渲染结果**里的位置，并把上下文打出来，判断是"切段漏了"还是"替换后又被转义回来"
    const at = html.indexOf('⟦');
    const at2 = html.indexOf('⟧');
    const pos = at >= 0 ? at : at2;
    console.log('     片段:', JSON.stringify(html.slice(Math.max(0, pos - 60), pos + 80)));
    console.log('     源里 ⟦ 个数:', (String(p.translation || '').match(/⟦/g) || []).length,
      '⟧ 个数:', (String(p.translation || '').match(/⟧/g) || []).length);
  }
  if (litCount) { literalLatex++; console.log(`  ❌ p${pg} id${p.id}: 可见文字里残留 LaTeX 源码 ${text.match(/\\[a-zA-Z]+/g).slice(0, 4)}`); }
  if (!leftCount && !litCount) bad++;
});
console.log(`\n干干净净（无括号残留、无源码残留）：${bad} / ${paras.length}`);
console.log(`KaTeX 公式总数：${katexCount}`);
console.log(`残留括号的段落：${placeholderLeft}，残留源码的段落：${literalLatex}`);

console.log('\n--- 用户截图那两段的实际输出 ---');
paras.filter(x => x.pg === '4' || x.pg === '5').slice(0, 4).forEach(({ pg, p }) => {
  const html = API.renderZhWithMath(String(p.translation || ''), p);
  console.log(`p${pg} id${p.id}: ${strip(html).slice(0, 130)}`);
  console.log(`   KaTeX ${(html.match(/class="katex"/g) || []).length} 个，含字面 hat: ${/hat/.test(strip(html))}`);
  /*
   * 【必须查 HTML 而不是剥标签后的文字】KaTeX 把公式拆成一个个字形 span，
   * 剥掉标签后 `\hat{Y}_t` 会显示成 `Y^t`（帽子变成 ^）——那是**正常的排版结果**，
   * 不是字面残留。真正的"字面残留"是源码原样出现在 HTML 里：`\hat` 这两个字符连在一起。
   */
  const hasLiteralCommand = /\\hat|\\times|\\in\b|\\bigcup|\\frac/.test(html);
  console.log(`   字面 LaTeX 源码残留在 HTML 里: ${hasLiteralCommand ? '❌ 有' : '✅ 无'}`);
  if (hasLiteralCommand) {
    const at = html.search(/\\hat|\\times|\\in\b|\\bigcup|\\frac/);
    console.log('     片段:', JSON.stringify(html.slice(Math.max(0, at - 40), at + 60)));
  }
});
process.exit(placeholderLeft || literalLatex ? 1 : 0);
