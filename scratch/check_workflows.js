/**
 * 校验 GitHub Actions 工作流 YAML 能否被正确解析，并做基本结构检查。
 * 用法：npx --yes --package yaml -- node scratch/check_workflows.js
 */
const fs = require('fs');
const path = require('path');

let YAML;
try {
  YAML = require('yaml');
} catch {
  console.error('未找到 yaml 模块，请用：npx --yes --package yaml -- node scratch/check_workflows.js');
  process.exit(2);
}

const dir = path.join(__dirname, '..', '.github', 'workflows');
const files = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f));
let bad = 0;

for (const f of files) {
  const full = path.join(dir, f);
  const text = fs.readFileSync(full, 'utf8');
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    console.log(`  ❌ ${f} 解析失败：${e.message}`);
    bad++;
    continue;
  }
  const problems = [];
  if (!doc || typeof doc !== 'object') problems.push('顶层不是对象');
  // on 在 YAML 1.1 里会被解析成布尔 true，这里两种都接受
  const on = doc.on !== undefined ? doc.on : doc[true];
  if (!on) problems.push('缺少 on 触发条件');
  if (!doc.jobs || typeof doc.jobs !== 'object') problems.push('缺少 jobs');
  else {
    for (const [name, job] of Object.entries(doc.jobs)) {
      if (!job['runs-on']) problems.push(`job ${name} 缺少 runs-on`);
      if (!Array.isArray(job.steps) || job.steps.length === 0) problems.push(`job ${name} 缺少 steps`);
      else
        job.steps.forEach((s, i) => {
          if (!s.name && !s.uses && !s.run) problems.push(`job ${name} 第 ${i + 1} 步既无 name/uses 也无 run`);
          if (s.run !== undefined && typeof s.run !== 'string') problems.push(`job ${name} 第 ${i + 1} 步 run 不是字符串`);
        });
    }
  }
  if (/\t/.test(text)) problems.push('含 Tab 字符（YAML 不允许）');

  const jobNames = doc.jobs ? Object.keys(doc.jobs).join(',') : '-';
  if (problems.length === 0) {
    console.log(`  ✅ ${f}  解析正常，jobs: ${jobNames}`);
  } else {
    console.log(`  ❌ ${f}`);
    problems.forEach(p => console.log(`       - ${p}`));
    bad++;
  }
}

console.log(`\n共 ${files.length} 个工作流，${bad} 个有问题。`);
process.exit(bad > 0 ? 1 : 0);
