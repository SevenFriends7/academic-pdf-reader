'use strict';
/**
 * 用**真实存档 + 真实 viewer 函数**复现用户截图里的三个不对劲：
 *   ① 译文里的公式被模型写错（`X_{Tl}` 应该是 `X_l^t`）——本地表能不能纠正它
 *   ② 译文里出现 `m m m m m where X_l^m = Concat(...)` —— 哪里多出来的残渣
 *   ③ 公式段 id 2 的翻译就是原文残渣（模型没翻）
 * 打印每一步的输入输出，定位到具体函数。
 */
const fs = require('fs');
const path = require('path');
const katex = require(path.join(__dirname, '..', 'media', 'katex', 'katex.min.js'));
global.window = { katex };
const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const esc = x => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 抽一个顶层 function。
 *
 * 【为什么不用"数花括号"】viewer.js 里 `$` 出现在正则字符类里（`/[^$\n]/`），
 * 简单的深度计数会被内部的 `{}` 与正则里的 `$`/`/` 带偏，实测直接抽坏（报 missing /）。
 * 这里换成一个**行级**判据：viewer.js 里顶层函数的结束行恰好是 `  }`（两个空格 + 一个花括号），
 * 而函数体内部的行缩进都 ≥4 个空格。按这个切，既不用解析正则也稳定。
 */
function grab(name) {
  const lines = code.split('\n');
  const st = lines.findIndex(l => l.startsWith(`  function ${name}(`));
  if (st < 0) throw new Error(`抽不到 ${name}`);
  for (let i = st + 1; i < lines.length; i++) {
    if (lines[i] === '  }') return lines.slice(st, i + 1).join('\n');
  }
  throw new Error(`${name} 没闭合`);
}

const need = ['looksLikeMath', 'looksLikeInlineMath', 'canRenderMath', 'decodeMathEntities', 'renderMathSpan',
  'residueToLatex', 'renderTextWithMath', 'normalizeForMatch', 'bigramDice', 'locateAnchorIndex', 'locateAnchorRange',
  'looksLikeMathResidue', 'renderVisionMathHtml', 'renderEnTextHtml', 'applyInlineMathToMarkdown'];
let src = '';
/*
 * 几个"常量"（renderTextWithMath / normalizeForMatch 会用到）。
 * VISION_CHAR_EQUIV 是跨行对象字面量，这里按"从 const 行到匹配的 };"整段抠出来。
 */
['RESIDUE_HAT_RE', 'RESIDUE_CARET_RE', 'RESIDUE_SUB_RE'].forEach(n => {
  const m = new RegExp(`^  const ${n} = .*$`, 'm').exec(code);
  if (m) src += m[0] + '\n';
  else console.log(`（没找到常量 ${n}）`);
});
{
  const lines = code.split('\n');
  const st = lines.findIndex(l => l.startsWith('  const VISION_CHAR_EQUIV = {'));
  if (st < 0) {
    console.log('（没找到 VISION_CHAR_EQUIV）');
  } else {
    for (let i = st; i < lines.length; i++) {
      src += lines[i] + '\n';
      if (lines[i] === '  };') break;
    }
  }
}
const got = [];
need.forEach(h => {
  try { src += grab(h) + '\n'; got.push(h); } catch (e) { console.log(`（跳过 ${h}：${e.message}）`); }
});
console.log('抽到：', got.join(', '), '\n');

const API = new Function('escapeHtml', 'console', `${src}
  return { renderEnTextHtml, renderTextWithMath, applyInlineMathToMarkdown, renderVisionMathHtml };`)(esc, {
  log() {}, warn() {}, error() {}
});

// 读真实存档
const dir = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
let page = null;
for (const f of fs.readdirSync(dir)) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!/AOT/.test(j.pdfPath || '')) continue;
  const pa = j.pageArchive && j.pageArchive[6];
  if (pa) page = Array.isArray(pa) ? pa : Object.values(pa);
}
if (!page) { console.log('存档里没有 AOT 第 6 页'); process.exit(1); }

const strip = h => String(h)
  .replace(/<span class="katex">/g, '⟦').replace(/<\/span>/g, '⟧')
  .replace(/<[^>]+>/g, '');

page.slice(0, 6).forEach(p => {
  console.log(`\n================ 段落 id=${p.id} type=${p.type} ================`);
  console.log('原文 cleanText :', JSON.stringify(String(p.cleanText || '').slice(0, 150)));
  const zh = String(p.translation || '');
  console.log('译文原文        :', JSON.stringify(zh.slice(0, 160)));

  const inline = Array.isArray(p.visionInline) ? p.visionInline : [];
  const local = Array.isArray(p.localMath) ? p.localMath : [];
  console.log(`表：visionInline=${inline.length} 条，localMath=${local.length} 条`);
  if (local.length) {
    const uniq = [...new Set(local.map(x => x.latex))];
    console.log(`  localMath 去重后只有 ${uniq.length} 条不同的 latex：`);
    uniq.slice(0, 3).forEach(t => console.log('     ' + JSON.stringify(String(t).slice(0, 90))));
    console.log(`  localMath 的 text 片段：${JSON.stringify(local.slice(0, 6).map(x => x.text))}`);
  }

  // 译文渲染（这正是界面上显示的东西）
  const zhHtml = API.renderEnTextHtml(zh, inline);
  console.log('译文渲染后      :', JSON.stringify(strip(zhHtml).slice(0, 180)));
  const katexCount = (zhHtml.match(/class="katex"/g) || []).length;
  const residueCount = (zhHtml.match(/vision-residue-math/g) || []).length;
  console.log(`  KaTeX 公式 ${katexCount} 个，残渣兜底 ${residueCount} 个`);

  // 原文渲染
  if (p.cleanText) {
    const enHtml = API.renderEnTextHtml(p.cleanText, inline);
    console.log('原文渲染后      :', JSON.stringify(strip(enHtml).slice(0, 150)));
  }
});
