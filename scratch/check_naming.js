/** 汇总插件在各处使用的名字，检查是否一致 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const readmeFirst = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('\n')[0];

console.log('=== 各处使用的名字 ===');
console.log(`  扩展 ID (name)        : ${pkg.name}          ← 商店唯一标识，上架后不可改`);
console.log(`  商店显示名 (displayName): ${pkg.displayName}`);
console.log(`  发布者 ID (publisher)  : ${pkg.publisher}`);
console.log(`  简介 (description)     : ${pkg.description}`);
console.log(`  仓库名                 : ${path.basename(ROOT)}`);
console.log(`  README 大标题          : ${readmeFirst.replace(/^#\s*/, '')}`);
console.log(`  GitHub 仓库描述        : ${pkg.description}`);

console.log('\n=== 一致性检查 ===');
const readmeTitle = readmeFirst.replace(/^#\s*/, '').trim();
const checks = [
  ['README 大标题与 displayName 一致', readmeTitle.startsWith(pkg.displayName) || readmeTitle.includes(pkg.displayName)],
  ['displayName 不含括号英文别名', !/\(|（/.test(pkg.displayName)],
  ['仓库名与扩展 ID 一致', path.basename(ROOT) === pkg.name],
];
let bad = 0;
checks.forEach(([n, ok]) => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✅' : '⚠️ '} ${n}`);
});
if (bad) {
  console.log('\n  说明：README 大标题是给商店页/仓库首页看的，displayName 是扩展面板里显示的，');
  console.log('        两者不一致会让读者以为装错了插件。');
}
