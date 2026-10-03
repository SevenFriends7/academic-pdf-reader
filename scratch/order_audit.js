/**
 * 阅读顺序审计工具（order_audit）。
 *
 * 【为什么需要它】阅读顺序的 bug 只在"特定版面的某一页"暴露（实测 STM 第 6 页：
 * 右栏的 Table 3 被排到左栏 Table 2 之前，左栏 Table 2 又被排到正文之后）。
 * 单测只能覆盖已知的那一页，改完布局代码必须**逐页**扫过所有样例论文，
 * 把"修复前违规页清单"当基线，再逐页对比修复后，否则容易按下葫芦浮起瓢。
 *
 * 判据（三类）：
 *   V1 栏序倒挂：同一页里，col2 的正文段落之后又出现 col1 的正文段落。
 *   V2 图表单元离散：同一个图表单元（数据行 + 图注）的段落不再连续，
 *      中间被正文/别的块隔开（实测 STM 第 6 页 Table 1 与 Table 3 的数据行被并成一段）。
 *   V3 半句断裂：一段以非句末标点结尾（句中被截断），紧随其后的段落既不是它的续接、
 *      也不是同类段落 → 说明中间被塞进了不该在这里的内容。
 *
 * ⚠️ V2 的"图表单元"判据**必须与 media/viewer.js 的 sameFigureUnit 一致**（见 buildFigureUnits）。
 * 判据本身就是"什么算同一张图表"的定义；两边不一致时，viewer 正确分开的两张表会被审计
 * 当成"被拆散的同一张"而误报——这个坑实测踩过一次。
 *
 * ⚠️ V3 会连带报出"既有分类问题"：表格数据行/公式行被误判成正文时，段落自然以数字收尾、
 * 又被图表段落打断。这类不是排序 bug，看结果时要区分（例如 AOT p1 的作者邮箱行）。
 *
 * 用法：
 *   PAPERS_DIR=<论文目录> node scratch/order_audit.js                 # 扫全部样例论文
 *   PAPERS_DIR=... node scratch/order_audit.js --only STM.pdf         # 只看一篇
 *   PAPERS_DIR=... node scratch/order_audit.js --json before.json     # 结果落盘，便于 before/after 对比
 *   PAPERS_DIR=... node scratch/order_audit.js --verbose              # 违规页打印完整段落序列
 *   VIEWER_SRC=<另一份 viewer.js>                                      # 对旧版本跑，做 before/after 对照
 *     （旧版本：git show HEAD:media/viewer.js > scratch/_old_viewer.js）
 */
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(ROOT, 'test-papers');
const PAPERS = ['AOT.pdf', 'cycle.pdf', 'STM.pdf'];

const argv = process.argv.slice(2);
const argOf = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const onlyFile = argOf('--only');
const jsonOut = argOf('--json');
const verbose = argv.includes('--verbose');

const code = fs.readFileSync(process.env.VIEWER_SRC || path.join(ROOT, 'media', 'viewer.js'), 'utf8');

/** 抽出排版管线（到 orderedLines 生成为止）——锚点与 paragraph_truth.js 一致 */
function extractLayout(src) {
  const start = src.indexOf('const detectColumnStructure = (spanList, pageW) => {');
  const end = src.indexOf('// 9. 段落聚合并构建字符级精确映射表');
  if (start < 0 || end < 0) return null;
  // eslint-disable-next-line no-new-func
  return new Function(
    'spans',
    'pagePdfW',
    'pagePdfH',
    'pageNum',
    'console',
    `${src.slice(start, end)}\n return { orderedLines, gutterX, isSingleColumnPage, captionLabelRegex };`
  );
}

/** 抽出段落聚合（commitParagraph + 主循环 + 9.5 跨栏续接） */
function extractParagraphizer(src) {
  const start = src.indexOf('    function commitParagraph() {');
  const endMarker = '    let bodyCount = 0;';
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) return null;
  // eslint-disable-next-line no-new-func
  return new Function(
    'orderedLines',
    'captionLabelRegex',
    'pageNum',
    'splitEnglishSentencesSmart',
    'isSingleColumnPage',
    'gutterX',
    'console',
    `let paras = [];
     let curParaLines = [];
     let curParaType = 'body';
     ${src.slice(start, end)}
     return paras;`
  );
}

const layout = extractLayout(code);
const paragraphize = extractParagraphizer(code);
if (!layout || !paragraphize) {
  console.error('代码抽取失败（viewer.js 的锚点可能变了）');
  process.exit(1);
}

const simpleSplitter = t =>
  (t || '')
    .split(/(?<=[.!?])\s+(?=[A-Z(“"'])/)
    .map(s => s.trim())
    .filter(Boolean);

const textOf = l => l.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
const hug = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** 段落所属栏：按它各行的 section 投票（跨栏合并过的段落会同时有 col1/col2） */
function paraColumns(para, spanLine) {
  const votes = { col1: 0, col2: 0, other: 0 };
  (para.rawSpans || []).forEach(sp => {
    const line = spanLine.get(sp);
    if (!line) return;
    if (line.section === 'col1') votes.col1++;
    else if (line.section === 'col2') votes.col2++;
    else votes.other++;
  });
  return votes;
}

/**
 * 判定"这段是句中被截断的"：结尾不是句末标点，也不是冒号/分号这类有意停顿。
 *
 * 末尾的页码要先剥掉：段末行距不够大时页码会被并进正文段落
 * （实测 STM 第 6 页右栏末段 "…data syn-" + 页码 "9231" → 段落以 "data syn9231" 收尾），
 * 不剥的话每一页都会被误报成"半句断裂"。
 */
const endsMidSentence = t => {
  const s = hug(t).replace(/\s*\b\d{1,4}\s*$/, '').trim();
  if (!s) return false;
  if (/[.!?。！？]["'”’)\]]*$/.test(s)) return false;
  if (/[:;]$/.test(s)) return false;
  return true;
};
/** 续句特征：以小写字母、数字或左括号开头 */
const looksContinuation = t => /^[a-z0-9(“"'\[]/.test(hug(t));
/**
 * 像公式行（文本层残渣）的段落：短、且含多个数学符号。
 * 公式段落紧跟正文段是**正常**排版（正文引出公式），不该算"半句断裂"。
 * 注意 `|` 会被 viewer 的 isKeywordLine 判成 keywords，那是误判，这里一并当公式看。
 */
const looksEquation = t => {
  const s = hug(t);
  if (!s || s.length > 140) return false;
  const marks = (s.match(/[=⊂∈∑√̂^_{}|+−±×]/g) || []).length;
  return marks >= 1 && marks / s.length > 0.06;
};

/**
 * 把页面级图表行（caption / figure-label / cross）按 viewer.js 的同一套规则聚成块：
 * 同 section + y 相邻（≤30pt）+ 横向重叠。再由块聚成"图表单元"。
 *
 * 【单元判据必须与 viewer.js 的 sameFigureUnit 一致】判据本身就是"什么算同一张图表"的
 * 定义；两边不一致的话，审计会把 viewer 正确分开的两张表当成"被拆散的同一张"而误报。
 * 三条规矩：① 上块是图注 → 不合并（图注在下，说明下面是另一张图表）；
 * ② 下块是图注 → 合并；③ 两块都是内容 → 中间夹着图注就不合并。
 */
function buildFigureUnits(lines) {
  const pageLines = lines.filter(l => l.section === 'cross' || l.section === 'caption' || l.section === 'figure-label');
  const sorted = [...pageLines].sort((a, b) => b.y - a.y);
  const blocks = [];
  sorted.forEach(l => {
    let host = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.section !== l.section) continue;
      if (Math.abs(b.bottomY - l.y) > 30) continue;
      if (!(b.minX <= l.maxX + 20 && l.minX <= b.maxX + 20)) continue;
      host = b;
      break;
    }
    if (host) {
      host.lines.push(l);
      host.bottomY = Math.min(host.bottomY, l.y);
      host.minX = Math.min(host.minX, l.minX);
      host.maxX = Math.max(host.maxX, l.maxX);
    } else {
      blocks.push({ section: l.section, lines: [l], topY: l.y, bottomY: l.y, minX: l.minX, maxX: l.maxX });
    }
  });

  const FIG_UNIT_GAP = 120;
  const overlap = (a, b) => a.minX <= b.maxX + 20 && b.minX <= a.maxX + 20;
  const sameUnit = (a, b) => {
    const [upper, lower] = a.topY >= b.topY ? [a, b] : [b, a];
    const gap = upper.bottomY - lower.topY;
    if (gap < 0 || gap > FIG_UNIT_GAP) return false;
    if (!overlap(a, b)) return false;
    if (upper.section === 'caption') return false;
    if (lower.section === 'caption') return true;
    const x1 = Math.min(a.minX, b.minX);
    const x2 = Math.max(a.maxX, b.maxX);
    return !blocks.some(
      c =>
        c.section === 'caption' && overlap(c, { minX: x1, maxX: x2 }) && c.topY <= upper.bottomY + 1 && c.bottomY >= lower.topY - 1
    );
  };

  const parent = blocks.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (sameUnit(blocks[i], blocks[j])) union(i, j);
    }
  }
  const groups = new Map();
  blocks.forEach((b, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(b);
  });
  return [...groups.values()];
}

(async () => {
  const report = { papers: [], totals: { v1: 0, v2: 0, v3: 0, pages: 0, badPages: 0 } };

  for (const file of PAPERS) {
    if (onlyFile && onlyFile !== file) continue;
    const full = path.join(PAPERS_DIR, file);
    if (!fs.existsSync(full)) {
      console.log(`（跳过 ${file}：不存在）`);
      continue;
    }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(full)), useSystemFonts: false }).promise;
    const paper = { file, pages: [] };
    report.papers.push(paper);

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const vp = page.getViewport({ scale: 1.0 });
      const tc = await page.getTextContent();
      const spans = tc.items
        .filter(i => i.str && i.str.trim())
        .map(i => ({
          textContent: i.str,
          _pdfX: i.transform[4],
          _pdfY: i.transform[5],
          _pdfH: i.height,
          _pdfW: i.width,
          setAttribute() {}
        }));
      if (spans.length === 0) continue;

      const r = layout(spans, vp.width, vp.height, pageNum, { log() {} });
      const paras = paragraphize(
        r.orderedLines,
        r.captionLabelRegex,
        pageNum,
        simpleSplitter,
        r.isSingleColumnPage,
        r.gutterX,
        { log() {} }
      );
      if (paras.length === 0) continue;

      // span → line 映射（用于还原每个段落占用了哪些行、属于哪一栏）
      const spanLine = new Map();
      r.orderedLines.forEach(l => l.spans.forEach(sp => spanLine.set(sp, l)));
      const paraOfLine = new Map();
      paras.forEach((p, pi) => (p.rawSpans || []).forEach(sp => {
        const l = spanLine.get(sp);
        if (l && !paraOfLine.has(l)) paraOfLine.set(l, pi);
      }));

      const problems = [];

      // ---- V1 栏序倒挂 ----
      let seenCol2Body = false;
      paras.forEach((p, pi) => {
        if (p.type !== 'body') return;
        const v = paraColumns(p, spanLine);
        const col = v.col2 > v.col1 ? 'col2' : v.col1 > v.col2 ? 'col1' : null;
        if (col === 'col2') seenCol2Body = true;
        else if (col === 'col1' && seenCol2Body) {
          problems.push({ kind: 'V1', at: pi, detail: `col2 正文之后又出现 col1 正文：${hug(p.cleanText).slice(0, 40)}` });
        }
      });

      // ---- V2 图表单元离散 ----
      const units = buildFigureUnits(r.orderedLines);
      units.forEach(u => {
        const lines = u.reduce((acc, b) => acc.concat(b.lines), []);
        if (lines.length < 2) return; // 只有一行文字的"单元"没有连续性可言
        const pids = [...new Set(lines.map(l => paraOfLine.get(l)).filter(v => v !== undefined))].sort((a, b) => a - b);
        if (pids.length < 2) return;
        const span = pids[pids.length - 1] - pids[0] + 1;
        if (span !== pids.length) {
          const label = hug(textOf(lines[0])).slice(0, 30);
          const missing = [];
          for (let i = pids[0]; i <= pids[pids.length - 1]; i++) if (!pids.includes(i)) missing.push(i);
          problems.push({
            kind: 'V2',
            at: pids[0],
            detail: `图表单元（${label}…）的段落不连续：段落 ${pids.join(',')}，中间夹了 ${missing
              .map(i => `[${i}]${paras[i] ? paras[i].type : '?'}`)
              .join(' ')}`
          });
        }
      });

      // ---- V3 半句断裂 ----
      for (let i = 0; i < paras.length - 1; i++) {
        const a = paras[i];
        const b = paras[i + 1];
        if (!['body', 'abstract', 'significance'].includes(a.type)) continue;
        // 只关心"普通正文"被截断；图表/标题自己本来就不以句末标点结尾
        if (!endsMidSentence(a.cleanText)) continue;
        const bBody = ['body', 'abstract', 'significance'].includes(b.type);
        if (bBody && looksContinuation(b.cleanText)) continue; // 正常续接
        if (looksEquation(b.cleanText)) continue; // 正文引出的公式段，属正常排版
        problems.push({
          kind: 'V3',
          at: i,
          detail:
            `[${i}]${a.type} 以「…${hug(a.cleanText).slice(-24)}」截断，` +
            `下一段是 [${i + 1}]${b.type}「${hug(b.cleanText).slice(0, 24)}…」`
        });
      }

      report.totals.pages++;
      report.totals.v1 += problems.filter(p => p.kind === 'V1').length;
      report.totals.v2 += problems.filter(p => p.kind === 'V2').length;
      report.totals.v3 += problems.filter(p => p.kind === 'V3').length;
      if (problems.length) report.totals.badPages++;

      const sig = paras.map(p => `${p.type}:${hug(p.cleanText).slice(0, 40)}`);
      paper.pages.push({ page: pageNum, sig, problems });

      if (problems.length) {
        console.log(`${file} p${pageNum}  ${problems.map(p => p.kind).join(',')}`);
        problems.forEach(p => console.log(`    ${p.kind} ${p.detail}`));
      }
      if (verbose) {
        console.log(`  ${file} p${pageNum} 序列：`);
        sig.forEach((s, i) => console.log(`    [${String(i).padStart(2)}] ${s}`));
      }
    }
    console.log(`${file}: ${doc.numPages} 页`);
  }

  console.log('\n===== 汇总 =====');
  console.log(`违规页 ${report.totals.badPages} / ${report.totals.pages} 页；V1=${report.totals.v1} V2=${report.totals.v2} V3=${report.totals.v3}`);
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
    console.log(`明细已写入 ${jsonOut}`);
  }
})();
