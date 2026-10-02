/**
 * 文案精简脚本：去掉不必要的 emoji 与"高大上"措辞。
 * 用「精确一对一替换 + 命中次数统计」而不是全局正则，避免误伤。
 * 用法：node scratch/clean_labels.js          （预演，只报告不改）
 *       node scratch/clean_labels.js --write  （实际写入）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WRITE = process.argv.includes('--write');

/** [文件, 旧文本, 新文本, 说明] */
const EDITS = [
  // ---------- src/pdfEditorProvider.ts ----------
  ['src/pdfEditorProvider.ts', '<span class="badge badge-gemini">双栏学术对照</span>', '<span class="badge badge-gemini">对照翻译</span>', '徽标文案'],
  ['src/pdfEditorProvider.ts', '<span class="subtitle">支持划选即译与沉浸阅读</span>', '<span class="subtitle">划选即译</span>', '副标题'],
  ['src/pdfEditorProvider.ts', 'title="学术原卷 (默认白纸)">☀️ 白纸', 'title="默认白纸">白纸', '主题胶囊1'],
  ['src/pdfEditorProvider.ts', 'title="羊皮暖阳 (经典护眼暖色)">📜 羊皮', 'title="护眼暖色">羊皮', '主题胶囊2'],
  ['src/pdfEditorProvider.ts', 'title="若竹绿意 (冷色防眩光)">🌿 竹青', 'title="冷色防眩光">竹青', '主题胶囊3'],
  ['src/pdfEditorProvider.ts', 'title="深邃暗夜 (夜读黑底模式)">🌙 暗夜', 'title="夜读黑底">暗夜', '主题胶囊4'],
  ['src/pdfEditorProvider.ts', '⚙️ 翻译设置', '翻译设置', '设置按钮'],
  ['src/pdfEditorProvider.ts', 'data-color="yellow">🟨 要点', 'data-color="yellow">要点', '筛选1'],
  ['src/pdfEditorProvider.ts', 'data-color="green">🟩 数据', 'data-color="green">数据', '筛选2'],
  ['src/pdfEditorProvider.ts', 'data-color="blue">🟦 方法', 'data-color="blue">方法', '筛选3'],
  ['src/pdfEditorProvider.ts', 'data-color="pink">🟥 疑难', 'data-color="pink">疑难', '筛选4'],
  ['src/pdfEditorProvider.ts', '>✍️ 记本页心得<', '>记本页心得<', '记心得按钮'],
  ['src/pdfEditorProvider.ts', '>🖍️ 高亮\n', '>高亮\n', '聚焦栏-高亮'],
  ['src/pdfEditorProvider.ts', '>✍️ 批注\n', '>批注\n', '聚焦栏-批注'],
  ['src/pdfEditorProvider.ts', '>🌐 翻译\n', '>翻译\n', '聚焦栏-翻译'],
  ['src/pdfEditorProvider.ts', '>📋 复制\n', '>复制\n', '聚焦栏-复制'],
  ['src/pdfEditorProvider.ts', '>🤖 问AI\n', '>问AI\n', '聚焦栏-问AI'],
  ['src/pdfEditorProvider.ts', '<span class="annot-title-icon">✍️</span>\n        ', '', '批注标题图标'],
  ['src/pdfEditorProvider.ts', 'title="一键将 AI 解答追加进批注输入框中">📥 采纳进批注', 'title="将 AI 解答追加进批注输入框">采纳进批注', '采纳按钮'],
  ['src/pdfEditorProvider.ts', 'title="删除这条批注">🗑️ 删除', 'title="删除这条批注">删除', '删除按钮'],
  ['src/pdfEditorProvider.ts', '>💾 保存批注<', '>保存批注<', '保存按钮'],
  ['src/pdfEditorProvider.ts', '<span class="tooltip-badge" id="tooltipBadge">🟨 核心要点</span>', '<span class="tooltip-badge" id="tooltipBadge">核心要点</span>', '悬停卡徽标'],
  ['src/pdfEditorProvider.ts', '>✏️ 编辑批注<', '>编辑批注<', '悬停卡-编辑'],
  ['src/pdfEditorProvider.ts', '>🔍 笔记库<', '>笔记库<', '悬停卡-笔记库'],
  ['src/pdfEditorProvider.ts', 'text-danger">🗑️ 删除<', 'text-danger">删除<', '悬停卡-删除'],
  ['src/pdfEditorProvider.ts', '<span>✍️ 编辑此条批注</span>', '<span>编辑此条批注</span>', '右键-编辑'],
  ['src/pdfEditorProvider.ts', '<span>📋 复制批注与引文</span>', '<span>复制批注与引文</span>', '右键-复制'],
  ['src/pdfEditorProvider.ts', '<span>🔍 在右侧笔记列表中定位</span>', '<span>在右侧笔记列表中定位</span>', '右键-定位'],
  ['src/pdfEditorProvider.ts', '<span style="color: #ff6b6b;">🗑️ 删除此条批注/高亮</span>', '<span style="color: #ff6b6b;">删除此条批注/高亮</span>', '右键-删除'],
  ['src/pdfEditorProvider.ts', '<span>🖍️ 荧光笔高亮</span>', '<span>荧光笔高亮</span>', '右键-高亮'],
  ['src/pdfEditorProvider.ts', '<span id="ctxBtnAddNoteLabel">✍️ 添加批注便签</span>', '<span id="ctxBtnAddNoteLabel">添加批注便签</span>', '右键-批注'],
  ['src/pdfEditorProvider.ts', '<span style="color: #6366f1; font-weight: 500;">🤖 呼叫AI学术导师答疑</span>', '<span style="color: #6366f1; font-weight: 500;">AI 答疑</span>', '右键-AI'],
  ['src/pdfEditorProvider.ts', '<span>⚡ 即时学术精译</span>', '<span>即时翻译</span>', '右键-翻译'],
  ['src/pdfEditorProvider.ts', '<span>📋 复制英文原文</span>', '<span>复制英文原文</span>', '右键-复制原文'],
  ['src/pdfEditorProvider.ts', '<span>🎯 定位对应翻译卡片</span>', '<span>定位翻译卡片</span>', '右键-定位卡片'],
  ['src/pdfEditorProvider.ts', '<span>✍️ 记录本页研读心得</span>', '<span>记录本页心得</span>', '右键-本页心得'],
  ['src/pdfEditorProvider.ts', '<span>⚡ 整页大模型精译</span>', '<span>整页翻译</span>', '右键-整页翻译'],
  ['src/pdfEditorProvider.ts', '<span>🔍 适合页面宽度</span>', '<span>适合页面宽度</span>', '右键-适合宽度'],
  ['src/pdfEditorProvider.ts', '<span>📄 上一页</span>', '<span>上一页</span>', '右键-上一页'],
  ['src/pdfEditorProvider.ts', '<span>📄 下一页</span>', '<span>下一页</span>', '右键-下一页'],
  ['src/pdfEditorProvider.ts', '<span>📝 导出文献研读笔记</span>', '<span>导出笔记</span>', '右键-导出'],
  ['src/pdfEditorProvider.ts', '<h3>✍️ 添加文献研读批注</h3>', '<h3>添加批注</h3>', '弹窗标题'],
  ['src/pdfEditorProvider.ts', '<span class="quote-label">原文摘录:</span>', '<span class="quote-label">原文摘录：</span>', '引文标签'],

  // ---------- media/viewer.js ----------
  ['media/viewer.js', 'title="学术原卷 (默认白纸)">☀️ 白纸', 'title="默认白纸">白纸', '主题胶囊1'],
  ['media/viewer.js', 'title="羊皮暖阳 (经典护眼暖色)">📜 羊皮', 'title="护眼暖色">羊皮', '主题胶囊2'],
  ['media/viewer.js', 'title="若竹绿意 (冷色防眩光)">🌿 竹青', 'title="冷色防眩光">竹青', '主题胶囊3'],
  ['media/viewer.js', 'title="深邃暗夜 (夜读黑底模式)">🌙 暗夜', 'title="夜读黑底">暗夜', '主题胶囊4'],
  ['media/viewer.js', 'title="为此段落/句子添加高亮 (快捷键: H)">🖍️ 高亮', 'title="为此段落/句子添加高亮 (快捷键: H)">高亮', '聚焦栏-高亮'],
  ['media/viewer.js', 'title="为此段落添加批注心得 (快捷键: N)">✍️ 批注', 'title="为此段落添加批注心得 (快捷键: N)">批注', '聚焦栏-批注'],
  ['media/viewer.js', 'title="查看对应中文译文 (快捷键: T)">🌐 翻译', 'title="查看对应中文译文 (快捷键: T)">翻译', '聚焦栏-翻译'],
  ['media/viewer.js', 'title="复制当前段落文本 (快捷键: C)">📋 复制', 'title="复制当前段落文本 (快捷键: C)">复制', '聚焦栏-复制'],
  ['media/viewer.js', 'title="就当前段落向AI导师提问 (快捷键: Q)">🤖 问AI', 'title="就当前段落向AI导师提问 (快捷键: Q)">问AI', '聚焦栏-问AI'],
  ['media/viewer.js', '<span class="annot-title-icon">✍️</span>\n        ', '', '批注标题图标'],
  ['media/viewer.js', 'title="带着当前选中句子和段落上下文，向AI学术助手提问">🤖 呼叫AI解答疑点', 'title="结合选句与段落上下文向 AI 提问">AI 提问', 'AI按钮'],
  ['media/viewer.js', '<span class="annot-ai-answer-title">💡 AI导师解析</span>', '<span class="annot-ai-answer-title">AI 解答</span>', 'AI解答标题'],
  ['media/viewer.js', 'title="将AI解答内容追加到下方批注框">📥 采纳进批注', 'title="将 AI 解答追加到下方批注框">采纳进批注', '采纳按钮'],
  ['media/viewer.js', 'title="删除这条批注">🗑️ 删除', 'title="删除这条批注">删除', '删除按钮'],
  ['media/viewer.js', '>💾 保存批注<', '>保存批注<', '保存按钮'],

  // 段落类型标签
  ['media/viewer.js', "'👑 论文大标题'", "'论文标题'", '类型-标题'],
  ['media/viewer.js', "'📄 论文摘要'", "'摘要'", '类型-摘要'],
  ['media/viewer.js', "'🏷️ 关键词'", "'关键词'", '类型-关键词'],
  ['media/viewer.js', "'💡 研究意义'", "'研究意义'", '类型-意义'],
  ['media/viewer.js', "'📌 核心章节'", "'章节'", '类型-章节'],
  ['media/viewer.js', "'🖼️ 图表说明'", "'图表说明'", '类型-图表说明'],
  ['media/viewer.js', "'📊 图形标签'", "'图形标签'", '类型-图形标签'],
  ['media/viewer.js', "'🔖 页面脚注'", "'脚注'", '类型-脚注'],
  ['media/viewer.js', "'👥 学术元信息'", "'元信息'", '类型-元信息'],
  ['media/viewer.js', "'📝 正文'", "'正文'", '类型-正文'],
  ['media/viewer.js', "'📄 论文摘要'", "'摘要'", '类型-摘要2'],
  ['media/viewer.js', "'🏷️ 核心关键词'", "'关键词'", '类型-关键词2'],
  ['media/viewer.js', "'💡 重要意义'", "'研究意义'", '类型-意义2'],
  ['media/viewer.js', "'👥 作者与学术元信息'", "'元信息'", '类型-元信息2'],

  // 逐句行按钮与卡片按钮
  ['media/viewer.js', '>🤖 问AI</button>', '>问AI</button>', '逐句/卡片-问AI'],
  ['media/viewer.js', '>✍️ 笔记</button>', '>笔记</button>', '逐句/卡片-笔记'],
  ['media/viewer.js', '>🎯 定位</button>', '>定位</button>', '卡片-定位'],
  ['media/viewer.js', '>📋 译文</button>', '>译文</button>', '卡片-译文'],
  ['media/viewer.js', '>📋 原文</button>', '>原文</button>', '卡片-原文'],
  ['media/viewer.js', '<span class="retrans-icon">🔄</span> 重译', '<span class="retrans-icon">↻</span> 重译', '重译图标'],
  ['media/viewer.js', 'title="居中定位">🎯</div>', 'title="居中定位">定位</div>', '逐句-定位'],
  ['media/viewer.js', '>📋 复制</button>', '>复制</button>', '卡片-复制'],
  ['media/viewer.js', '>🎯 定位</button>', '>定位</button>', '卡片-定位2'],

  // 未对齐提示与重试按钮
  ['media/viewer.js', '<div class="trans-unaligned-head">📄 整段译文（逐句对齐未成功，已停止猜测式拆分）</div>', '<div class="trans-unaligned-head">整段译文（逐句对齐未成功，已停止猜测式拆分）</div>', '未对齐标题'],
  ['media/viewer.js', '>🔄 重新尝试逐句对齐</button>', '>重新尝试逐句对齐</button>', '重试-对齐'],
  ['media/viewer.js', '>🔄 点击重试</button>', '>点击重试</button>', '重试-通用'],
  ['media/viewer.js', '<span class="mini-spinner spinning"></span> 正在请求智能学术精译...', '<span class="mini-spinner spinning"></span> 正在翻译...', '骨架屏文案1'],
  ['media/viewer.js', '<span class="mini-spinner spinning"></span> 正在请求智能学术翻译...', '<span class="mini-spinner spinning"></span> 正在翻译...', '骨架屏文案2'],
];

function apply() {
  let changed = 0;
  let missed = 0;
  const byFile = new Map();

  for (const [rel, from, to, label] of EDITS) {
    const file = path.join(ROOT, rel);
    let text = fs.readFileSync(file, 'utf8');
    const count = text.split(from).length - 1;
    if (count === 0) {
      missed++;
      console.log(`  [未命中] ${rel} :: ${label} :: ${JSON.stringify(from.slice(0, 50))}`);
      continue;
    }
    if (WRITE) {
      text = text.split(from).join(to);
      fs.writeFileSync(file, text, 'utf8');
    }
    changed += count;
    byFile.set(rel, (byFile.get(rel) || 0) + count);
    console.log(`  [${count} 处] ${rel} :: ${label}`);
  }

  console.log('');
  console.log(WRITE ? '=== 已写入 ===' : '=== 预演（未写入，加 --write 生效） ===');
  byFile.forEach((n, f) => console.log(`  ${f}: ${n} 处替换`));
  console.log(`  合计 ${changed} 处；未命中 ${missed} 条`);
}

apply();
