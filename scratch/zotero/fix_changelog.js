/**
 * 修复 CHANGELOG.md 的指数级重复。
 *
 * 【症状（实测）】文件 2.79 MB / 57260 行，`## [1.6.0]` 出现 5632 次、1.5.1 出现 2816 次……
 * 每版正好翻倍 —— 典型指纹是每次发版都把**整个文件**又拼了一遍（而不是只插一节）。
 *
 * 【为什么不能简单去重行】去重行长这样：`## [1.6.0]` 只剩一行，但它下面的
 * "### 变更 / - 公式正确性…" 也会被并到别的版本里去（那些行在多个版本块里都一样），
 * 结果版本与条目对不上号 —— 比重复更坏（等于伪造变更历史）。
 *
 * 【正确做法】按"以 `## [` 开头的行为分块"，每块 = 一个版本的完整内容；
 * 同内容块只留一份；同一版本号若有多份**不同**内容块（历史上真发生过一次编辑），
 * 把各自的条目合并去重。最后按版本号倒序 -> 正序输出。
 *
 * 用法：node scratch/zotero/fix_changelog.js [--write]
 *   不带 --write 只打印诊断报告（默认，安全）
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'CHANGELOG.md');
const WRITE = process.argv.includes('--write');

const raw = fs.readFileSync(FILE, 'utf8');
const lines = raw.split('\n');

// 1) 头部（第一个版本标题之前的所有内容）
const verRe = /^## \[([^\]]+)\](.*)$/;
let firstVer = lines.findIndex(l => verRe.test(l));
if (firstVer < 0) throw new Error('找不到任何 `## [x.y.z]` 版本标题');
const header = lines.slice(0, firstVer);

// 2) 分块
const blocks = [];
let cur = null;
for (let i = firstVer; i < lines.length; i++) {
  const m = verRe.exec(lines[i]);
  if (m) {
    if (cur) blocks.push(cur);
    cur = { version: m[1], rest: m[2] || '', lines: [] };
  } else if (cur) {
    /*
     * 丢掉"孤儿日期行"。
     *
     * 原文件被反复拼接后有两种坏形态，都表现为一行多余的 ` - 2026-10-04`：
     *   形态 A：日期在标题行之后另起一行 —— `## [1.6.0] - 2026-10-04` + ` - 2026-10-04`
     *   形态 B：日期跑到了块正文里（`rest` 里反而是别的），合并同版本多形态时又会把它带回来。
     * 所以这里**无条件**丢掉所有"只有日期"的行 —— 日期在标题行里已经有了，正文再出现就是重复。
     * （实测：只判"块首行"时，51 个版本各残留一行日期。）
     */
    if (/^\s*-\s*\d{4}-\d{2}-\d{2}\s*$/.test(lines[i])) continue;
    cur.lines.push(lines[i]);
  }
}
if (cur) blocks.push(cur);

console.log(`原始：${raw.length} 字节 / ${lines.length} 行 / ${blocks.length} 个版本块`);

// 3) 按版本号聚合，块内容去重
const byVersion = new Map(); // version -> { rest, seen:Set, chunks:[] }
/** 干掉"正文里的孤儿日期行"：日期已经在 `## [x.y.z] - 日期` 标题里了，正文再来一行就是重复 */
const dropOrphanDates = text => text.split('\n').filter(l => !/^\s*-\s*\d{4}-\d{2}-\d{2}\s*$/.test(l)).join('\n');
const chunkKey = c => c.rest + '\u0000' + dropOrphanDates(c.lines.join('\n').replace(/\s+$/, ''));

for (const b of blocks) {
  if (!byVersion.has(b.version)) {
    byVersion.set(b.version, { rest: b.rest, seen: new Set(), chunks: [] });
  }
  const entry = byVersion.get(b.version);
  const key = chunkKey(b);
  if (entry.seen.has(key)) continue; // 完全相同的块：只留一份
  entry.seen.add(key);
  /*
   * `rest`（标题行里 `]` 之后的那段）也可能**只装了一行日期** —— 这是第三种坏形态：
   * 原文件的标题行被拆成了两行，第二行的 ` - 2026-10-04` 被正则当成了标题的 rest。
   * 不在这里清掉的话，它会跟着 `## [x.y.z]${rest}` 被原样写回去（实测就是这么复活的）。
   */
  const cleanedRest = /^\s*-\s*\d{4}-\d{2}-\d{2}\s*$/.test(b.rest) ? '' : b.rest;
  entry.chunks.push(cleanedRest + '\n' + dropOrphanDates(b.lines.join('\n').replace(/\s+$/, '')));
}

// 4) 同一版本多份不同内容 -> 合并条目去重（保留块内结构：### 小标题 + - 条目）
function mergeVersion(entry) {
  if (entry.chunks.length === 1) return entry.chunks[0].replace(/\s+$/, '');
  const seenBullet = new Set();
  const out = [];
  for (const chunk of entry.chunks) {
    for (const line of chunk.split('\n')) {
      const bullet = line.trim();
      if (/^[-*]\s+/.test(bullet)) {
        if (seenBullet.has(bullet)) continue; // 跨块重复的条目
        seenBullet.add(bullet);
      }
      out.push(line);
    }
  }
  return out.join('\n').replace(/\s+$/, '');
}

const parseVer = v => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
};
const versions = [...byVersion.keys()].sort((a, b) => {
  const A = parseVer(a);
  const B = parseVer(b);
  return B[0] - A[0] || B[1] - A[1] || B[2] - A[2];
});

const parts = [header.join('\n').replace(/\s+$/, '')];
for (const v of versions) {
  parts.push(`## [${v}]${byVersion.get(v).rest}\n${mergeVersion(byVersion.get(v))}`);
}
const fixed = parts.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';

console.log(`修复后：${Buffer.byteLength(fixed, 'utf8')} 字节 / ${fixed.split('\n').length} 行 / ${versions.length} 个版本`);
console.log('版本清单（倒序）：' + versions.join(', '));

// 5) 自检：任何一条原始条目都不许丢
const bulletsOf = text =>
  new Set(
    text
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^[-*]\s+/.test(l))
  );
const before = bulletsOf(raw);
const after = bulletsOf(fixed);
const missing = [...before].filter(b => !after.has(b));
console.log(`\n自检：唯一变更条目 ${before.size} 条；修复后 ${after.size} 条；丢失 ${missing.length} 条`);
if (missing.length) {
  console.log('❌ 有内容丢失，拒绝写入：');
  missing.slice(0, 10).forEach(m => console.log('   - ' + m));
  process.exit(1);
}
const versionsBefore = new Set([...raw.matchAll(/^## \[([^\]]+)\]/gm)].map(m => m[1]));
const versionsAfter = new Set(versions);
const lostVersions = [...versionsBefore].filter(v => !versionsAfter.has(v));
console.log(`自检：版本号 ${versionsBefore.size} 个，修复后 ${versionsAfter.size} 个，丢失 ${lostVersions.length} 个`);
if (lostVersions.length) {
  console.log('❌ 有版本丢失：' + lostVersions.join(', '));
  process.exit(1);
}

if (WRITE) {
  fs.writeFileSync(FILE, fixed, 'utf8');
  console.log('\n✅ 已写入 CHANGELOG.md');
} else {
  console.log('\n（未加 --write，仅诊断）');
}
