const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const p = fs.readFileSync(path.join(ROOT, 'src/pdfEditorProvider.ts'), 'utf8');
const v = fs.readFileSync(path.join(ROOT, 'media/viewer.js'), 'utf8');

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

const checks = [
  ['徽标改为「对照翻译」', p.includes('badge-gemini">对照翻译</span>')],
  ['副标题简化为「划选即译」', p.includes('<span class="subtitle">划选即译</span>')],
  ['主题胶囊去掉 emoji', p.includes('title="默认白纸">白纸')],
  ['去掉「双栏学术对照」旧文案', !p.includes('双栏学术对照')],
  ['去掉「支持划选即译与沉浸阅读」旧文案', !p.includes('支持划选即译与沉浸阅读')],
  ['卡片按钮：定位', v.includes('>定位</button>')],
  ['卡片按钮：问AI', v.includes('>问AI</button>')],
  ['卡片按钮：笔记', v.includes('>笔记</button>')],
  ['卡片按钮：译文 / 原文', v.includes('>译文</button>') && v.includes('>原文</button>')],
  ['类型标签：图表说明', v.includes('图表说明</span>')],
  ['类型标签：正文', v.includes('>正文</span>')],
  ['聚焦工具条无 emoji', !/focus-action-btn[^>]*>[\s\S]{0,40}?[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}]/u.test(p)],
];

let pass = 0;
let fail = 0;
checks.forEach(([name, ok]) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  ok ? pass++ : fail++;
});

// 统计剩余 emoji（应只剩 ⚠️ / ✅ / 批注钉这类有语义的）
function remaining(label, text) {
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((l, i) => {
    if (EMOJI.test(l)) hits.push(`    ${i + 1}: ${l.trim().slice(0, 90)}`);
  });
  console.log(`\n--- ${label} 剩余 ${hits.length} 行 ---`);
  console.log(hits.join('\n'));
}
remaining('src/pdfEditorProvider.ts', p);
remaining('media/viewer.js', v);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
