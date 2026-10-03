/**
 * 提交前密钥扫描：确保**即将提交/发布**的内容里没有 API Key / 令牌 / 个人数据。
 *
 * 用法：node scratch/scan_secrets.js
 *
 * 两个设计要点（都是被真实事故教出来的）：
 *  1. 只扫 `git ls-files` 列出的**已跟踪文件**——语义就是"我要提交的东西有没有密钥"。
 *     早先版本直接遍历工作区，会漏掉被 .gitignore 的路径、又会误报本机配置。
 *  2. 不要跳过"点目录"。早先版本看到以 . 开头的目录就 continue，
 *     结果整个 .vscode/ 被跳过，settings.json 里的真实 API Key 一路提交上去，
 *     最后被 GitHub 的推送保护拦下才发现。
 *
 * 限制说明：不能靠管道捕获 git 输出（受限沙箱禁止子进程使用命名管道），
 * 因此让 git 把文件清单写进 .git 下的临时文件再读取。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** 取已跟踪文件清单；不在 git 仓库里时退回遍历工作区 */
function listFiles() {
  const tmp = path.join(ROOT, '.git', 'dsh-ls-files.txt');
  try {
    const fd = fs.openSync(tmp, 'w');
    const r = spawnSync('git', ['ls-files'], { cwd: ROOT, stdio: ['ignore', fd, 'ignore'] });
    fs.closeSync(fd);
    if (r.status === 0 && fs.existsSync(tmp)) {
      const list = fs.readFileSync(tmp, 'utf8')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .map(f => path.join(ROOT, f))
        .filter(f => fs.existsSync(f) && fs.statSync(f).isFile());
      fs.rmSync(tmp, { force: true });
      if (list.length > 0) return { files: list, source: 'git ls-files（已跟踪文件）' };
    }
  } catch {
    /* 落到下面的遍历 */
  }

  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build']);
  const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.vsix', '.zip', '.pdf']);
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (!SKIP_EXT.has(path.extname(e.name).toLowerCase())) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  walk(ROOT);
  return { files, source: '工作区遍历（未检测到 git 仓库）' };
}

// 真实密钥形态（格式前缀如 'AQ.Ab8...' 只有后面跟着足够长的随机串时才算密钥）
const PATTERNS = [
  { name: 'DeepSeek/OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Google AIza 密钥', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'Google AQ. 新格式密钥', re: /\bAQ\.[A-Za-z0-9_-]{30,}\b/g },
  { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: '疑似访问令牌（52 位字母数字）', re: /\b[a-z0-9]{52}\b/gi }
];

/**
 * 剔除 npm 的哈希字段后再扫描。
 *
 * 为什么需要：package-lock.json 里每个依赖都带 `"integrity": "sha512-<base64>"`，
 * 其中的 base64 片段常有连续 52 位字母数字，会被上面的宽规则误报成访问令牌——
 * 实测一次锁文件更新就报了 3 处假阳性，直接把 CI 卡在"密钥泄露扫描"这一步。
 *
 * 注意只剔除 integrity 字段与 sha* 哈希本身：
 * `"resolved": "https://..."` 故意**不**剔除——真实令牌若藏在仓库地址里仍会被抓到。
 */
function stripPackageHashes(text) {
  return text
    .replace(/("integrity"\s*:\s*)"[^"]*"/g, '$1""')
    .replace(/\bsha(?:1|256|384|512)-[A-Za-z0-9+/=]+/g, 'sha-<hash>');
}

/** 允许的"假密钥"：占位符与测试用值 */
const ALLOW = [
  /sk-invalid-key-for-test/i,
  /sk-\.\.\./,
  /sk-x{3,}/i,
  /AQ\.Ab8\.\.\./,
  /AIzaSy\.\.\./,
  /AQ\.FAKE-GEMINI-KEY-FOR-TEST/i,
  /sk-\[A-Za-z0-9/
];

const { files, source } = listFiles();
let hits = 0;

for (const f of files) {
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text = stripPackageHashes(text);
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const v = m[0];
      if (ALLOW.some(a => a.test(v))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      console.log(`  ⚠️ ${f.replace(ROOT + path.sep, '')}:${line}  ${p.name}  ${v.slice(0, 8)}…${v.slice(-4)}（长度 ${v.length}）`);
      hits++;
    }
  }
}

console.log(`\n扫描范围：${source}，共 ${files.length} 个文件，命中 ${hits} 处。`);
if (hits === 0) console.log('✅ 未发现真实密钥，可以安全提交。');
else console.log('❌ 请先清理上述内容再提交。');
process.exit(hits > 0 ? 1 : 0);
