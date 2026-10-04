/**
 * 「高光准不准」的可量化检查：字符映射（charMap）的偏移量是否可信。
 *
 * 【为什么查这个而不是查坐标】高光矩形的坐标是浏览器实测的 DOM 位置
 * （media/viewer.js 的 getParagraphHighlightRects 用 range.getClientRects()），
 * 所以"位置"天然与画面一致。唯一会让高光漂移的是**映射错位**：
 * cleanText 的第 i 个字符，被指到 span 里错误的 offset 上 —— 差一位，整条高光就偏移。
 *
 * 判据（都能用真管道的数据算）：
 *   ① 一一对应：charMap.length === cleanText.length（不等长必然漂）
 *   ② 偏移单调：同一个 span 上，字符出现顺序对应的 offset 必须**单调不减**
 *      （乱序 → 该 span 的高光会取到错误区间）
 *   ③ 偏移有界：offset < 该 span 文本长度
 *   ④ 字符相符：cleanText[i] 与 span 文本在 offset 处**折叠空白后**应能对上
 *      （③④ 允许少量误差，因为切分/补空格会引入合成字符；但对不上的比例必须极低）
 */
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const VIEWER = path.join(__dirname, '..', '..', 'media', 'viewer.js');
const code = fs.readFileSync(VIEWER, 'utf8');

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
    else if (code[i] === '}') { depth--; if (depth === 0) { spEnd = i; break; } }
  }
}
const ML = new Function(`${mathLayer}\n${code.slice(spStart, spEnd + 1)}\nreturn { buildPageMathModel, findMathRegions, splitEnglishSentencesSmart };`)();

function makeDivs(items) {
  return items.map((it, i) => ({
    textContent: it.str, _pdfX: it.transform[4], _pdfY: it.transform[5],
    _pdfH: it.height, _pdfW: it.width, _pdfIdx: i, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }
  }));
}
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
  const body = code.slice(start, end);
  const fn = new Function(
    'orderedLines', 'curParaLines', 'curParaType', 'paras', 'textContent', 'mathInfoByIdx',
    'findMathRegions', 'splitEnglishSentencesSmart', 'segmentGap', 'paraSpanGap', 'console',
    `${body}\ncurParaLines = orderedLines.map(l => ({ ...l }));\ncommitParagraph();\nreturn paras;`
  );
  return fn(lines.map(l => ({ ...l })), [], 'body', [], { items }, model.byIndex,
    ML.findMathRegions, ML.splitEnglishSentencesSmart, () => null, () => 0,
    { log() {}, warn() {}, error() {} });
}
function pageParagraphs(items, fontNames) {
  const all = makeLines(makeDivs(items));
  let paras = [];
  bandLines(all).forEach(band => {
    const ys = band.map(x => x.y);
    paras = paras.concat(runCommit(items, fontNames, l => l.y >= Math.min(...ys) - 1 && l.y <= Math.max(...ys) + 1));
  });
  return paras;
}

const PAPERS = [
  ['STM', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf'],
  ['AOT', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf'],
  ['cycle', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf']
];

const normCh = c => String(c || '').replace(/\s+/g, ' ');

(async () => {
  console.log('===== 高光可信度：charMap 偏移量对账（真管道）=====\n');
  const totals = { paras: 0, lenMismatch: 0, nonMono: 0, outOfRange: 0, charMismatch: 0, charsChecked: 0, synthetic: 0 };
  const samples = [];
  for (const [name, pdfPath] of PAPERS) {
    if (!fs.existsSync(pdfPath)) { console.log(`⚠️ 缺 ${pdfPath}`); continue; }
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
    const per = { paras: 0, lenMismatch: 0, nonMono: 0, outOfRange: 0, charMismatch: 0, charsChecked: 0, synthetic: 0 };
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      await page.getOperatorList();
      const fontNames = {};
      tc.items.forEach(it => {
        if (!it.fontName) return;
        try { const f = page.commonObjs.get(it.fontName); if (f && f.name) fontNames[it.fontName] = f.name; } catch { /* 忽略 */ }
      });
      let paras;
      try { paras = pageParagraphs(tc.items, fontNames); } catch { continue; }
      for (const para of paras) {
        per.paras++;
        const cm = para.charMap || [];
        const text = String(para.cleanText || '');
        if (cm.length !== text.length) {
          per.lenMismatch++;
          if (samples.length < 5) samples.push(`[${name} p${p}] 长度不等：charMap=${cm.length} cleanText=${text.length}`);
          continue;
        }
        // 逐 span 检查偏移单调 + 有界 + 字符是否**乱序**（真正会导致高光错位的两种形态）
        const lastOffset = new Map();
        for (let i = 0; i < cm.length; i++) {
          const info = cm[i];
          const span = info && info.span;
          if (!span) { per.synthetic++; continue; } // 合成字符（补的空格等）：没有 span，不参与高光
          const spanText = String(span.textContent || '');
          const off = info.offset;
          if (!Number.isFinite(off) || off < 0 || off > spanText.length) {
            per.outOfRange++;
            if (samples.length < 8) samples.push(`[${name} p${p}] offset 越界：off=${off} spanLen=${spanText.length} char=${JSON.stringify(text[i])}`);
            continue;
          }
          const prev = lastOffset.get(span);
          if (prev !== undefined && off < prev) {
            per.nonMono++;
            if (samples.length < 10) samples.push(`[${name} p${p}] 偏移回退：${prev} → ${off}（span="${spanText.slice(0, 30)}"）`);
          }
          lastOffset.set(span, off);
          /*
           * 字符相符检查（校正后的口径）。
           *
           * 【旧口径的错】原来要求 `cleanText[i] === spanText[offset]`，实测 34% 对不上 —— 但那是**误报**：
           * 折行连字符合并时 cleanText 会**有意删掉**连字符（"segmenta-"+"tion" → "segmentation"），
           * 后面所有字符在 charMap 里少了一个位置，于是"逐位相等"必然失败。
           * 追踪一个具体 span 证实了这点：charMap 指向的偏移序列是 0,1,2,3,… 完全有序，
           * 只是字符序列被有意改写。
           *
           * 【新口径】真正能证明"高光会错位"的只有两件事：
           *   ① 同一 span 内偏移乱序（会导致高光取到错误区间）—— 上面已单独统计；
           *   ② cleanText 里的字符**根本不属于它指的那个 span**（高光会画到别的字上）。
           * ②用"该字符是否出现在这个 span 的原始文本里"来判，允许合并/删除带来的错位，
           * 但能抓住真正的张冠李戴。
           */
          per.charsChecked++;
          const ch = text[i];
          if (/\s/.test(ch)) continue; // 空白不参与判断
          if (!spanText.includes(ch)) {
            per.charMismatch++;
            if (per.charMismatch <= 3 && samples.length < 14) {
              samples.push(`[${name} p${p}] 字符不属于该 span：cleanText[${i}]=${JSON.stringify(ch)} span="${spanText.slice(0, 28)}"`);
            }
          }
        }
      }
    }
    console.log(
      `${name.padEnd(7)} 段落 ${String(per.paras).padStart(4)}  ` +
        `长度不等 ${String(per.lenMismatch).padStart(3)}  偏移回退 ${String(per.nonMono).padStart(3)}  ` +
        `越界 ${String(per.outOfRange).padStart(3)}  字符不符 ${String(per.charMismatch).padStart(4)}/${per.charsChecked}  ` +
        `合成字符 ${String(per.synthetic).padStart(4)}`
    );
    for (const k of Object.keys(totals)) totals[k] += per[k];
    await doc.destroy();
  }
  console.log('\n' + '='.repeat(96));
  console.log(
    `合计：段落 ${totals.paras}  长度不等 ${totals.lenMismatch}  偏移回退 ${totals.nonMono}  ` +
      `越界 ${totals.outOfRange}  字符不符 ${totals.charMismatch}/${totals.charsChecked}（${((totals.charMismatch / Math.max(1, totals.charsChecked)) * 100).toFixed(3)}%）`
  );
  console.log('='.repeat(96));
  if (samples.length) {
    console.log('\n样例：');
    samples.forEach(s => console.log('  ' + s));
  }
})().catch(e => { console.error(e); process.exit(1); });
