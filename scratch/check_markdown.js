/**
 * 找出 README 里扩展市场渲染失败的粗体写法（CommonMark right-flanking 规则）。
 *
 * 实测结论：
 *   ✅ `**左栏**：`、`**Obsidian**、`、`**代码**`** 渲染正常
 *   ❌ `**…（或执行 `code`）**才生效` —— 闭合的 ** 前面是标点（「）」）、
 *      后面紧跟非标点字符（「才」）时，该分隔符不是右翼 → 粗体不闭合 → 星号原样显示。
 * 判定：闭合 ** 的 prev 是标点 且 next 不是空白/标点 → 失败。
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

const isPunct = ch => !!ch && /[!-/:-@\[-`{-~\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d\u2014\u2026]/.test(ch);
const isSpace = ch => !ch || /\s/.test(ch);

let hits = 0;
src.split('\n').forEach((line, i) => {
  const re = /\*\*([^*\n]+)\*\*/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const prev = line[start + m[0].length - 3]; // 闭合 ** 的前一个字符
    const next = line[end];
    if (isPunct(prev) && !isSpace(next) && !isPunct(next)) {
      hits++;
      console.log(`  ⚠️ 第 ${i + 1} 行：闭合 ** 前是标点「${prev}」、后是非标点「${next}」`);
      console.log(`       ${m[0].slice(0, 60)}${m[0].length > 60 ? '…' : ''}`);
    }
  }
});

console.log(hits === 0 ? '\n✅ 没有会在市场上渲染失败的粗体写法。' : `\n共 ${hits} 处需要调整。`);
process.exit(hits > 0 ? 1 : 0);
