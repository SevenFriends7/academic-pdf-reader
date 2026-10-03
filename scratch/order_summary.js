/**
 * 阅读顺序 before/after 的**每页违规摘要**：一眼看出哪一页变好、哪一页变差。
 *
 * 用法：node scratch/order_summary.js <before.json> <after.json>
 */
const fs = require('fs');

const load = p => {
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = new Map();
  r.papers.forEach(pp => pp.pages.forEach(pg => m.set(pp.file + '#' + pg.page, pg)));
  return { m, r };
};
const B = load(process.argv[2]);
const A = load(process.argv[3]);
const keys = [...new Set([...B.m.keys(), ...A.m.keys()])];
const cnt = pg => {
  const o = { V1: 0, V2: 0, V3: 0 };
  (pg ? pg.problems : []).forEach(p => (o[p.kind] = (o[p.kind] || 0) + 1));
  return o;
};

const rows = [];
for (const k of keys) {
  const b = cnt(B.m.get(k));
  const a = cnt(A.m.get(k));
  const db = a.V1 + a.V2 + a.V3 - (b.V1 + b.V2 + b.V3);
  const orderChanged = JSON.stringify(B.m.get(k).sig) !== JSON.stringify(A.m.get(k).sig);
  if (db === 0 && !orderChanged) continue;
  const verdict = db > 0 ? 'WORSE' : db < 0 ? 'better' : 'unchanged';
  rows.push([k, `V1 ${b.V1}->${a.V1}  V2 ${b.V2}->${a.V2}  V3 ${b.V3}->${a.V3}`, verdict]);
}
rows.sort((x, y) => (x[2] === 'WORSE' ? -1 : y[2] === 'WORSE' ? 1 : 0));
rows.forEach(r => console.log(r[0].padEnd(14), r[1].padEnd(34), r[2]));
console.log(
  `\n总计 before V1=${B.r.totals.v1} V2=${B.r.totals.v2} V3=${B.r.totals.v3}  |  ` +
    `after V1=${A.r.totals.v1} V2=${A.r.totals.v2} V3=${A.r.totals.v3}`
);
