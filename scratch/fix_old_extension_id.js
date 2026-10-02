/**
 * 更换 publisher（扩展 ID 变化）后清理旧 ID 的残留：
 *   1. 从 extensions.json 移除旧 ID 条目（否则 IDE 里会出现两个同名扩展）
 *   2. 删除旧 ID 的扩展目录
 * 旧 ID 的 globalStorage（笔记/翻译缓存）**保留**作为备份，不删。
 *
 * 用法：node scratch/fix_old_extension_id.js <extensions 目录> [...更多目录]
 *   node scratch/fix_old_extension_id.js "%USERPROFILE%\.antigravity-ide\extensions"
 *
 * 注意：**必须在对应 IDE 关闭时运行**，否则 IDE 退出时会用内存中的状态覆盖注册表。
 */
const fs = require('fs');
const path = require('path');

const OLD_ID = 'academic-tools.academic-pdf-reader';
const NEW_ID = 'paper-reader.academic-pdf-reader';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('请传入至少一个 extensions 目录（例如 %USERPROFILE%\\.vscode\\extensions）');
  process.exit(2);
}

let changed = 0;
for (const root of roots) {
  console.log(`\n=== ${root} ===`);
  if (!fs.existsSync(root)) {
    console.log('  （目录不存在，跳过）');
    continue;
  }

  // 1) 清理注册表
  const regPath = path.join(root, 'extensions.json');
  if (fs.existsSync(regPath)) {
    let list;
    try {
      list = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    } catch (e) {
      console.log(`  ❌ extensions.json 解析失败：${e.message}`);
      continue;
    }
    if (!Array.isArray(list)) {
      console.log('  ❌ extensions.json 不是数组，未做修改');
      continue;
    }
    const before = list.length;
    const removed = list.filter(it => it && it.identifier && it.identifier.id === OLD_ID);
    const kept = list.filter(it => !(it && it.identifier && it.identifier.id === OLD_ID));
    if (removed.length === 0) {
      console.log('  ✅ 注册表无旧 ID 条目');
    } else {
      fs.writeFileSync(regPath, JSON.stringify(kept), 'utf8');
      console.log(`  ✅ 从注册表移除 ${removed.length} 条旧 ID 条目（${before} → ${kept.length}）`);
      changed++;
    }
    const hasNew = kept.some(it => it && it.identifier && it.identifier.id === NEW_ID);
    console.log(`  ${hasNew ? '✅' : '⚠️'} 新 ID 条目${hasNew ? '已存在' : '不存在（请重新安装一次 vsix）'}`);
  } else {
    console.log('  （无 extensions.json）');
  }

  // 2) 删除旧 ID 的扩展目录
  const dirs = fs.readdirSync(root).filter(n => n.startsWith(`${OLD_ID}-`));
  if (dirs.length === 0) {
    console.log('  ✅ 无旧 ID 扩展目录');
  } else {
    for (const d of dirs) {
      const full = path.join(root, d);
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`  ✅ 已删除旧目录 ${d}`);
      changed++;
    }
  }
}

console.log(`\n${changed > 0 ? '完成' : '无需修改'}。旧 ID 的 globalStorage（笔记/缓存）已保留作为备份。`);
