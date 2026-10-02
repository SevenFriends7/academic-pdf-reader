/**
 * 把开发脚本里硬编码的个人路径改成环境变量 / 相对路径，便于公开仓库。
 *   PAPERS_DIR 环境变量指定论文 PDF 目录；未设置时用 <仓库>/test-papers
 * 用法：node scratch/sanitize_paths.js
 *
 * 实现说明：不去拼转义后的字面量（很容易数错反斜杠），而是用正则匹配
 * 「一个或多个反斜杠」，兼容单/双反斜杠两种写法。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR_RE = /'D:\\+kx\\+上海交大\\+梯度校正测验\\+梯度校正测验(\\+[^']*)?'/g;

const HEADER = "const PAPERS_DIR = process.env.PAPERS_DIR || path.join(__dirname, '..', 'test-papers');";

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && f !== 'sanitize_paths.js');
let changed = 0;

for (const f of files) {
  const full = path.join(__dirname, f);
  let s = fs.readFileSync(full, 'utf8');
  const before = s;

  s = s.replace(DIR_RE, (m, tail) => {
    const file = tail ? tail.replace(/\\+/g, '').trim() : '';
    return file ? `path.join(PAPERS_DIR, '${file}')` : 'PAPERS_DIR';
  });

  if (s !== before) {
    if (!/require\('path'\)/.test(s)) {
      s = s.replace(/^(const fs = require\('fs'\);)/m, "$1\nconst path = require('path');");
    }
    if (!/const PAPERS_DIR/.test(s)) {
      s = s.replace(/^(const .*require\(.*\);\n)/m, `$1${HEADER}\n`);
    }
    fs.writeFileSync(full, s, 'utf8');
    console.log(`  已处理 ${f}`);
    changed++;
  }
}

console.log(`\n共处理 ${changed} 个文件。论文 PDF 目录请用环境变量 PAPERS_DIR 指定，或放到 <仓库>/test-papers/。`);
