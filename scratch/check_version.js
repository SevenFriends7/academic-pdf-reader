/**
 * 发版前版本纪律校验。任何一条不过就退出码非 0（CI 会因此中止发布）。
 *
 * 用法：node scratch/check_version.js
 *
 * 检查：
 *   1. package.json 的 version 是合法 semver
 *   2. CHANGELOG.md 里有对应版本的章节（发布内容必须写清楚）
 *   3. 该版本还没有被打过 tag（防止重复发布同一个版本号——商店不允许复用版本号）
 *   4. 版本号比最后一个 tag 更高（防止手滑改小）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

const problems = [];
const notes = [];

// ---- 1. semver ----
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  problems.push(`package.json 的 version「${version}」不是合法 semver（形如 1.2.3 或 1.2.3-beta.1）`);
}

// ---- 2. CHANGELOG 必须有该版本章节 ----
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) {
  problems.push(`CHANGELOG.md 里没有「## [${version}]」章节——发布前必须写清这次改了什么`);
} else {
  notes.push(`CHANGELOG 已有 [${version}] 章节`);
}

// ---- 取已有 tag（写入文件再读，避免受限环境下的管道限制）----
const git = args => {
  const tmp = path.join(ROOT, '.git', 'dsh-git-out.txt');
  try {
    const fd = fs.openSync(tmp, 'w');
    const r = spawnSync('git', args, { cwd: ROOT, stdio: ['ignore', fd, 'ignore'] });
    fs.closeSync(fd);
    if (r.status !== 0) return null;
    const out = fs.readFileSync(tmp, 'utf8').trim();
    fs.rmSync(tmp, { force: true });
    return out;
  } catch {
    return null;
  }
};

const tags = (git(['tag', '--list', 'v*']) || '')
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean)
  .map(t => t.replace(/^v/, ''))
  .filter(v => /^\d+\.\d+\.\d+/.test(v));

/**
 * 当前构建是否就是 v<version> 这个 tag 的发布构建。
 *
 * 必须区分，否则是循环逻辑：发布工作流只在打 tag 时触发，
 * 而"版本不能已打过 tag"在 tag 构建里永远为真 → 发布必然失败。
 * 语义上：tag 构建时，v<version> 这个 tag 属于**本次发布**（匹配）；
 * 本地 / main 分支构建时出现同名 tag 才是"已发布过、必须递增"。
 */
const tagName = `v${version}`;
const isTagBuild = process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME === tagName;

// ---- 3. 不能重复已发布的版本号（tag 构建自身除外）----
if (tags.includes(version) && !isTagBuild) {
  problems.push(`版本 ${version} 已经打过 tag（${tagName}）——商店不允许复用版本号，请先 npm version patch/minor/major`);
} else if (isTagBuild) {
  notes.push(`本次就是 ${tagName} 的 tag 发布构建`);
} else {
  notes.push(`版本 ${version} 尚未打过 tag`);
}

// ---- 4. 必须比其它 tag 更大（排除本次发布自身的 tag）----
const others = tags.filter(t => t !== version);
if (others.length > 0) {
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  };
  const maxTag = others.reduce((m, t) => (cmp(t, m) > 0 ? t : m), others[0]);
  if (cmp(version, maxTag) <= 0) {
    problems.push(`版本 ${version} 不大于已有 tag v${maxTag}——版本号必须递增`);
  } else {
    notes.push(`版本递增正常（上一个 tag：v${maxTag}）`);
  }
} else {
  notes.push('没有更早的版本 tag');
}

// ---- 输出 ----
console.log(`当前版本：${version}`);
notes.forEach(n => console.log(`  · ${n}`));
if (problems.length === 0) {
  console.log('\n✅ 版本纪律校验通过。');
  process.exit(0);
}
console.log('');
problems.forEach(p => console.log(`  ❌ ${p}`));
console.log('\n❌ 版本校验未通过，已阻止发布。');
process.exit(1);
