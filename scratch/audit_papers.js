/**
 * 多论文全页审计：把 viewer.js 里真实的布局管线抽出来，跑遍所有 PDF 的所有页，
 * 自动挑出可疑页面。目的：验证逻辑是否**与具体论文无关**。
 *
 * 用法：node scratch/audit_papers.js [可选：只看某篇]
 */
const fs = require('fs');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(__dirname, '..', 'test-papers'); // 论文 PDF 目录（可用 PAPERS_DIR 覆盖）
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

function extractPipeline(src) {
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
    `${src.slice(start, end)}\n return { orderedLines, isSingleColumnPage, gutterX, captionLabelRegex };`
  );
}
const runPipeline = extractPipeline(code);
if (!runPipeline) {
  console.error('管线抽取失败');
  process.exit(1);
}

// 跨栏合并检测：**结构性**判据——同一行里存在"跨过分栏线且间隙明显"的两个 span，
// 那才是左右栏被粘成一行。不能用文本正则（into/rain/main 这类正常词会全部误命中）。
function countMergedLines(lines, gutter) {
  let merged = 0;
  lines.forEach(l => {
    const sp = [...l.spans]
      .map(s => ({ x: s._pdfX || 0, w: s._pdfW || 0 }))
      .sort((a, b) => a.x - b.x);
    for (let i = 1; i < sp.length; i++) {
      const prevEnd = sp[i - 1].x + sp[i - 1].w;
      const gap = sp[i].x - prevEnd;
      if (gap > 8 && prevEnd < gutter && sp[i].x > gutter) {
        merged++;
        return;
      }
    }
  });
  return merged;
}

function analyzePage(lines, gutter, isSingleColumnPage) {
  const counts = {};
  lines.forEach(l => (counts[l.section] = (counts[l.section] || 0) + 1));
  const total = lines.length || 1;

  // 连续同类型最长片段
  let maxRunFig = 0;
  let maxRunCap = 0;
  let run = 0;
  let curType = null;
  lines.forEach(l => {
    if (l.section === curType) run++;
    else {
      curType = l.section;
      run = 1;
    }
    if (curType === 'figure-label') maxRunFig = Math.max(maxRunFig, run);
    if (curType === 'caption') maxRunCap = Math.max(maxRunCap, run);
  });

  // 跨栏合并只在**双栏页**才有意义；单栏页没有沟槽，检查它只会产生假警报
  const mergedLines = isSingleColumnPage ? 0 : countMergedLines(lines, gutter);

  const flags = [];
  const figRatio = (counts['figure-label'] || 0) / total;
  const capRatio = (counts['caption'] || 0) / total;

  if (figRatio > 0.55) flags.push(`图标签占比 ${(figRatio * 100).toFixed(0)}%`);
  if (capRatio > 0.35) flags.push(`图注占比 ${(capRatio * 100).toFixed(0)}%`);
  if (maxRunCap > 12) flags.push(`图注连续 ${maxRunCap} 行`);
  if (maxRunFig > 60) flags.push(`图标签连续 ${maxRunFig} 行`);
  if (mergedLines >= 1) flags.push(`跨栏合并 ${mergedLines} 行`);
  const c1 = counts['col1'] || 0;
  const c2 = counts['col2'] || 0;
  const cross = counts['cross'] || 0;
  if (c1 >= 8 && c2 >= 8) {
    const r = Math.max(c1, c2) / Math.min(c1, c2);
    if (r > 4) flags.push(`两栏行数悬殊 ${c1}:${c2}`);
  }
  // 真正的异常：判定为**双栏**但几乎所有行都落在 col1（分栏线位置不对）
  if (!isSingleColumnPage && total > 25 && (c1 + cross) / total > 0.92 && c2 <= 2) {
    flags.push(`判为双栏却 ${c1 + cross}/${total} 行在左栏/通栏`);
  }
  return { counts, total, flags, maxRunCap, maxRunFig, mergedLines, single: isSingleColumnPage };
}

(async () => {
  const dir = PAPERS_DIR;
  let pdfs = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'));
  if (process.argv[2]) pdfs = pdfs.filter(f => f.includes(process.argv[2]));

  const summary = [];
  for (const f of pdfs) {
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(dir, f))), useSystemFonts: false })
        .promise;
    } catch (e) {
      console.log(`${f}: 打不开 (${e.message})`);
      continue;
    }
    console.log(`\n${'='.repeat(78)}\n${f}  共 ${doc.numPages} 页\n${'='.repeat(78)}`);
    let bad = 0;
    for (let pn = 1; pn <= doc.numPages; pn++) {
      let page, vp, tc;
      try {
        page = await doc.getPage(pn);
        vp = page.getViewport({ scale: 1.0 });
        tc = await page.getTextContent();
      } catch (e) {
        continue;
      }
      const spans = tc.items
        .filter(i => i.str && i.str.trim())
        .map(i => ({ textContent: i.str, _pdfX: i.transform[4], _pdfY: i.transform[5], _pdfH: i.height, _pdfW: i.width }));
      if (spans.length < 5) continue;

      let r;
      try {
        r = runPipeline(spans, vp.width, vp.height, pn, { log() {} });
      } catch (e) {
        console.log(`  p${String(pn).padStart(3)}  ❌ 管线抛错: ${e.message}`);
        bad++;
        continue;
      }
      const a = analyzePage(r.orderedLines, r.gutterX, r.isSingleColumnPage);
      const tag = a.flags.length ? '⚠️ ' + a.flags.join(' | ') : 'ok';
      if (a.flags.length) bad++;
      console.log(
        `  p${String(pn).padStart(3)}  行${String(a.total).padStart(4)}  ${a.single ? '单栏' : '双栏'}  ${JSON.stringify(
          a.counts
        ).padEnd(54)} ${tag}`
      );
      summary.push({ file: f, page: pn, ...a });
    }
    console.log(`  → ${f}: ${bad} 个可疑页 / ${doc.numPages} 页`);
  }

  console.log(`\n${'='.repeat(78)}\n汇总：可疑页 ${summary.filter(s => s.flags.length).length} / 总页 ${summary.length}\n${'='.repeat(78)}`);
  const kinds = {};
  summary.filter(s => s.flags.length).forEach(s => s.flags.forEach(f => (kinds[f.replace(/[\d.]+/g, 'N')] = (kinds[f.replace(/[\d.]+/g, 'N')] || 0) + 1)));
  Object.entries(kinds).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)} × ${k}`));
})();
