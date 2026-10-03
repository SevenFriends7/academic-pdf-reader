/**
 * 公式 LaTeX 全量校验：把三篇论文每一页抽出来的**所有公式**（本地数学层的产物）
 * 逐条喂给**真的 KaTeX**，检查：① 能不能渲染 ② 渲染出来是不是报错块 ③ 有没有空式子。
 *
 * 【为什么这是必需的验证】用户要的是"绝对精准"。LaTeX 正确与否有两个层面：
 *   · 语义层：公式内容对不对（靠 scratch/math_layer_check.js 打印出来肉眼+对照渲染图核）；
 *   · 语法层：KaTeX 收不收（本文件）。语法层能自动跑全量，语义层必须看图。
 *
 * 用法：node scratch/math_latex_verify.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const katex = require(path.join(__dirname, '..', 'media', 'katex', 'katex.min.js'));
const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const s = code.indexOf('  const MATH_FONT_RE');
const e = code.indexOf('  // ====================== 核心：学术文献双栏高保真版面解析器');
const ML = new Function(`${code.slice(s, e)}\n return { buildPageMathModel };`)();

const PAPERS = [
  ['cycle', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf'],
  ['AOT', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf'],
  ['STM', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf']
];

(async () => {
  let total = 0;
  const badSyntax = [];
  const empty = [];
  const samples = [];
  for (const [name, p] of PAPERS) {
    const data = new Uint8Array(fs.readFileSync(p));
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
    for (let pg = 1; pg <= doc.numPages; pg++) {
      const page = await doc.getPage(pg);
      const tc = await page.getTextContent();
      await page.getOperatorList();
      const cache = new Map();
      const fontNameOf = k => {
        if (cache.has(k)) return cache.get(k);
        let n = String(k);
        try {
          const f = page.commonObjs.get(k);
          if (f && f.name) n = f.name;
        } catch { /* 保持 loadedName */ }
        cache.set(k, n);
        return n;
      };
      const model = ML.buildPageMathModel(tc.items, fontNameOf, 10);
      model.runs.forEach(r => {
        total++;
        const tex = String(r.latex || '').trim();
        if (!tex) { empty.push([name, pg, r.items.map(i => i.str).join(' ')]); return; }
        let html = '';
        try {
          html = katex.renderToString(tex, { displayMode: false, throwOnError: false, strict: false, output: 'html' });
        } catch (err) {
          badSyntax.push([name, pg, tex, `throw: ${err.message}`]);
          return;
        }
        if (/katex-error/.test(html)) {
          // katex-error 会带出它自己的提示，抓出来给人看
          const m = /katex-error[^>]*>([^<]*)/.exec(html);
          badSyntax.push([name, pg, tex, (m && m[1]) || 'katex-error']);
        }
        if (samples.length < 12 && tex.length > 8) samples.push(`${name} p${pg}: ${tex}`);
      });
    }
    console.log(`${name}: ${doc.numPages} 页已校验`);
  }
  console.log(`\n总公式条数：${total}`);
  console.log(`空 LaTeX：${empty.length}`);
  empty.slice(0, 10).forEach(x => console.log(`   ${x[0]} p${x[1]}: ${x[2]}`));
  console.log(`KaTeX 语法错误：${badSyntax.length}`);
  badSyntax.slice(0, 30).forEach(x => console.log(`   ${x[0]} p${x[1]} ${JSON.stringify(x[2])} → ${x[3]}`));
  console.log('\n抽样：');
  samples.forEach(x => console.log(`   ${x}`));
  if (empty.length || badSyntax.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
