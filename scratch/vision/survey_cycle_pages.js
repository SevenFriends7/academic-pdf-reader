/**
 * 翻一遍 cycle.pdf 归档页（1~6），为任务 A/B 选页并列出 merge_next 候选对。
 * 只读全局存储，不调 API、不造数据。
 */
const fs = require('fs');
const path = require('path');

const TERM = /[.!?]["')\]]?$/;
const dir = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
const file = process.argv[2] || 'paper_1f6c2345c825e6b5dac7170135b540b1.json';
const paper = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const pa = paper.pageArchive || {};

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

/** 短标签型：短、不以句末标点收尾、不含句号 → 像图内文字/子图编号/轴标签 */
function isLabelish(t) {
  if (!t) return false;
  if (t.length > 60) return false;
  if (/[.!?]/.test(t)) return false;
  return true;
}

const report = { file, pdfName: paper.pdfName, pages: [] };
for (const k of Object.keys(pa).sort((a, b) => Number(a) - Number(b))) {
  const arr = pa[k] || [];
  const rows = arr.map((s, idx) => {
    const t = clean(s.cleanText);
    const next = arr[idx + 1] ? clean(arr[idx + 1].cleanText) : null;
    return {
      i: s.id, type: s.type, len: t.length, text: t,
      endsWithoutTerminal: !TERM.test(t),
      startsLowercaseOrDigit: /^[a-z(\d]/.test(t),
      nextI: arr[idx + 1] ? arr[idx + 1].id : null,
      nextType: arr[idx + 1] ? arr[idx + 1].type : null,
      nextStartsLowercaseOrDigit: next ? /^[a-z(\d]/.test(next) : false,
      labelish: isLabelish(t)
    };
  });
  const mergeCandidates = rows.filter(r => r.endsWithoutTerminal && r.nextStartsLowercaseOrDigit);
  const labels = rows.filter(r => r.labelish);
  report.pages.push({
    page: Number(k),
    count: arr.length,
    typeCounts: rows.reduce((a, r) => { a[r.type] = (a[r.type] || 0) + 1; return a; }, {}),
    labelishCount: labels.length,
    labelish: labels.map(r => ({ i: r.i, type: r.type, len: r.len, text: r.text.slice(0, 60) })),
    mergeCandidateCount: mergeCandidates.length,
    mergeCandidates: mergeCandidates.map(r => ({
      prevI: r.i, prevType: r.type, prevTail: r.text.slice(-60),
      nextI: r.nextI, nextType: r.nextType,
      nextHead: clean(arr.find(x => x.id === r.nextI)?.cleanText).slice(0, 60)
    })),
    rows
  });
}

fs.writeFileSync(path.join(__dirname, 'cycle_pages_survey.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(`存档 ${file}　pdf=${report.pdfName}\n`);
for (const p of report.pages) {
  console.log(`===== page ${p.page}：${p.count} 段　类型=${JSON.stringify(p.typeCounts)}`);
  console.log(`  短标签型 ${p.labelishCount} 条　merge_next 候选对 ${p.mergeCandidateCount} 对`);
  for (const l of p.labelish) console.log(`     label [${l.i}] (${l.type}) len=${l.len} ${JSON.stringify(l.text)}`);
  for (const m of p.mergeCandidates) {
    console.log(`     MERGE-CAND [${m.prevI}](${m.prevType}) → [${m.nextI}](${m.nextType})`);
    console.log(`        上段结尾: ${JSON.stringify(m.prevTail)}`);
    console.log(`        下段开头: ${JSON.stringify(m.nextHead)}`);
  }
  console.log('  全部段：');
  for (const r of p.rows) {
    console.log(`     [${r.i}] ${String(r.type).padEnd(10)} len=${String(r.len).padStart(4)} ${r.endsWithoutTerminal ? '尾无标点' : '        '} ${JSON.stringify(r.text.slice(0, 78))}`);
  }
  console.log('');
}
console.log('明细已存 scratch/vision/cycle_pages_survey.json');
