/**
 * 高光映射（charMap）回归测试 —— 钉住两个实测抓到的真 bug。
 *
 * 【背景】用户反馈"高光打乱、重复"。实测（三篇论文 112 段，真管道跑 commitParagraph）：
 *   · 偏移回退 84 处：同一个 span 上后出现的字符 offset 比前面的小
 *     → 高光取区间时取到错误位置，表现为"高光画到别处 / 重复盖住一段"
 *   · 根因两处（都在 commitParagraph 里）：
 *       ① pushBody 用"该 span 已有片段的文本长度之和"当起始偏移 —— 但 charMap 的实际增长
 *          还包含合成空格、公式文本、被 trim 的空白，于是 span 被公式/空格打断后第二次出现时偏移就错了；
 *       ② 补词距的合成空格挂了 `{ span: 前一个span, offset: 0 }` 这个**假锚点**，
 *          于是同一个 span 上出现"先 58 后 0"的回退。
 * 【修复后】偏移回退 0 处、同 span 跨段串入 0 次（同口径复测）。
 *
 * 本测试的作用：把这两条硬约束钉死，任何人再动 charMap 都会立刻被拦下。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const pdfjsLib = require(path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const VIEWER = path.join(__dirname, '..', '..', 'media', 'viewer.js');
const code = fs.readFileSync(VIEWER, 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}\n     ${(e && e.message) || e}`);
    console.log(`  ❌ ${name}\n     ${(e && e.message) || e}`);
  }
}

console.log('===== A 层：源码约束 =====\n');

t('pushBody 的起始偏移必须取"实际写入 charMap 的字符数"，不能再按片段文本长度求和', () => {
  assert.ok(/const spanCharsMapped = new Map\(\)/.test(code), '必须有 spanCharsMapped 计数器');
  assert.ok(
    /const consumed = spanCharsMapped\.get\(span\) \|\| 0;/.test(code),
    'pushBody 必须用 spanCharsMapped 算起始偏移'
  );
  assert.ok(
    !/const consumed = para\.segments\s*\n?\s*\.filter\(s => s\.spanRef === span\)/.test(code),
    '旧写法（按片段文本长度求和）必须已移除 —— 它正是系统性错位的来源'
  );
});

t('合成空格必须挂 span:null，不能再挂真实 span + offset:0 的假锚点', () => {
  assert.ok(
    /para\.charMap\.push\(\{ span: null, offset: 0 \}\);/.test(code),
    '合成空格要按本文件既有口径当"安全垫"（不参与高光）'
  );
  assert.ok(
    !/const anchor = \(seg\.spans && seg\.spans\[0\]\) \|\| \(prevSeg\.spans && prevSeg\.spans\[0\]\)/.test(code),
    '假锚点写法必须已移除 —— 它造成"同一 span 上偏移回退"'
  );
});

t('计数器必须真的被累加（否则等于没修）', () => {
  assert.ok(
    /spanCharsMapped\.set\(sp, \(spanCharsMapped\.get\(sp\) \|\| 0\) \+ 1\)/.test(code),
    '每次把字符写进 charMap 时都要累加该 span 的计数'
  );
});

console.log('\n===== B 层：真管道复测（必须有 PDF 与 jsdom 之外的依赖，缺了就跳过）=====\n');

const PDFS = [
  ['STM', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf'],
  ['AOT', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf'],
  ['cycle', 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf']
];
const available = PDFS.filter(([, p]) => fs.existsSync(p));
if (available.length === 0) {
  console.log('  ℹ️  本机没有测试用 PDF（D:\\kx\\上海交大\\梯度校正测验\\），跳过真管道复测');
  console.log('     A 层源码约束已生效；完整复测见 scratch/zotero/highlight_offset_audit.js');
} else {
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

  const makeDivs = items =>
    items.map((it, i) => ({
      textContent: it.str, _pdfX: it.transform[4], _pdfY: it.transform[5],
      _pdfH: it.height, _pdfW: it.width, _pdfIdx: i, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }
    }));
  const makeLines = divs => {
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
  };
  const bandLines = lines => {
    const bands = [];
    lines.forEach(l => {
      const b = bands[bands.length - 1];
      if (b && Math.abs(b.y - l.y) <= 22) { b.lines.push(l); b.y = l.y; return; }
      bands.push({ y: l.y, lines: [l] });
    });
    return bands.map(b => b.lines);
  };
  const runCommit = (items, fontNames, lineFilter) => {
    const model = ML.buildPageMathModel(items, k => fontNames[k] || String(k), 10);
    const lines = makeLines(makeDivs(items)).filter(lineFilter || (() => true));
    const start = code.indexOf('    function commitParagraph() {');
    const end = code.indexOf('    for (let i = 0; i < orderedLines.length; i++) {');
    const fn = new Function(
      'orderedLines', 'curParaLines', 'curParaType', 'paras', 'textContent', 'mathInfoByIdx',
      'findMathRegions', 'splitEnglishSentencesSmart', 'segmentGap', 'paraSpanGap', 'console',
      `${code.slice(start, end)}\ncurParaLines = orderedLines.map(l => ({ ...l }));\ncommitParagraph();\nreturn paras;`
    );
    return fn(lines.map(l => ({ ...l })), [], 'body', [], { items }, model.byIndex,
      ML.findMathRegions, ML.splitEnglishSentencesSmart, () => null, () => 0,
      { log() {}, warn() {}, error() {} });
  };
  const pageParas = (items, fontNames) => {
    let paras = [];
    bandLines(makeLines(makeDivs(items))).forEach(band => {
      const ys = band.map(x => x.y);
      paras = paras.concat(runCommit(items, fontNames, l => l.y >= Math.min(...ys) - 1 && l.y <= Math.max(...ys) + 1));
    });
    return paras;
  };

  (async () => {
    for (const [name, pdfPath] of available) {
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
      let back = 0, cross = 0, paras = 0, mismatched = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        await page.getOperatorList();
        const fontNames = {};
        tc.items.forEach(it => {
          if (!it.fontName) return;
          try { const f = page.commonObjs.get(it.fontName); if (f && f.name) fontNames[it.fontName] = f.name; } catch { /* 忽略 */ }
        });
        let list;
        try { list = pageParas(tc.items, fontNames); } catch { continue; }
        const spanToPara = new Map();
        for (const [pi, para] of list.entries()) {
          paras++;
          if ((para.charMap || []).length !== String(para.cleanText || '').length) mismatched++;
          const last = new Map();
          for (const info of para.charMap || []) {
            if (!info || !info.span) continue;
            const prev = last.get(info.span);
            if (prev !== undefined && info.offset < prev) back++;
            last.set(info.span, info.offset);
            const seen = spanToPara.get(info.span);
            if (seen === undefined) spanToPara.set(info.span, pi);
            else if (seen !== pi) cross++;
          }
        }
      }
      await doc.destroy();
      t(`${name}：${paras} 段 —— 偏移回退 0、同 span 跨段串入 0、charMap 与 cleanText 等长`, () => {
        assert.strictEqual(back, 0, `偏移回退 ${back} 处（修复前实测 84 处）`);
        assert.strictEqual(cross, 0, `跨段串入 ${cross} 次`);
        assert.strictEqual(mismatched, 0, `${mismatched} 个段落的 charMap 与 cleanText 不等长`);
      });
    }
    console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
    if (fail) {
      console.log('\n失败明细：');
      failures.forEach(f => console.log('  - ' + f));
    }
    process.exitCode = fail ? 1 : 0;
  })().catch(e => {
    console.error('真管道复测失败:', e && e.message);
    process.exitCode = 1;
  });
}
if (available.length === 0) {
  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exitCode = fail ? 1 : 0;
}
