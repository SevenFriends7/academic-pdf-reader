/**
 * 宿主 HTML 冒烟测试：把 **src/pdfEditorProvider.ts 里真实的 webview HTML 模板**
 * 抽出来，在 jsdom 里加载，再执行 media/viewer.js，然后断言用户的真实界面。
 *
 * 为什么必须有它（血的教训）：
 *   scratch/smoke_init.js 用的是**手写的简化 HTML**，并且刻意让
 *   `annotationPopover` / `aiAssistantModal` **保持缺失**，好让 viewer.js 的
 *   "取不到就创建"分支跑起来。于是它测出来的是"viewer.js 自己造弹窗"这条路。
 *
 *   而真实环境里，这两个容器**早就写在宿主 HTML（pdfEditorProvider.ts）里了**：
 *   viewer.js 的 `if (!document.getElementById('aiAssistantModal'))` 判定为假 →
 *   整段（含 `#aiModalStyleSlot`、`#aiModalVersion`、`开始分析` 按钮）被跳过 →
 *   `bindAiAssistantModalEvents()` 里 `document.getElementById('aiModalStyleSlot')`
 *   取到 null → 回答风格控件**永远不出现**。
 *
 *   0.5.6 / 0.5.7 / 0.5.8 / 0.5.10 四个版本都在改"弹窗里的回答风格控件"，
 *   而代码走的分支从未在真实 HTML 上执行过 —— 所以用户每次都说"没添加成功"。
 *   这个测试就是为了让"改了没生效"再也不可能悄悄通过。
 *
 * 用法：node scratch/host_html_smoke.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROVIDER = process.env.PROVIDER_PATH || path.join(ROOT, 'src', 'pdfEditorProvider.ts');
const VIEWER = process.env.VIEWER_PATH || path.join(ROOT, 'media', 'viewer.js');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  const candidates = [
    path.join(process.env.TEMP || '', 'jsdomtest', 'node_modules', 'jsdom'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'jsdom')
  ];
  for (const c of candidates) {
    try {
      ({ JSDOM } = require(c));
      break;
    } catch {
      /* 继续找下一个 */
    }
  }
  if (!JSDOM) {
    console.error('需要 jsdom：npm install --prefix "%TEMP%\\jsdomtest" --no-save jsdom');
    process.exit(2);
  }
}

/** 从宿主文件里抽出 webview HTML 模板，并把 ${...} 全部替换成假值
 *
 *  两种输入都要支持：
 *   · src/pdfEditorProvider.ts —— 源码（模板前有 `return /* html *​/ \`` 标记）
 *   · dist/extension.js        —— 打包产物（esbuild 会把那个注释删掉，只剩裸模板字符串）
 *  用安装到本机的 dist/extension.js 跑一遍，才能证明"真正装上去的那份"是对的。
 */
function extractHostHtml() {
  const src = fs.readFileSync(PROVIDER, 'utf8');
  const marker = src.indexOf('return /* html */ `');
  let html;
  if (marker >= 0) {
    const end = src.indexOf('`;', marker);
    if (end < 0) throw new Error('webview HTML 模板没有正常结束');
    html = src.slice(marker + 'return /* html */ `'.length, end);
  } else {
    // 打包产物：从 <!DOCTYPE html> 往两边找最近的反引号
    const doctype = src.indexOf('<!DOCTYPE html>');
    if (doctype < 0) throw new Error(`找不到 webview HTML（既没有 TS 源码标记，也没有 <!DOCTYPE html>）：${PROVIDER}`);
    const start = src.lastIndexOf('`', doctype);
    const end = src.indexOf('`', doctype);
    if (start < 0 || end < 0) throw new Error('打包产物里的 HTML 模板反引号没找到');
    html = src.slice(start + 1, end);
  }

  // 占位符在源码里是 ${extVersion}，在打包产物里可能变成 ${extVersion || '?'}、${JSON.stringify(extVersion)}，
  // 所以按"表达式里出现什么关键字"来给值，而不是死抠字面量。
  html = html.replace(/\$\{([^}]*)\}/g, (m, expr) => {
    const e = expr.trim();
    if (e.includes('JSON.stringify')) return '"9.9.9-smoke"';
    if (e.includes('extVersion')) return '9.9.9-smoke';
    if (e.includes('nonce')) return 'smoke-nonce';
    if (e.includes('cspSource')) return 'vscode-resource://smoke';
    if (/cssUri/i.test(e)) return 'vscode-resource://smoke/viewer.css';
    if (/scriptUri/i.test(e)) return 'vscode-resource://smoke/viewer.js';
    if (/pdfJsUri/i.test(e)) return 'vscode-resource://smoke/pdf.min.js';
    if (/pdfWorkerUri/i.test(e)) return 'vscode-resource://smoke/pdf.worker.min.js';
    if (e === 'v') return '1';
    return '';
  });
  return html;
}

const hostHtml = extractHostHtml();

console.log('===== 宿主 HTML 冒烟测试（真实 webview 页面 + viewer.js） =====');
console.log(`宿主模板：${path.relative(ROOT, PROVIDER)}`);
console.log(`执行脚本：${path.relative(ROOT, VIEWER)}`);

// ---------------------------------------------------------------- 场景：真实宿主 HTML
const dom = new JSDOM(hostHtml, {
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  url: 'https://localhost/'
});
const { window } = dom;
const document = window.document;

const localStorageStub = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); }
};

window.HTMLCanvasElement.prototype.getContext = () => null;
if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
document.createRange = () => ({
  setStart() {}, setEnd() {},
  getClientRects: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
});

// 宿主是在 <head> 的内联 <script> 里注入版本号的；jsdom 不执行内联脚本，这里照抄一遍
const injected = /window\.__EXT_VERSION__\s*=\s*([^<;]+);/.exec(hostHtml);
try {
  window.__EXT_VERSION__ = injected ? JSON.parse(injected[1]) : '';
} catch {
  window.__EXT_VERSION__ = '';
}

// 记录 webview → 宿主的消息，用来验证"段落快照/答疑有没有真的交给宿主持久化"
const postedMessages = [];
const vscode = { postMessage(m) { postedMessages.push(m); }, setState() {}, getState: () => null };
const pdfjsLib = {
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 0,
      getPage: () => Promise.resolve({
        getViewport: () => ({ width: 612, height: 792 }),
        getTextContent: () => Promise.resolve({ items: [] })
      })
    })
  })
};

const code = fs.readFileSync(VIEWER, 'utf8');
const tail = '})();';
const idx = code.lastIndexOf(tail);
if (idx < 0) throw new Error('找不到 IIFE 结尾');
const exposed =
  code.slice(0, idx) +
  `\n  window.__SMOKE__ = {
    ensureAllToolbarsExist,
    openAiAssistantModal,
    // 导出「全文双语精读稿」的真实实现（不是复制一份逻辑来测，而是直接调它）
    buildReadingDocMarkdown,
    archivePageParagraphs,
    recordAiQa,
    // 段落快照是**节流合并**后同步给宿主的；测试里要确定性，直接手动冲一次
    flushArchiveSync: flushPendingArchiveSync,
    seedPaperData: pd => { paperData = pd; },
    seedMeta: opts => { if (opts && Number.isFinite(opts.totalPages)) totalPages = opts.totalPages; }
  };\n` +
  code.slice(idx);

let error = null;
try {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'window', 'document', 'vscode', 'localStorage', 'navigator', 'pdfjsLib',
    'acquireVsCodeApi', 'console', 'fetch', 'setTimeout', 'clearTimeout', 'requestAnimationFrame',
    exposed
  );
  fn(
    window,
    document,
    vscode,
    localStorageStub,
    window.navigator,
    pdfjsLib,
    () => vscode,
    console,
    () => Promise.reject(new Error('no fetch in smoke test')),
    (f, ms) => window.setTimeout(f, ms),
    id => window.clearTimeout(id),
    cb => window.setTimeout(() => cb(Date.now()), 0)
  );

  if (window.__SMOKE__ && typeof window.__SMOKE__.ensureAllToolbarsExist === 'function') {
    window.__SMOKE__.ensureAllToolbarsExist();
  } else {
    throw new Error('未能取得 ensureAllToolbarsExist');
  }
  // 真实路径：从笔记卡片 / 划词浮条点「问AI」→ 打开问答弹窗
  if (window.__SMOKE__ && typeof window.__SMOKE__.openAiAssistantModal === 'function') {
    window.__SMOKE__.openAiAssistantModal({
      selectedText: '示例引文',
      contextText: '示例上下文',
      presetQuestion: '这是一个测试问题',
      page: 1
    });
  } else {
    throw new Error('未能取得 openAiAssistantModal');
  }
  // 反复使用（openAiAssistantModal 每次都调用 ensureAllToolbarsExist）不能把控件越堆越多
  for (let i = 0; i < 3; i++) {
    window.__SMOKE__.ensureAllToolbarsExist();
    window.__SMOKE__.openAiAssistantModal({ selectedText: `第${i}次提问`, contextText: '上下文', page: 1 });
  }
} catch (e) {
  error = e;
}

if (error) {
  console.log('\n❌ 在真实宿主 HTML 上执行 viewer.js 抛异常');
  console.log(`   ${error.name}: ${error.message}`);
  console.log((error.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

let miss = 0;
function check(label, ok, extra) {
  if (!ok) miss++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
}

console.log('\n[AI 问答弹窗 —— 所有「问AI」入口最终都打开它]');
check('宿主 HTML 自带 #aiAssistantModal（viewer.js 不会再重建它）', !!document.getElementById('aiAssistantModal'));
check(
  '回答风格切换控件存在于弹窗内',
  !!document.querySelector('#aiAssistantModal .ai-style-switch'),
  '三档：简洁 / 标准 / 审稿'
);
check(
  '控件位于**固定头部**（长对话也不会被滚出视野）',
  !!document.querySelector('#aiAssistantModal .ai-modal-header #aiModalStyleSlot .ai-style-switch')
);
check(
  '三档按钮齐全且当前档位高亮',
  document.querySelectorAll('#aiAssistantModal .ai-style-btn').length === 3 &&
    document.querySelectorAll('#aiAssistantModal .ai-style-btn.active').length === 1
);
check(
  '标题旁显示扩展版本号',
  (document.getElementById('aiModalVersion') || {}).textContent === 'v9.9.9-smoke',
  '实际：' + ((document.getElementById('aiModalVersion') || {}).textContent || '(元素都不存在)')
);
check(
  '「开始分析」预设按钮存在',
  !!document.getElementById('btnAnalyzeAiModal')
);

console.log('\n[批注便签气泡 —— 另一种 AI 提问入口]');
check('回答风格切换控件存在于 AI 提问栏旁', !!document.querySelector('.ai-style-switch-annot'));

// ------------------------------------------------------------------ 导出「全文双语精读稿」
console.log('\n[导出「全文双语精读稿」—— 调的是 viewer.js 里的真实实现]');
const S = window.__SMOKE__;
const now = Date.now();
// 真实环境里标题来自宿主下发的文件名
document.getElementById('paperTitle').textContent = 'cycle.pdf';
S.seedMeta({ totalPages: 11 });
S.seedPaperData({
  annotations: [
    {
      id: 'a1',
      page: 1,
      text: 'In this paper, we address several inadequacies of current video object segmentation pipelines.',
      color: 'yellow',
      note: '这句是全文动机：现有流程的不足。',
      paraIndex: 0,
      timestamp: now
    },
    {
      id: 'a2',
      page: 2,
      text: '这是一条没挂上段落的批注（例如段落切分变了）',
      color: 'pink',
      note: '',
      paraIndex: 99,
      timestamp: now
    }
  ],
  translations: {},
  sentenceTranslations: {},
  aiQa: []
});
S.archivePageParagraphs(1, [
  {
    id: 0,
    type: 'body',
    cleanText: 'In this paper, we address several inadequacies of current video object segmentation pipelines.',
    sentencesEn: [{ text: 'In this paper, we address several inadequacies of current video object segmentation pipelines.' }],
    translation: '在本文中，我们解决了当前视频目标分割流程的若干不足。',
    sentenceTranslations: ['在本文中，我们解决了当前视频目标分割流程的若干不足。']
  },
  {
    id: 1,
    type: 'figure-label',
    cleanText: 'IoU mIoU',
    sentencesEn: [{ text: 'IoU mIoU' }],
    translation: '',
    sentenceTranslations: []
  }
]);
S.archivePageParagraphs(2, [
  { id: 0, type: 'heading', cleanText: '3 Method', sentencesEn: [], translation: '3 方法', sentenceTranslations: [] },
  {
    id: 1,
    type: 'body',
    cleanText: 'First, a cyclic mechanism is incorporated. Next, we introduce a correction module.',
    sentencesEn: [
      { text: 'First, a cyclic mechanism is incorporated.' },
      { text: 'Next, we introduce a correction module.' }
    ],
    translation: '首先，引入循环机制。接下来，我们引入一个校正模块。',
    sentenceTranslations: ['首先，引入循环机制。', '接下来，我们引入一个校正模块。']
  }
]);
// 一条能挂回段落的答疑（selectedText 出现在该段原文里），走"交织进正文"的路
S.recordAiQa({
  page: 1,
  selectedText: 'In this paper, we address several inadequacies',
  question: '这句话的核心动机是什么？',
  answer: '因为现有流程依赖**参考掩码**，起始帧一有误差就会一路传播。',
  model: 'deepseek-chat'
});
// 一条挂不上段落的答疑（选中的句子不在留存段落里），走"本页其它记录"的路
S.recordAiQa({
  page: 2,
  selectedText: '某句已经不在留存段落里的话',
  question: '这里的符号是什么意思？',
  answer: '这是……',
  model: 'deepseek-chat'
});
const md = S.buildReadingDocMarkdown();
// 段落快照是节流同步的，这里手动冲一次，让后面的"是否交给宿主"断言是确定性的
S.flushArchiveSync();
// DUMP_DOC=1 时把生成的文稿原样打印出来；DUMP_DOC=<路径> 时同时存成文件，方便人眼审阅排版
if (process.env.DUMP_DOC) {
  const dumpTarget = process.env.DUMP_DOC;
  if (dumpTarget !== '1') {
    fs.writeFileSync(dumpTarget, md, 'utf8');
    console.log(`\n（已把生成的精读稿写入 ${dumpTarget}）`);
  } else {
    console.log('\n----- 生成的精读稿开始 -----\n' + md + '----- 生成的精读稿结束 -----\n');
  }
}
check('文稿以 YAML front-matter 开头', md.startsWith('---\n') && /^title: "cycle"$/m.test(md), '可被 Obsidian 等直接识别');
check('front-matter 记录了收录范围与统计', /^pages: 1–2 \/ 共 11 页$/m.test(md) && /^ai_qa: 2$/m.test(md));
check('有目录与页锚点', md.includes('## 目录') && md.includes('(#第-1-页)'));
check('原文进正文', md.includes('> In this paper, we address several inadequacies'));
check('译文进正文', md.includes('> 在本文中，我们解决了当前视频目标分割流程的若干不足。'));
check('章节标题作为小节标题渲染', md.includes('### 3 Method') && md.includes('> 3 方法'));
check('我的批注挂在对应段落之下', md.includes('📌 我的批注') && md.includes('这句是全文动机'));
check('AI 答疑的问与答都进正文', md.includes('这句话的核心动机是什么？') && md.includes('参考掩码'));
check(
  '挂不上段落的批注/答疑进「本页其它记录」而不是丢掉',
  md.includes('本页其它记录') && md.includes('这是一条没挂上段落的批注') && md.includes('这里的符号是什么意思？')
);
check('图表内部标签不进正文（那是坐标轴文字，不是论文内容）', !md.includes('IoU mIoU'));
check(
  '多句段落逐句成行（Markdown 不会把相邻引用行粘成一整段）',
  md.includes('> - First, a cyclic mechanism is incorporated.\n> - Next, we introduce a correction module.') &&
    md.includes('> - 首先，引入循环机制。\n> - 接下来，我们引入一个校正模块。')
);
check(
  '段落快照会同步给宿主持久化（否则重开插件再导出就只剩最后一页）',
  postedMessages.some(
    m => m.type === 'syncPageArchive' && m.page === 1 && Array.isArray(m.paragraphs) && m.paragraphs.length === 2
  )
);
check(
  'AI 答疑会同步给宿主持久化（不再关窗即失）',
  postedMessages.some(m => m.type === 'recordAiQa' && m.item && m.item.answer)
);

console.log('\n[反复打开问答弹窗不会重复堆叠控件]');
check('弹窗里只有一份风格切换', document.querySelectorAll('#aiAssistantModal .ai-style-switch').length === 1);
check('批注气泡里只有一份风格切换', document.querySelectorAll('.ai-style-switch-annot').length === 1);
check('弹窗里只有一份版本号', document.querySelectorAll('#aiAssistantModal #aiModalVersion').length === 1);

// 切换风格：两个入口必须同步高亮（同一份状态）
const reviewerBtn = document.querySelector('#aiAssistantModal .ai-style-btn[data-style="reviewer"]');
if (reviewerBtn) reviewerBtn.click();
check(
  '点「审稿」后，弹窗与批注栏两处控件同步高亮',
  document.querySelectorAll('.ai-style-btn').length === 6 &&
    document.querySelectorAll('.ai-style-btn.active').length === 2 &&
    Array.from(document.querySelectorAll('.ai-style-btn.active')).every(b => b.getAttribute('data-style') === 'reviewer')
);

if (miss > 0) {
  console.log(`\n❌ 真实宿主 HTML 下有 ${miss} 项没通过 —— 用户在界面上就是"看不到这个控件"`);
  process.exit(1);
}
console.log('\n✅ 真实宿主 HTML 下，回答风格切换在所有 AI 提问入口均可见且联动');
