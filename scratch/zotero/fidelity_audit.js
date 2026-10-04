/**
 * 「原文完整性」终版尺子：跑**真管道**（viewer.js 的 commitParagraph），逐页对账。
 *
 * 【为什么必须跑真管道】前两版我用自己写的行重建去量，量出来的是"我的重建"的缺陷，
 * 不是产品缺陷（v1 因阅读顺序不同误报"缺 71%"，v2 的"粘词"也可能是我的重建造成的）。
 * 这里改为把 viewer.js 里真实的 commitParagraph 抽出来跑（与 scratch/para_rebuild_test.js 同一手法），
 * 拿到的 cleanText 就是阅读器真正送去翻译、也是真正用来画高光的那份文本。
 *
 * 三个判据（对应用户的三条要求）：
 *   ① 粘词缺陷：一行以小写字母结尾、词中间没有任何标点，紧接着又以小写字母开头
 *      （如 `previousframeissimilar`、`ob`+`tained`）→ 词语被粘连，阅读和翻译都会出错。
 *      逐条打印上下文，人工可核。
 *   ② 字符覆盖率：把本页所有字母数字去掉空白后，与 Zotero 全文的同口径字符多重集对比
 *      → 有没有系统性丢字（缺胳膊少腿的最硬证据）。
 *   ③ 高光几何：本页用于高亮的字符映射 charMap 与 cleanText 是否等长（不等长就会整体错位）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const pdfjsLib = require(path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const VIEWER = path.join(__dirname, '..', '..', 'media', 'viewer.js');
const code = fs.readFileSync(VIEWER, 'utf8');

// ---- 抽出 commitParagraph 及其依赖（与 para_rebuild_test.js 同款注入）----
// 起点必须取 `const MATH_FONT_RE`：findMathRegions / isMathFontName 都定义在那之后，
// 从 buildPageMathModel 起切会漏掉它们（第一次就是这里报 findMathRegions is not defined）。
const s0 = code.indexOf('  const MATH_FONT_RE');
const e0 = code.indexOf('  function buildPageMathModel');
const fnEnd = code.indexOf('\n  /**', e0);
const mathLayer = code.slice(s0, e0) + code.slice(e0, fnEnd);
const spStart = code.indexOf('  function splitEnglishSentencesSmart(text) {');
let spEnd = -1;
{
  let depth = 0;
  for (let i = code.indexOf('{', spStart); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) { spEnd = i; break; }
    }
  }
}
const build = new Function(`
  ${mathLayer}
  ${code.slice(spStart, spEnd + 1)}
  return { buildPageMathModel, findMathRegions, splitEnglishSentencesSmart };
`);
const ML = build();

function makeDivs(items) {
  return items.map((it, i) => ({
    textContent: it.str,
    _pdfX: it.transform[4],
    _pdfY: it.transform[5],
    _pdfH: it.height,
    _pdfW: it.width,
    _pdfIdx: i,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }
  }));
}
function makeLines(divs) {
  const lines = [];
  divs.forEach(d => {
    let L = lines.find(l => Math.abs(l.y - d._pdfY) <= 3.5);
    if (!L) {
      L = { y: d._pdfY, minX: d._pdfX, maxX: d._pdfX + d._pdfW, h: d._pdfH || 9, section: 'col1', spans: [] };
      lines.push(L);
    }
    L.spans.push(d);
    L.minX = Math.min(L.minX, d._pdfX);
    L.maxX = Math.max(L.maxX, d._pdfX + d._pdfW);
  });
  lines.sort((a, b) => b.y - a.y);
  lines.forEach(l => l.spans.sort((a, b) => a._pdfX - b._pdfX));
  return lines;
}
function bandLines(lines) {
  const bands = [];
  lines.forEach(l => {
    const b = bands[bands.length - 1];
    if (b && Math.abs(b.y - l.y) <= 22) { b.lines.push(l); b.y = l.y; return; }
    bands.push({ y: l.y, lines: [l] });
  });
  return bands.map(b => b.lines);
}
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

/** 逐页跑真管道，返回该页所有段落的 cleanText 与高光映射长度 */
function pageParagraphs(items, fontNames) {
  const all = makeLines(makeDivs(items));
  let paras = [];
  bandLines(all).forEach(band => {
    const ys = band.map(x => x.y);
    const yLo = Math.min(...ys) - 1;
    const yHi = Math.max(...ys) + 1;
    paras = paras.concat(runCommit(items, fontNames, l => l.y >= yLo && l.y <= yHi));
  });
  return paras;
}

/**
 * 找"粘词"缺陷。
 * 判据（保守，避免误报）：一行以字母结尾且行尾词长度 ≥ 4、下一行以字母开头，
 * 且把两行拼起来后在词表里查不到任何"分开写"的证据 —— 直接按正则找长串小写字母（≥ 18 个）
 * 且里面不含常见虚词边界，作为可疑粘连。
 * 更实用的做法：统计"长度 ≥ 18 的连续字母串"——正常英文里这种词极少（多数是专有名词或 URL）。
 */
function findGluedWords(text) {
  const glued = [];
  const re = /[A-Za-z]{18,}/g;
  let m;
  while ((m = re.exec(text))) {
    glued.push({ word: m[0], at: m.index, ctx: text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25) });
  }
  return glued;
}

/** 字符多重集对比（只留字母数字，忽略空白与标点差异） */
function letterBag(s) {
  const bag = new Map();
  for (const ch of String(s || '').toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) bag.set(ch, (bag.get(ch) || 0) + 1);
  }
  return bag;
}
function bagDiff(a, b) {
  const cnt = new Map(a);
  for (const [k, v] of b) cnt.set(k, (cnt.get(k) || 0) - v);
  let onlyA = 0, onlyB = 0;
  for (const v of cnt.values()) {
    if (v > 0) onlyA += v;
    else if (v < 0) onlyB += -v;
  }
  return [onlyA, onlyB];
}

const storage = path.join(os.homedir(), 'Zotero', 'storage');
const PAPERS = [
  ['STM', 'NQI6N4AP', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf'],
  ['AOT', 'GUT7U72G', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf'],
  ['cycle', 'DE6KQMVB', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf']
];

(async () => {
  console.log('===== 原文完整性（真管道：viewer.js 的 commitParagraph）=====\n');
  const totals = [];
  for (const [name, key, pdfPath] of PAPERS) {
    if (!fs.existsSync(pdfPath)) {
      console.log(`  ⚠️  ${name}: 找不到 ${pdfPath}，跳过`);
      continue;
    }
    const cachePath = path.join(storage, key, '.zotero-ft-cache');
    const zotPages = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf8').split('\f') : [];
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
    console.log(`--- ${name}（${doc.numPages} 页）---`);
    let gluedTotal = 0, charOnlyZot = 0, charOnlyMine = 0, mapMismatch = 0, samples = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
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
      let paras;
      try {
        paras = pageParagraphs(tc.items, fontNames);
      } catch (err) {
        console.log(`  p${p}: commitParagraph 抛错 ${err.message}`);
        continue;
      }
      const full = paras.map(x => x.cleanText).join('\n');
      const glued = findGluedWords(full);
      gluedTotal += glued.length;
      if (glued.length && samples.length < 6) samples.push({ p, ...glued[0] });
      paras.forEach(x => {
        if (Array.isArray(x.charMap) && x.charMap.length !== x.cleanText.length) mapMismatch++;
      });
      const zot = (zotPages[p - 1] || '');
      const [oz, om] = bagDiff(letterBag(zot), letterBag(full));
      charOnlyZot += oz;
      charOnlyMine += om;
      if (oz > 0 || om > 0) {
        // 差的是哪些字符？把字母多重集差展开成可读清单（这是"缺字"定位的关键证据）
        const cnt = letterBag(zot);
        for (const [k, v] of letterBag(full)) cnt.set(k, (cnt.get(k) || 0) - v);
        const missing = [...cnt.entries()].filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`);
        const extra = [...cnt.entries()].filter(([, v]) => v < 0).map(([k, v]) => `${k}×${-v}`);
        console.log(
          `  p${String(p).padStart(2)}  字母差 Zotero独有 ${oz}（${missing.join(' ')}） / 本机独有 ${om}${extra.length ? `（${extra.join(' ')}）` : ''}`
        );
      }
      if (glued.length) console.log(`  p${String(p).padStart(2)}  粘词 ${String(glued.length).padStart(2)} 处  例：${glued[0].word.slice(0, 30)}`);
    }
    console.log(
      `  ── ${name}：粘词 ${gluedTotal} 处；字母差（Zotero 独有 ${charOnlyZot} / 本机独有 ${charOnlyMine}）；` +
        `charMap 与 cleanText 不等长的段落 ${mapMismatch} 个`
    );
    totals.push({ name, gluedTotal, charOnlyZot, charOnlyMine, mapMismatch });
    if (samples.length) {
      console.log('  粘词样例（上下文）：');
      samples.forEach(s => console.log(`     p${s.p}: …${s.ctx}…`));
    }
    await doc.destroy();
    console.log('');
  }
  console.log('='.repeat(88));
  console.log('总结：粘词=该断词处没断（翻译与阅读都会出错）；字母差=系统性丢字；charMap 不等长=高光会整体错位');
  console.log('='.repeat(88));
  totals.forEach(t =>
    console.log(
      `${t.name.padEnd(8)} 粘词 ${String(t.gluedTotal).padStart(3)}  字母差 ${String(t.charOnlyZot).padStart(4)}/${String(t.charOnlyMine).padStart(4)}  charMap 错位段 ${String(t.mapMismatch).padStart(3)}`
    )
  );
})().catch(e => { console.error(e); process.exit(1); });
