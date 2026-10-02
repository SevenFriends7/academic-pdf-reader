/**
 * 把 README 里"给开发者/维护者看"的大段内容拆到独立文件，让 README 只留用户需要的东西。
 * 用法：node scratch/split_readme.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readmePath = path.join(ROOT, 'README.md');
const md = fs.readFileSync(readmePath, 'utf8');
const lines = md.split('\n');

/** 找到某个二级标题的起始行号（1 基） */
const findHeading = title => {
  const i = lines.findIndex(l => l.startsWith('## ') && l.includes(title));
  return i < 0 ? -1 : i;
};

const iDev = findHeading('开发者本地构建');
const iMaintainer = findHeading('维护者');
const iFix = findHeading('v0.2.8');
if (iDev < 0 || iMaintainer < 0 || iFix < 0) {
  console.error('未找到预期章节，中止');
  process.exit(1);
}

const before = lines.slice(0, iDev); // 用户内容
const devSection = lines.slice(iDev, iMaintainer);
const maintainerSection = lines.slice(iMaintainer, iFix);
const fixSections = lines.slice(iFix);

const strip = s => s.join('\n').replace(/\n{3,}/g, '\n\n').trim();

// ---- 1) CONTRIBUTING.md：开发构建 + 测试 + 发布流程 ----
const contributing = `# 贡献与发布指南

面向参与开发或维护本扩展的人。使用说明请看 [README](README.md)。

---

${strip(devSection)}

---

${strip(maintainerSection)
  // 去掉发布章节里对自身位置的引用措辞
  .replace(/^## .*$/m, '## 发布新版本')}
`;

// ---- 2) docs/design-notes.md：历次问题的根因与修法 ----
const designNotes = `# 设计说明与历次问题复盘

这里记录各版本修复过的具体问题、根因与改法。用户向的更新摘要见 [CHANGELOG](../CHANGELOG.md)。

---

${strip(fixSections)}
`;

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'CONTRIBUTING.md'), contributing, 'utf8');
fs.writeFileSync(path.join(ROOT, 'docs', 'design-notes.md'), designNotes, 'utf8');

// ---- 3) 写回精简后的 README（用户内容 + 截图 + 许可证） ----
const screenshotSection = `## 🖼️ 界面预览

| 阅读与高亮 | 批注库 | AI 问答 |
| --- | --- | --- |
| ![带高亮的双栏阅读](media/screenshots/01-reading-highlights.jpg) | ![批注库](media/screenshots/02-annotations.jpg) | ![AI 问答](media/screenshots/03-ai-qa.jpg) |

> 截图取自 VS Code 内的实际界面。更多截图欢迎通过 [Issues](https://github.com/SevenFriends7/academic-pdf-reader/issues) 提供。

---

`;

const tail = `## 📄 许可证

[MIT](LICENSE) © academic-pdf-reader contributors

本扩展内嵌 [pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0），第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## 🔗 相关链接

- [更新日志](CHANGELOG.md) — 各版本改了什么
- [设计说明与问题复盘](docs/design-notes.md) — 历次问题的根因与修法
- [贡献与发布指南](CONTRIBUTING.md) — 本地构建、测试、发布流程
- [提交问题](https://github.com/SevenFriends7/academic-pdf-reader/issues)
`;

let userPart = strip(before);
// 把截图章节插在"核心特性"之前
userPart = userPart.replace(/^(---\n\n## ✨ 核心特性)/m, `---\n\n${screenshotSection}$1`);
if (!/界面预览/.test(userPart)) {
  userPart = `${userPart}\n\n---\n\n${screenshotSection}`;
}
fs.writeFileSync(readmePath, `${userPart}\n\n---\n\n${tail}`, 'utf8');

console.log('已生成：');
console.log(`  README.md             ${fs.readFileSync(readmePath, 'utf8').split('\n').length} 行（原 ${lines.length} 行）`);
console.log(`  CONTRIBUTING.md       ${contributing.split('\n').length} 行`);
console.log(`  docs/design-notes.md  ${designNotes.split('\n').length} 行`);
