'use strict';
/**
 * 转义还原回归测试：`&#95;` 这类 HTML 实体必须在进 KaTeX 之前还原成真实字符。
 *
 * 【真实症状（用户截图）】译文里的 `Y_1` 在管线中被 escapeHtml 成 `Y&#95;1`，
 * 而 KaTeX 不认 `&#95;`，`throwOnError:false` 就把它当普通文本排出来——
 * 用户看到的是字面的 `Y_1`、`Y\hat t`，也就是"公式有 LaTeX 但没渲染"。
 * 这类 bug 单元测试看不见（源码是对的），只有把"实体化的 LaTeX"喂进去才暴露。
 *
 * 用法：node scratch/math_entity_test.js
 */
'use strict';
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
  'residueToLatex', 'renderTextWithMath', 'renderVisionMathHtml'
].forEach(h => { try { src += grab(h) + '\n'; } catch (e) { console.log(`（跳过 ${h}）`); } });
const API = new Function('escapeHtml', 'console', `${src}\n  return { renderVisionMathHtml };`)(esc, { log() {}, warn() {}, error() {} });

let pass = 0; let fail = 0;
const check = (label, ok, extra) => { if (ok) pass++; else { fail++; console.log(`  ❌ ${label}${extra ? `   ${extra}` : ''}`); } };
/** 渲染成功 = 有 katex 且没有 katex-error */
const rendered = tex => {
  const html = API.renderVisionMathHtml(tex, false);
  return html.includes('class="katex"') && !html.includes('katex-error');
};
/** 可见文字里有没有把命令原样漏出来 */
const leaksSource = tex => /\\hat|\\times|\\bigcup|\\in\\b|&#95;/.test(
  String(API.renderVisionMathHtml(tex, false)).replace(/<[^>]+>/g, '')
);

console.log('===== 转义还原 =====');
const cases = [
  ['\\hat{Y}_t', '正常 LaTeX'],
  ['Y&#95;1', '下划线被实体化（用户截图里的 Y_1）'],
  ['&#92;hat{Y}_t', '反斜杠被实体化'],
  ['\\hat{Y}&#95;{t}', '混合实体'],
  ['Y &lt; M', '小于号实体化'],
  ['\\bigcup &#95; mask', '并集 + 实体下划线']
];
cases.forEach(([tex, why]) => {
  check(`能渲染：${why}  →  ${tex}`, rendered(tex), JSON.stringify(API.renderVisionMathHtml(tex, false).slice(0, 80)));
  check(`不泄漏源码：${why}`, !leaksSource(tex));
});

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
