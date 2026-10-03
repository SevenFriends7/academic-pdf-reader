/**
 * before/after 阅读顺序对比：读两份 order_audit.js 的 --json 结果，逐页比较。
 *
 * 用法：node scratch/order_diff.js scratch/order-before.json scratch/order-after.json [--file STM.pdf] [--page 6]
 */
const fs = require('fs');

const [beforePath, afterPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const argv = process.argv.slice(2);
const argOf = n => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const onlyFile = argOf('--file');
const onlyPage = Number(argOf('--page') || 0);

const load = p => {
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = new Map();
  r.papers.forEach(paper => paper.pages.forEach(pg => m.set(`${paper.file}#${pg.page}`, pg)));
  return { report: r, map: m };
};
const B = load(beforePath);
const A = load(afterPath);

const keys = [...new Set([...B.map.keys(), ...A.map.keys()])].sort((x, y) => {
  const [f1, p1] = x.split('#');
  const [f2, p2] = y.split('#');
  return f1 === f2 ? Number(p1) - Number(p2) : f1.localeCompare(f2);
});

let changed = 0;
let vDelta = { V1: 0, V2: 0, V3: 0 };
for (const k of keys) {
  const [file, pageStr] = k.split('#');
  const page = Number(pageStr);
  if (onlyFile && file !== onlyFile) continue;
  if (onlyPage && page !== onlyPage) continue;
  const b = B.map.get(k);
  const a = A.map.get(k);
  const bs = b ? JSON.stringify(b.sig) : '(无)';
  const as = a ? JSON.stringify(a.sig) : '(无)';
  const countOf = pg => {
    const o = { V1: 0, V2: 0, V3: 0 };
    (pg ? pg.problems : []).forEach(p => (o[p.kind] = (o[p.kind] || 0) + 1));
    return o;
  };
  const bc = countOf(b);
  const ac = countOf(a);
  ['V1', 'V2', 'V3'].forEach(k2 => (vDelta[k2] += ac[k2] - bc[k2]));
  const same = bs === as;
  if (!same) changed++;
  const dc = ['V1', 'V2', 'V3']
    .filter(t => ac[t] !== bc[t])
    .map(t => `${t} ${bc[t]}→${ac[t]}`)
    .join(' ');
  if (same && !dc) continue;

  console.log(`\n=== ${k} ${same ? '（段落序列相同）' : `（序列变化）${dc ? ' ' + dc : ''}`}`);
  if (!same) {
    console.log('  before:');
    (b ? b.sig : []).forEach((s, i) => console.log(`    [${String(i).padStart(2)}] ${s}`));
    console.log('  after:');
    (a ? a.sig : []).forEach((s, i) => console.log(`    [${String(i).padStart(2)}] ${s}`));
  } else if (dc) {
    console.log('  before:');
    (b.problems || []).forEach(p => console.log(`    ${p.kind} ${p.detail}`));
    console.log('  after:');
    (a.problems || []).forEach(p => console.log(`    ${p.kind} ${p.detail}`));
  }
}
console.log(`\n序列发生变化的页：${changed}`);
console.log(`违规数变化：V1 ${vDelta.V1 >= 0 ? '+' : ''}${vDelta.V1}  V2 ${vDelta.V2 >= 0 ? '+' : ''}${vDelta.V2}  V3 ${vDelta.V3 >= 0 ? '+' : ''}${vDelta.V3}`);
console.log(`总计：before V1=${B.report.totals.v1} V2=${B.report.totals.v2} V3=${B.report.totals.v3}`);
console.log(`      after  V1=${A.report.totals.v1} V2=${A.report.totals.v2} V3=${A.report.totals.v3}`);
