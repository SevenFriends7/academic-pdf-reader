/**
 * 公式质量审计（自动 + 可人工核对）：把所有页的公式按"这一行是公式行还是正文行"分组打印，
 * 并标出**可疑模式**，供人快速定位"哪里还不对"。
 *
 * 可疑模式（都是实测踩过的坑，写在这里当回归清单）：
 *   S1 公式里出现空格夹着的孤立数字/字母（`X t − 1` 这种残渣形态漏进了 LaTeX）
 *   S2 公式里出现 CJK / 中文标点（说明把正文吞进公式了）
 *   S3 同一条公式里出现两个不同视角的 `^`/`_` 嵌套到 4 层以上（跨行误并的典型指纹）
 *   S4 该行同时含正文单词与公式（混排行，必须能在界面里正确分开——这里只做统计）
 *   S5 LaTeX 里出现未转义的 `%`、`&`、`#`、`$`（会把 KaTeX 搞坏）
 *   S6 公式长度 > 200 字符（很可能是把整段正文吞了）
 *
 * 用法：node scratch/math_audit.js [paper] [page]
 *      node scratch/math_audit.js --all
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const PAPERS = {
  cycle: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf',
  AOT: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf',
  STM: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf'
};

const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const s = code.indexOf('  const MATH_FONT_RE');
const e = code.indexOf('  // ====================== 核心：学术文献双栏高保真版面解析器');
const ML = new Function(`${code.slice(s, e)}\n return { buildPageMathModel };`)();

async function pageModel(pdfPath, pageNum) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
  const page = await doc.getPage(pageNum);
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
  return { model: ML.buildPageMathModel(tc.items, fontNameOf, 10), doc };
}

const SUSPECT = {
  S1: tex => /[A-Za-z0-9]\s[a-z0-9](?![A-Za-z])/.test(tex),
  S2: tex => /[\u4e00-\u9fff\u3000-\u303f]/.test(tex),
  S3: tex => (tex.match(/[_^]/g) || []).length > 8,
  S5: tex => /(?<!\\)[%&#]/.test(tex),
  S6: tex => tex.length > 200
};

(async () => {
  const all = process.argv.includes('--all');
  const targets = all ? Object.entries(PAPERS) : [[process.argv[2] || 'cycle', PAPERS[process.argv[2] || 'cycle']]];
  const counts = {};
  let total = 0;
  for (const [name, pdf] of targets) {
    const { model, doc } = await pageModel(pdf, Number(process.argv[3] || 1));
    const pages = all ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : [Number(process.argv[3] || 1)];
    for (const pg of pages) {
      const m = all ? (await pageModel(pdf, pg)).model : model;
      m.runs.forEach(r => {
        total++;
        Object.entries(SUSPECT).forEach(([k, fn]) => {
          if (!fn(r.latex)) return;
          counts[k] = (counts[k] || 0) + 1;
          if (!all) console.log(`[${k}] p${pg} ${JSON.stringify(r.latex)}  来源: ${r.items.map(i => i.str).join(' ')}`);
        });
        if (!all) {
          const hasProse = /[a-z]{4,}/.test(r.items.map(i => i.str).join(''));
          console.log(`  ${hasProse ? '混排' : '纯式'} p${pg}  ${r.latex}`);
        }
      });
    }
  }
  console.log(`\n公式总数：${total}`);
  console.log('可疑计数：', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || '（无）');
})().catch(e => { console.error(e); process.exit(1); });
