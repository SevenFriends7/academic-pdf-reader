/**
 * 数学层离线验证：用**真实的 viewer.js 代码** + **真实的 PDF 文本层**（含真实字体名）
 * 跑一遍 buildPageMathModel，逐条打印公式的 LaTeX，并与页面渲染图对照。
 *
 * 【为什么必须离线跑真代码】本机没有 VS Code webview，但数学层是纯函数：
 * 只要把 viewer.js 里的那一段抽出来、喂真实的 pdf.js item（含 page.commonObjs 里的真字体名），
 * 得到的 LaTeX 就是用户界面里会看到的那个字符串。这样可以在**不装扩展**的情况下
 * 把"提取到底对不对"验完，剩下的只交给肉眼核对渲染图。
 *
 * 用法：
 *   node scratch/math_layer_check.js <pdf> <page>          # 打印该页公式
 *   node scratch/math_layer_check.js <pdf> <page> --json    # 机器可读（供断言脚本比对）
 *   node scratch/math_layer_check.js --all                  # 扫三篇论文全部页，汇总统计
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const ROOT = path.join(__dirname, '..');
const VIEWER_SRC = process.env.VIEWER_SRC || path.join(ROOT, 'media', 'viewer.js');
const code = fs.readFileSync(VIEWER_SRC, 'utf8');

/** 从 viewer.js 抽出数学层那一段（从 MATH_FONT_RE 到 buildAcademicLayout 之前），跑真代码 */
function loadMathLayer() {
  const start = code.indexOf('  const MATH_FONT_RE');
  const end = code.indexOf('  // ====================== 核心：学术文献双栏高保真版面解析器');
  if (start < 0 || end < 0 || end <= start) throw new Error('viewer.js 抽片锚点失效（数学层被移动或改名？）');
  const snippet = code.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${snippet}
    return { isMathFontName, mathItemsToLatex, buildPageMathModel, findMathRegions, mathCharToLatex, chainToLatex };`)();
}
const ML = loadMathLayer();

const PAPERS = {
  cycle: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf',
  AOT: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf',
  STM: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf'
};

/** 取一页的真实 item + 真实字体名映射 */
async function pageItems(pdfPath, pageNum) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  await page.getOperatorList(); // 触发字体加载：之后 commonObjs 里才是真名
  const cache = new Map();
  const fontNameOf = key => {
    if (cache.has(key)) return cache.get(key);
    let name = String(key || '');
    try {
      const f = page.commonObjs.get(key);
      if (f && f.name) name = f.name;
    } catch { /* 没加载到就退回 loadedName（判不出数学字体，但不会崩） */ }
    cache.set(key, name);
    return name;
  };
  return { items: tc.items, fontNameOf, doc, page };
}

async function analyze(pdfPath, pageNum) {
  const { items, fontNameOf } = await pageItems(pdfPath, pageNum);
  const model = ML.buildPageMathModel(items, fontNameOf, 10);

  // 逐行归并：把同一行的 item 拼成"旧实现的残渣写法"与"新的正文/公式切分"
  const lines = [];
  items.forEach((it, idx) => {
    if (!it.str || !it.str.trim()) return;
    const y = (it.transform || [1, 0, 0, 1, 0, 0])[5];
    let L = lines.find(l => Math.abs(l.y - y) <= 3.5);
    if (!L) { L = { y, entries: [] }; lines.push(L); }
    L.entries.push({ idx, str: it.str, x: (it.transform || [])[4] || 0, info: model.byIndex[idx] || null });
  });
  lines.sort((a, b) => b.y - a.y);
  lines.forEach(L => L.entries.sort((a, b) => a.x - b.x));

  const out = [];
  lines.forEach(L => {
    const mathIdx = L.entries.filter(e => e.info && e.info.math);
    if (mathIdx.length === 0) return;
    const runIds = [...new Set(mathIdx.map(e => e.info.runId))];
    out.push({
      y: Number(L.y.toFixed(1)),
      legacyJoin: L.entries.map(e => e.str).join(' ').replace(/\s+/g, ' ').trim(),
      runs: runIds.map(id => {
        const r = model.runs[id];
        return { id, latex: r.latex, legacy: r.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim(), font: r.items[0].font };
      })
    });
  });
  return { model, lines: out };
}

(async () => {
  if (process.argv.includes('--all')) {
    let totalRuns = 0;
    const suspicious = [];
    for (const [key, p] of Object.entries(PAPERS)) {
      const data = new Uint8Array(fs.readFileSync(p));
      const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
      for (let pg = 1; pg <= doc.numPages; pg++) {
        const { model } = await analyze(p, pg);
        totalRuns += model.runs.length;
        model.runs.forEach(r => {
          if (!r.latex) suspicious.push([key, pg, '空 LaTeX', r.items.map(i => i.str).join(' ')]);
        });
      }
      console.log(`${key}: ${doc.numPages} 页已扫描`);
    }
    console.log(`\n全库公式条数：${totalRuns}`);
    if (suspicious.length) {
      console.log(`可疑条目 ${suspicious.length}：`);
      suspicious.slice(0, 20).forEach(s => console.log('  ', s.join(' | ')));
    }
    return;
  }

  const pdfPath = PAPERS[process.argv[2]] || process.argv[2];
  const pageNum = Number(process.argv[3] || 1);
  const res = await analyze(pdfPath, pageNum);
  if (process.argv.includes('--runs')) {
    const { model } = res;
    model.runs.forEach(r => {
      console.log(`\nLaTeX: ${JSON.stringify(r.latex)}`);
      r.items.forEach(it => console.log(`   ${it.str === ' ' ? '␠' : it.str}  x=${it.x.toFixed(2)} y=${it.y.toFixed(2)} size=${it.size.toFixed(2)} w=${it.width.toFixed(2)} h=${it.height} ${it.font}`));
    });
    return;
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(res.lines, null, 1));
    return;
  }
  console.log(`===== ${path.basename(pdfPath)} 第 ${pageNum} 页：${res.lines.length} 行含公式 =====`);
  res.lines.forEach(L => {
    console.log(`\ny=${L.y}`);
    console.log(`  旧拼法: ${L.legacyJoin.slice(0, 130)}`);
    L.runs.forEach(r => {
      console.log(`  → LaTeX: ${r.latex}`);
      console.log(`    残渣 : ${r.legacy}    [${r.font.replace(/^[A-Z]{6}\+/, '')}]`);
    });
  });
})().catch(e => { console.error(e); process.exit(1); });
