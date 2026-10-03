/**
 * 段落重建的端到端验证（不依赖 IDE）：用**真实 PDF 的 item** 喂给 viewer.js 里真正的
 * `commitParagraph`，检查它产出的 `cleanText` / `segments` / 类型是否符合预期。
 *
 * 【为什么需要它】数学层单测（math_layer_test.js）只验到"LaTeX 抽得对不对"，
 * 而用户看到的残渣问题发生在**段落拼接**这一步：公式与正文之间的词距、公式片段的边界。
 * 这一步以前没有任何自动化覆盖——只能靠用户在 IDE 里肉眼看。
 * 本文件把 `commitParagraph` 原样抽出来（连同它依赖的 findMathRegions / splitEnglishSentencesSmart），
 * 喂真实 item，断言：
 *   ① 正文与公式之间的词距正确（`…predicted mask Ŷt is used…` 而不是 `maskY`）；
 *   ② 整段只有公式时 type === 'formula'，且 visionLatex 拿到本地 LaTeX；
 *   ③ 语句 / charMap 与 cleanText 长度严格 1:1（划线高亮不错位）。
 *
 * 用法：node scratch/para_rebuild_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

const s = code.indexOf('  const MATH_FONT_RE');
const e = code.indexOf('  function buildPageMathModel');
const fnEnd = code.indexOf('\n  /**', e);
const mathLayer = code.slice(s, e) + code.slice(e, fnEnd);

// commitParagraph 需要 splitEnglishSentencesSmart（viewer.js 里的独立函数）
const spStart = code.indexOf('  function splitEnglishSentencesSmart(text) {');
let spEnd = -1;
{
  let depth = 0;
  for (let i = spStart; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { spEnd = i; break; }
    }
  }
}
if (spStart < 0 || spEnd < 0) throw new Error('抽不到 splitEnglishSentencesSmart');

let pass = 0;
let fail = 0;
const check = (label, ok, extra) => {
  if (ok) pass++;
  else { fail++; console.log(`  ❌ ${label}${extra ? `   ${extra}` : ''}`); }
};

const build = new Function(`
  ${mathLayer}
  ${code.slice(spStart, spEnd + 1)}
  return { buildPageMathModel, findMathRegions, splitEnglishSentencesSmart };
`);
const ML = build();

/** 把 pdf.js 的 item 变成 viewer 用的 textDiv（带 _pdfX/_pdfY/_pdfH/_pdfW/_pdfIdx） */
function makeDivs(items) {
  return items.map((it, i) => {
    const div = {
      textContent: it.str,
      _pdfX: it.transform[4],
      _pdfY: it.transform[5],
      _pdfH: it.height,
      _pdfW: it.width,
      _pdfIdx: i,
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }
    };
    return div;
  });
}

/** 把一页的 item 按"同一 y 容差 3.5pt"切成 viewer 意义上的 line（只需 spans + minX/maxX） */
function makeLines(divs) {
  const lines = [];
  divs.forEach(d => {
    let L = lines.find(l => Math.abs(l.y - d._pdfY) <= 3.5);
    if (!L) { L = { y: d._pdfY, minX: d._pdfX, maxX: d._pdfX + d._pdfW, h: d._pdfH || 9, section: 'col1', spans: [] }; lines.push(L); }
    L.spans.push(d);
    L.minX = Math.min(L.minX, d._pdfX);
    L.maxX = Math.max(L.maxX, d._pdfX + d._pdfW);
  });
  lines.sort((a, b) => b.y - a.y);
  lines.forEach(l => l.spans.sort((a, b) => a._pdfX - b._pdfX));
  return lines;
}

/**
 * 按"行带"把一页切成若干组（每组 = viewer 意义上的一个段落）。
 * 【为什么要分组】把整页 40+ 行当成一个段落跑，会得到一段几千字的巨型段落，
 * 于是"整段只有公式"这类判据永远不会成立（实测：纯公式段数 = 0 是测试自身的构造问题，
 * 不是产品 bug）。按行带分组后才与真实调用方式一致。
 */
function bandLines(lines) {
  const bands = [];
  lines.forEach(l => {
    const b = bands[bands.length - 1];
    if (b && Math.abs(b.y - l.y) <= 22) { b.lines.push(l); b.y = l.y; return; }
    bands.push({ y: l.y, lines: [l] });
  });
  return bands.map(b => b.lines);
}

const PAPERS = {
  cycle: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf',
  AOT: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf',
  STM: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf'
};

/** 真跑一遍 commitParagraph：把 viewer 里那段代码抽出来，注入依赖后执行 */
function runCommit(items, fontNames, lineFilter) {
  const model = ML.buildPageMathModel(items, k => fontNames[k] || String(k), 10);
  const divs = makeDivs(items);
  const lines = makeLines(divs).filter(lineFilter || (() => true));
  const start = code.indexOf('    function commitParagraph() {');
  const end = code.indexOf('    for (let i = 0; i < orderedLines.length; i++) {');
  if (start < 0 || end < 0) throw new Error('抽不到 commitParagraph');
  const body = code.slice(start, end);
  const fn = new Function(
    'orderedLines', 'curParaLines', 'curParaType', 'paras', 'textContent', 'mathInfoByIdx',
    'findMathRegions', 'splitEnglishSentencesSmart', 'segmentGap', 'paraSpanGap', 'console',
    `${body}
     curParaLines = orderedLines.map(l => ({ ...l }));
     commitParagraph();
     return paras;`
  );
  return fn(
    lines.map(l => ({ ...l })), [], 'body', [], { items }, model.byIndex,
    ML.findMathRegions, ML.splitEnglishSentencesSmart, () => null, () => 0,
    { log() {}, warn() {}, error() {} }
  );
}

(async () => {
  console.log('===== 段落重建：正文与公式的边界 / 词距 / 类型 =====');
  for (const [paper, pdfPath] of Object.entries(PAPERS)) {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
    const page = await doc.getPage(paper === 'STM' ? 4 : paper === 'AOT' ? 5 : 4);
    const tc = await page.getTextContent();
    await page.getOperatorList();
    const fontNames = {};
    tc.items.forEach(it => {
      if (!it.fontName) return;
      try {
        const f = page.commonObjs.get(it.fontName);
        if (f && f.name) fontNames[it.fontName] = f.name;
      } catch { /* 忽略 */ }
    });
    const items = tc.items;
    const divsAll = makeDivs(items);
    const allLines = makeLines(divsAll);
    let paras = [];
    try {
      bandLines(allLines).forEach(band => {
        const ys = band.map(x => x.y);
        const yLo = Math.min(...ys) - 1;
        const yHi = Math.max(...ys) + 1;
        paras = paras.concat(runCommit(items, fontNames, l => l.y >= yLo && l.y <= yHi));
      });
    } catch (err) {
      check(`${paper}: commitParagraph 能跑通`, false, err.message);
      continue;
    }
    check(`${paper}: 段落重建产出段落`, paras.length > 0, `${paras.length} 段`);

    // charMap 与 cleanText 严格 1:1
    const bad = paras.filter(p => p.charMap.length !== p.cleanText.length);
    check(`${paper}: charMap 与 cleanText 长度 1:1（划线不错位）`, bad.length === 0,
      bad.slice(0, 2).map(p => `${p.cleanText.length}vs${p.charMap.length}`).join(','));

    // 公式段与混排段
    const mixed = paras.filter(p => Array.isArray(p.segments) && p.segments.some(x => x.kind === 'math') && p.type !== 'formula');
    check(`${paper}: 正文夹公式的段落被切成 math 片段`, mixed.length > 0, `${mixed.length} 段`);

    /*
     * 纯公式段（type='formula'）：本测试按"行带"人为切段，一行带里常同时有公式与正文，
     * 所以"整段只有公式"在这个构造下很少出现——那是测试构造的限制，不是产品行为。
     * 这里**单独**把"整行都是数学 item"的行喂进去（独立公式块的真实形态），才真正覆盖那条路径。
     */
    const mathIdx = new Set(Object.keys(
      ML.buildPageMathModel(items, k => fontNames[k] || String(k), 10).byIndex
    ).map(Number));
    const pureLines = allLines.filter(L => L.spans.every(sp => mathIdx.has(sp._pdfIdx)));
    const pureParas = [];
    pureLines.forEach(L => {
      const yy = L.y;
      pureParas.push(...runCommit(items, fontNames, l => Math.abs(l.y - yy) <= 1));
    });
    const pureFormulas = pureParas.filter(p => p.type === 'formula');
    check(`${paper}: 独立公式行被判成 type=formula`, pureParas.length === 0 || pureFormulas.length > 0,
      `纯公式行 ${pureLines.length}，判成 formula 的 ${pureFormulas.length}`);
    check(`${paper}: formula 段都拿到了本地 LaTeX`,
      pureFormulas.every(p => String(p.visionLatex || '').trim().length > 0),
      pureFormulas.filter(p => !String(p.visionLatex || '').trim()).map(p => p.cleanText.slice(0, 30)).join(' | '));

    // 混排段的 cleanText 不该出现"字母紧贴公式"的粘连（正文与公式之间应有空格或标点）
    const glued = mixed.filter(p => /[a-z]{2}[A-Z]{1}[a-z]?\{|mask[A-Z]|used[A-Z]/.test(p.cleanText));
    check(`${paper}: 正文与公式之间没有粘连`, glued.length === 0,
      glued.slice(0, 2).map(p => p.cleanText.slice(0, 60)).join(' | '));

    // 抽两段给人看
    console.log(`\n--- ${paper} 抽样 ---`);
    paras.filter(p => Array.isArray(p.segments) && p.segments.some(x => x.kind === 'math')).slice(0, 3).forEach(p => {
      console.log(`  [${p.type}] ${JSON.stringify(p.cleanText.slice(0, 110))}`);
      p.segments.filter(x => x.kind === 'math').slice(0, 3).forEach(x => console.log(`        公式 → ${x.latex}`));
    });
  }
  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
