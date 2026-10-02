/**
 * 文案精简 第二轮：处理带变体选择符(U+FE0F)的 emoji。
 * 关键点：不用手打 emoji 字面量，改用码位构造，避免 U+FE0F 匹配失败。
 * ⚠️(U+26A0) 保留——它表示警告/错误，有语义价值。
 * 用法：node scratch/clean_labels2.js [--write]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WRITE = process.argv.includes('--write');

const EMOJI = '[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]';
const YELLOW = '\u{1F7E8}';
const GREEN = '\u{1F7E9}';
const BLUE = '\u{1F7E6}';
const RED = '\u{1F7E5}';
const PENCIL = '\u270D\uFE0F';
const PIN = '\u{1F4CC}';
const BULB = '\u{1F4A1}';
const CN_FLAG = '\u{1F1E8}\u{1F1F3}';
const ROBOT = '\u{1F916}';
const CHECK = '\u2705';

/** [文件, 搜索(字符串或正则), 替换, 说明] */
const STEPS = [
  // A. 段落类型徽标：剥掉标签开头紧跟的 emoji
  ['media/viewer.js', new RegExp(`(class="para-type-tag type-[a-z-]+">)${EMOJI}+\\s*`, 'gu'), '$1', '段落类型徽标 emoji'],

  // B. 提示消息：剥掉开头 emoji，但保留 ⚠️
  ['media/viewer.js', new RegExp(`(message:\\s*[\`'])${EMOJI}+\\s*`, 'gu'), '$1', '提示消息 emoji'],
  ['src/pdfEditorProvider.ts', new RegExp(`(showInformationMessage\\(\\s*\`)${EMOJI}+\\s*`, 'gu'), '$1', '通知 emoji'],

  // C. 高亮颜色名（保留颜色含义的文字，去掉色块方块）
  ['media/viewer.js', `${YELLOW} 核心要点`, '核心要点', '颜色名-黄'],
  ['media/viewer.js', `${GREEN} 论据数据`, '论据数据', '颜色名-绿'],
  ['media/viewer.js', `${BLUE} 公式方法`, '公式方法', '颜色名-蓝'],
  ['media/viewer.js', `${RED} 疑难待查`, '疑难待查', '颜色名-红'],
  ['media/viewer.js', `${PIN} 文献高亮`, '文献高亮', '悬停徽标兜底'],

  // D. 批注标题/文本前缀
  ['media/viewer.js', `'${PENCIL} 编辑文献批注'`, "'编辑文献批注'", '编辑批注标题'],
  ['media/viewer.js', `'${PENCIL} 记录本页研读心得'`, "'记录本页研读心得'", '本页心得标题'],
  ['media/viewer.js', `'${PENCIL} 文献研读批注'`, "'文献研读批注'", '批注弹窗标题'],
  ['media/viewer.js', `\`${PENCIL} 批注: `, '`批注: ', '高亮 title'],
  ['media/viewer.js', `>${PENCIL} `, '>', 'note-content 前缀'],
  ['media/viewer.js', `【${BULB} AI导师解答】`, '【AI导师解答】', '笔记-AI解答标题'],
  ['media/viewer.js', `【${BULB} AI导师答疑】`, '【AI导师答疑】', '笔记-AI答疑标题'],

  // E. 批注气泡里的 AI 状态提示
  ['media/viewer.js', `hintEl.textContent = '${ROBOT} 已发送，等待模型响应...'`, "hintEl.textContent = '已发送，等待模型响应...'", 'AI状态-已发送'],
  ['media/viewer.js', `hintEl.textContent = '${ROBOT} 模型正在生成...'`, "hintEl.textContent = '模型正在生成...'", 'AI状态-生成中'],
  ['media/viewer.js', `hintEl.textContent = '${ROBOT} 正在生成...'`, "hintEl.textContent = '正在生成...'", 'AI状态-生成中2'],

  // F. 笔记列表里的 AI 按钮与中文标记
  ['media/viewer.js', `${ROBOT} 问AI`, '问AI', '笔记列表-问AI'],
  ['media/viewer.js', `${CN_FLAG} 译文`, '译文', '旗帜-译文'],

  // G. 注释掉的 check 前缀（个别漏网）
  ['media/viewer.js', `${CHECK} 完成`, '完成', '完成提示'],

  // H. 第三轮：这些是 JS 动态写回的文案（第一轮改的是 HTML，会被覆盖）
  ['media/viewer.js', `'${PENCIL} 添加批注便签'`, "'添加批注便签'", '右键标签重置-批注'],
  ['media/viewer.js', `'${PENCIL} 为此句添加批注便签'`, "'为此句添加批注便签'", '右键标签重置-此句'],
  ['media/viewer.js', `'${PENCIL} 为此段添加批注便签'`, "'为此段添加批注便签'", '右键标签重置-此段'],
  ['media/viewer.js', `'${PENCIL} 对此句添加批注便签'`, "'对此句添加批注便签'", '右键标签重置-对此句'],
  ['media/viewer.js', `点击右上角 \u2699\uFE0F 翻译设置可切换`, '点击右上角的翻译设置可切换', 'AI模型标签提示'],
  ['src/pdfEditorProvider.ts', `点击右上角 \u{1F504} 重新翻译`, '点击右上角的重新翻译按钮', '切换模型提示'],
  // 聚焦工具条（多行 HTML，emoji 在标签内的下一行）
  ['src/pdfEditorProvider.ts', `${PENCIL} 高亮\n`, '高亮\n', '聚焦栏-高亮'],
  // 🖍️ 是 U+1F58D（蜡笔），与 ✍️(U+270D 写字手) 不是一个字符
  ['src/pdfEditorProvider.ts', `\u{1F58D}\uFE0F 高亮\n`, '高亮\n', '聚焦栏-高亮(蜡笔)'],
  ['src/pdfEditorProvider.ts', `${PENCIL} 批注\n`, '批注\n', '聚焦栏-批注'],
  ['src/pdfEditorProvider.ts', `\u{1F310} 翻译\n`, '翻译\n', '聚焦栏-翻译'],
  ['src/pdfEditorProvider.ts', `\u{1F4CB} 复制\n`, '复制\n', '聚焦栏-复制'],
  ['src/pdfEditorProvider.ts', `${ROBOT} 问AI\n`, '问AI\n', '聚焦栏-问AI'],
];

let changed = 0;
let missed = 0;
for (const [rel, from, to, label] of STEPS) {
  const file = path.join(ROOT, rel);
  let text = fs.readFileSync(file, 'utf8');

  if (from instanceof RegExp) {
    const re = new RegExp(from.source, from.flags.includes('g') ? from.flags : from.flags + 'g');
    const matches = text.match(re);
    const n = matches ? matches.length : 0;
    if (n === 0) {
      missed++;
      console.log(`  [未命中] ${label}`);
      continue;
    }
    if (WRITE) fs.writeFileSync(file, text.replace(re, to), 'utf8');
    changed += n;
    console.log(`  [${n} 处] ${rel} :: ${label}`);
  } else {
    const n = text.split(from).length - 1;
    if (n === 0) {
      missed++;
      console.log(`  [未命中] ${label}`);
      continue;
    }
    if (WRITE) fs.writeFileSync(file, text.split(from).join(to), 'utf8');
    changed += n;
    console.log(`  [${n} 处] ${rel} :: ${label}`);
  }
}

console.log('');
console.log(WRITE ? '=== 已写入 ===' : '=== 预演（加 --write 生效） ===');
console.log(`  合计 ${changed} 处；未命中 ${missed} 条`);
