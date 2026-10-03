/**
 * 把某一段真实文本（原文/译文）过一遍真实的公式渲染，逐条打印"哪几个字被换成了什么 LaTeX"，
 * 用来定位"这个 N 怎么变成公式了"这类问题。
 *
 * 用法：node scratch/vision/residue_check.js [页码] [关键词]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

// 与 inline_math_on_real_page.js 相同的抽取方式（已验证可用）
const s = code.indexOf('  const RESIDUE_HAT_RE');
// 切到 renderEnTextHtml 的结尾（它的最后一句是 return out;）
const end = code.indexOf('\n  }', code.indexOf('return out;', s));
// eslint-disable-next-line no-new-func
const M = new Function(
  'escapeHtml',
  'renderMathSpan',
  'looksLikeMath',
  `${code.slice(s, end + 4)}
   return { renderTextWithMath };`
)(
  x => String(x == null ? '' : x),
  (tex, d) => `«${d ? 'DISPLAY:' : ''}${tex}»`,
  t => /[\\^_{}=]/.test(String(t)) || /^[A-Za-z]{1,3}$/.test(String(t).trim())
);

const page = process.argv[2] || '5';
const kw = process.argv[3] || 'N 次迭代';
const dir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
const f = fs
  .readdirSync(dir)
  .filter(x => x.startsWith('paper_'))
  .map(x => ({ x, t: fs.statSync(path.join(dir, x)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0].x;
const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

const cases = [];
(p.pageArchive[page] || []).forEach(x => {
  const en = String(x.cleanText || '');
  const zh = String(x.translation || '');
  const list = Array.isArray(x.sentenceTranslations) && x.sentenceTranslations.length ? x.sentenceTranslations : [zh];
  list.forEach(z => {
    if (z && String(z).includes(kw)) cases.push(['译文句', String(z)]);
  });
  if (en.includes(kw.replace('次迭代', 'iterations'))) cases.push(['原文段', en]);
});
cases.slice(0, 6).forEach(([label, text]) => {
  const out = M.renderTextWithMath(text);
  console.log(`\n--- ${label} ---`);
  console.log('原样: ' + JSON.stringify(text.slice(0, 160)));
  console.log('渲染: ' + out.slice(0, 220));
});
if (cases.length === 0) console.log(`第 ${page} 页没有含「${kw}」的段落（可换关键词）`);
