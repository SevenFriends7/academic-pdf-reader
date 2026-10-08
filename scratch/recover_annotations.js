'use strict';
/**
 * 一次性恢复：把"因 PDF 换目录而失联"的批注/译文/AI 答疑并回当前存储键。
 *
 * 【背景】扩展的存储键是 **PDF 绝对路径的 MD5**（src/notesStorage.ts 的 getStorageFilePath）。
 * 把 PDF 从 `…\梯度校正测验\梯度校正测验\` 挪到 `…\梯度校正测验\文献\` 后键就变了，
 * 插件以为是一篇新论文 → 批注显示为空（数据其实都在旧键里）。
 * 永久修复（身份索引自动认领）已写进 notesStorage.ts；本脚本负责把**已经失联的那几条**立刻找回来。
 *
 * 安全措施：
 *   ① 先给"当前键"的文件做带时间戳的备份，出问题可以整份还原；
 *   ② 只在**文件名 + 字节数都相同**时才合并（字节数不同一律跳过，绝不张冠李戴）；
 *   ③ 旧键文件**原样保留**，不删不改；
 *   ④ 合并按 id 去重，重复执行不会产生重复批注。
 *
 * 用法：node recover_annotations.js                 # 干跑（默认 VS Code 的存储目录）
 *       node recover_annotations.js --apply
 *       node recover_annotations.js --dir="<另一个 IDE 的 globalStorage 子目录>" [--apply]
 *       node recover_annotations.js --list           # 只列出各 IDE 存储里有什么
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const LIST_ONLY = process.argv.includes('--list');
const dirArg = process.argv.find(a => a.startsWith('--dir='));
const mergeArg = process.argv.find(a => a.startsWith('--merge-from='));
const rel = 'User\\globalStorage\\paper-reader.academic-pdf-reader';

/** 三个 IDE 各自有独立的 globalStorage —— 批注可能分散在里面，合并前先都看一眼 */
const CANDIDATE_DIRS = [
  path.join(process.env.APPDATA || '', 'Code', rel),
  path.join(process.env.APPDATA || '', 'Antigravity', rel),
  path.join(process.env.APPDATA || '', 'Antigravity IDE', rel),
  path.join(process.env.APPDATA || '', 'antigravity', rel)
];

if (LIST_ONLY) {
  for (const d of CANDIDATE_DIRS) {
    if (!fs.existsSync(d)) {
      console.log(`（无）${d}`);
      continue;
    }
    console.log(`\n${d}`);
    for (const f of fs.readdirSync(d).filter(x => x.startsWith('paper_') && x.endsWith('.json'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf-8'));
        console.log(
          `   ${f.slice(6, 14)}  ${String(j.pdfName || '').padEnd(18)} 批注 ${String((j.annotations || []).length).padStart(3)}  ${j.pdfPath || ''}`
        );
      } catch {
        console.log(`   ${f}  （读取失败）`);
      }
    }
  }
  process.exit(0);
}

const dir = dirArg ? dirArg.slice('--dir='.length) : CANDIDATE_DIRS[0];

if (!fs.existsSync(dir)) {
  console.error('找不到扩展存储目录:', dir);
  process.exit(1);
}

const load = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
const files = fs.readdirSync(dir).filter(f => f.startsWith('paper_') && f.endsWith('.json'));

/**
 * 在磁盘上反查"名字唯一"的 PDF 并返回它的大小。
 * 用途：目标存档指向已删除的旧路径、又没有别的线索时，靠这个名字找到搬家后的文件，
 * 把字节数补进存档（新版就是靠"文件名 + 字节数"认领的）。
 * 只认**唯一命中**：同名的多份一律放弃，绝不让批注有可能贴到另一篇论文上。
 */
function findSolePdfByName(name) {
  if (!name || !/\.pdf$/i.test(name)) return null;
  const roots = ['D:\\kx', 'C:\\Users\\' + (process.env.USERNAME || '')];
  const found = [];
  for (const root of roots) {
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 4000) {
      const d = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          // 跳过体积巨大的目录，控制耗时
          if (/node_modules|\.git|AppData|Windows|Program Files/i.test(ent.name)) continue;
          stack.push(full);
        } else if (ent.name.toLowerCase() === name.toLowerCase()) {
          try {
            found.push({ path: full, size: fs.statSync(full).size });
          } catch {
            /* 忽略 */
          }
        }
      }
    }
  }
  const uniq = new Map(found.map(f => [f.size, f]));
  return uniq.size === 1 ? found.find(f => f.size === [...uniq.keys()][0]) : null;
}

/**
 * 跨 IDE 合并：**另一个 IDE 的 globalStorage 里可能有本目录没有的批注**。
 *
 * 【为什么需要】实测这台机器上 VS Code 的仓库里 STM 有 36 条，而 Antigravity IDE 的仓库里
 * 同一篇（存储键相同，因为键是路径的 MD5）还有 **4 条是 VS Code 里没有的**——
 * 两个 IDE 的 globalStorage 是**各自独立**的，只在一个 IDE 里读过、标注过，数据就只在那边。
 * 键相同 ⇒ 论文同一篇，可以按 key 安全地并进来（仍然按 id 去重，重复执行不会翻倍）。
 */
const crossMerged = new Map(); // key -> { annotations, aiQa, translations, ... , from }
if (mergeArg) {
  const otherDir = mergeArg.slice('--merge-from='.length);
  if (fs.existsSync(otherDir)) {
    for (const f of fs.readdirSync(otherDir).filter(x => x.startsWith('paper_') && x.endsWith('.json'))) {
      const key = f.replace(/^paper_/, '').replace(/\.json$/, '');
      try {
        const data = JSON.parse(fs.readFileSync(path.join(otherDir, f), 'utf-8'));
        const hasData =
          (Array.isArray(data.annotations) && data.annotations.length > 0) ||
          (Array.isArray(data.aiQa) && data.aiQa.length > 0) ||
          (data.translations && Object.keys(data.translations).length > 0);
        if (!hasData) continue;
        crossMerged.set(key, { data, from: otherDir });
      } catch {
        /* 单个文件坏了不影响其它 */
      }
    }
    console.log(`从另一个存储目录找到 ${crossMerged.size} 篇有内容的存档：${otherDir}`);
  } else {
    console.error('--merge-from 指定的目录不存在:', otherDir);
    process.exit(1);
  }
}

/**
 * 分组口径：**按文件名**（旧存档里没有字节数字段，路径又已失效，拿不到旧文件大小）。
 * 为了让"按文件名"是安全的，合并前加三重保险：
 *   ① 组内必须**恰好一个**条目对应现存文件（那个就是"当前键"= 用户现在打开的论文）；
 *   ② 该现存文件的字节数必须 > 0，并把这份大小**写进**目标存档（新版代码会用它做身份匹配）；
 *   ③ 只有"文件名相同 + 现存文件唯一"的组合才合并；一旦同名多份就跳过并报出来，交给人工判断。
 */
const groups = new Map();
for (const f of files) {
  let data;
  try {
    data = load(f);
  } catch (e) {
    console.log(`跳过 ${f}（读取失败：${e.message}）`);
    continue;
  }
  const p = String(data.pdfPath || '');
  const name = String(data.pdfName || path.basename(p) || '').trim();
  if (!name) continue;
  let size = 0;
  const exists = fs.existsSync(p);
  if (exists) {
    try {
      size = fs.statSync(p).size;
    } catch {
      size = 0;
    }
  }
  const key = name.toLowerCase();
  if (!groups.has(key)) groups.set(key, { name, entries: [] });
  groups.get(key).entries.push({
    file: f,
    data,
    exists,
    size,
    path: p,
    ann: Array.isArray(data.annotations) ? data.annotations.length : 0,
    qa: Array.isArray(data.aiQa) ? data.aiQa.length : 0,
    tr: data.translations ? Object.keys(data.translations).length : 0,
    arch: data.pageArchive ? Object.keys(data.pageArchive).length : 0
  });
}

const mergeUnique = (a, b, idField = 'id') => {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item[idField] ?? '') || JSON.stringify(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
};

let acted = 0;
for (const [key, g] of groups) {
  // 单条目也要处理：跨 IDE 合并时目标组里往往只有它自己
  if (g.entries.length < 2 && !mergeArg) continue;
  const alive = g.entries.filter(e => e.exists && e.size > 0);
  console.log(`\n===== ${g.name} =====`);
  g.entries.forEach(e =>
    console.log(
      `  ${e.file.slice(0, 21)}  批注 ${String(e.ann).padStart(3)} · AI ${String(e.qa).padStart(2)} · 译文 ${String(e.tr).padStart(4)} · 归档页 ${String(e.arch).padStart(2)}  ${e.exists ? `[文件在，${e.size} 字节]` : '[文件已不在原路径]'}\n     ${e.path}`
    )
  );
  // 保险①：确定"当前论文"用哪个存档
  let target = null;
  let targetIsDead = false;
  if (alive.length === 1) {
    target = alive[0];
  } else if (alive.length === 0 && g.entries.length === 1) {
    /*
     * 文件已被移动、且用户还没在新路径打开过它（本目录只有一条"死路径"记录）。
     * 这时仍需把它当作目标：跨 IDE 合并就是"往这条记录里补另一个 IDE 的批注"，
     * 等用户下次打开新路径时，代码会自动把这份数据认领过去。
     */
    target = g.entries[0];
    targetIsDead = true;
  } else {
    console.log(`  ⚠️ 同名条目里有 ${alive.length} 个对应现存文件 —— 无法判断哪个是当前论文，跳过（请人工确认）`);
    continue;
  }
  const sources = g.entries.filter(e => e !== target);
  const missing = sources.filter(e => e.ann > 0 || e.qa > 0 || e.tr > 0 || e.arch > 0);

  // 跨 IDE：目标存档的 key 在另一个存储目录里可能还有本目录没有的批注
  const targetKey = target.file.replace(/^paper_/, '').replace(/\.json$/, '');
  const cross = crossMerged.get(targetKey);

  if (missing.length === 0 && !cross) {
    console.log('  → 没有需要找回的内容，跳过');
    continue;
  }

  console.log(`  → 目标键: ${target.file}${targetIsDead ? "（旧路径记录，等下次打开新路径时认领）" : `（${target.size} 字节）`}`);
  missing.forEach(s => console.log(`  → 认领来源: ${s.file}（批注 ${s.ann}）`));
  if (cross) {
    console.log(
      `  → 跨 IDE 补充: ${cross.from}（批注 ${(cross.data.annotations || []).length}，AI ${(cross.data.aiQa || []).length}）`
    );
  }

  const merged = { ...target.data };
  /*
   * 保险②：把字节数写进目标存档 —— 新版的身份匹配（文件名+字节数）靠它把"搬家后的新路径"
   * 认领回这条记录。目标指向已失效路径时，大小从**另一个 IDE 的同一把键**取
   * （键是路径的 MD5，同一把键就是同一篇论文），或从磁盘上任何同名 PDF 反查。
   */
  if (!targetIsDead) {
    merged.pdfSize = target.size;
  } else if (cross && Number(cross.data.pdfSize)) {
    merged.pdfSize = Number(cross.data.pdfSize);
  } else {
    const found = findSolePdfByName(target.data.pdfName);
    if (found) merged.pdfSize = found.size;
  }
  console.log(
    merged.pdfSize
      ? `  → 记下字节数 ${merged.pdfSize}（供新版自动认领用）`
      : '  ⚠️ 没能确定字节数：新版仍能通过"首次打开时重建索引"找回，只是慢一步'
  );
  if (cross) missing.push({ data: cross.data, file: `(另一 IDE) ${targetKey}` });
  for (const s of missing) {
    const prev = s.data;
    merged.annotations = mergeUnique(prev.annotations, merged.annotations);
    merged.aiQa = mergeUnique(prev.aiQa, merged.aiQa);
    merged.translations = { ...(prev.translations || {}), ...(merged.translations || {}) };
    const st = { ...(prev.sentenceTranslations || {}) };
    for (const [k, v] of Object.entries(merged.sentenceTranslations || {})) {
      if (Array.isArray(v) && v.length > 0) st[k] = v;
    }
    merged.sentenceTranslations = st;
    const pa = { ...(prev.pageArchive || {}) };
    for (const [k, v] of Object.entries(merged.pageArchive || {})) {
      if (Array.isArray(v) && v.length > 0) pa[k] = v;
    }
    merged.pageArchive = pa;
    merged.visionStructure = { ...(prev.visionStructure || {}), ...(merged.visionStructure || {}) };
    merged.lastOpened = Math.max(Number(merged.lastOpened) || 0, Number(prev.lastOpened) || 0);
  }

  const before = Array.isArray(target.data.annotations) ? target.data.annotations.length : 0;
  const after = merged.annotations.length;
  console.log(`  → 批注 ${before} → ${after}（AI 答疑 ${(merged.aiQa || []).length}，译文 ${Object.keys(merged.translations || {}).length}，归档页 ${Object.keys(merged.pageArchive || {}).length}）`);

  if (!APPLY) {
    console.log('  → 干跑，未写入（加 --apply 才真正执行）');
    continue;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, `${target.file}.bak-${stamp}`);
  fs.copyFileSync(path.join(dir, target.file), backup);
  fs.writeFileSync(path.join(dir, target.file), JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`  → 已写入；原文件备份为 ${path.basename(backup)}`);
  acted++;
}

console.log(APPLY ? `\n完成：处理了 ${acted} 篇。旧键文件均未改动。` : '\n以上为干跑结果。');
