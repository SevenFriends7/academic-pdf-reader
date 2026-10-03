/**
 * 初始化冒烟测试：在**真实的 DOM 实现**（jsdom）里执行 media/viewer.js 的整个 IIFE。
 *
 * 为什么需要它：现有的假 DOM 测试对 getElementById / querySelector 一律返回真值，
 * 于是"不存在则创建"的分支整段被跳过，初始化阶段的暂时性死区崩溃（TDZ）永远测不出来。
 * 线上因此连挂两次：PDF 不加载 / 无译文 / 主题错乱。
 *
 * 用法：
 *   set NODE_PATH=%TEMP%\jsdomtest\node_modules
 *   node scratch/smoke_init.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIEWER = process.env.VIEWER_PATH || path.join(ROOT, 'media', 'viewer.js');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  // 本机没装到项目里：回退到临时目录（NODE_PATH 在部分环境不生效，这里按绝对路径找）
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

const html = `<!DOCTYPE html><html><head></head><body>
  <div id="pdfViewerContainer"><div class="pdf-pages"></div></div>
  <div id="toolbar"></div><span id="paperTitle"></span>
  <div id="notesList"></div><span id="notesBadge"></span>
</body></html>`;

const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://localhost/' });
const { window } = dom;
const document = window.document;

// webview 里的 localStorage 是 VS Code 提供的；这里给一个不会抛错的等价物
const localStorageStub = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); }
};

// 补齐 jsdom 里缺失或会抛错的 API，尽量贴近真实 webview
window.HTMLCanvasElement.prototype.getContext = () => null;
if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
document.createRange = () => ({
  setStart() {}, setEnd() {},
  getClientRects: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
});

/**
 * 按需补齐容器元素：真实 webview 的 HTML 里有一大批空容器，
 * 这里对普通 id 现造一个（避免为了凑齐 HTML 反复试错）。
 *
 * 但这两个 id **必须保持缺失**：viewer.js 用"取不到就创建"的方式生成它们，
 * 而崩溃正是发生在创建之后的代码里（批注卡片创建完就挂风格切换控件 →
 * 读 AI_STYLES / aiStyle 触发暂时性死区）。若这里替它们造好元素，
 * 创建分支会被跳过，冒烟测试就又变成"永远通过"。
 */
const MUST_STAY_MISSING = new Set(['annotationPopover', 'aiAssistantModal']);
const rawGetElementById = document.getElementById.bind(document);
document.getElementById = id => {
  const found = rawGetElementById(id);
  if (found) return found;
  if (MUST_STAY_MISSING.has(id)) return null;
  const el = document.createElement('div');
  el.id = id;
  document.body.appendChild(el);
  return el;
};

const vscode = { postMessage() {}, setState() {}, getState: () => null };
const pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0, getPage: () => Promise.resolve({ getViewport: () => ({ width: 612, height: 792 }), getTextContent: () => Promise.resolve({ items: [] }) }) }) }) };

const code = fs.readFileSync(VIEWER, 'utf8');

// 把创建界面容器的函数暴露出来：它在真实环境里是"打开文档/首次渲染"时调用的，
// 而那次调用正是崩溃发生的地方（批注卡片刚建好就挂风格切换控件 → 读 AI_STYLES / aiStyle）。
const tail = '})();';
const idx = code.lastIndexOf(tail);
if (idx < 0) throw new Error('找不到 IIFE 结尾');
const exposed = code.slice(0, idx) + '\n  window.__SMOKE__ = { ensureAllToolbarsExist };\n' + code.slice(idx);

let error = null;
try {
  // 与 webview 一致：IIFE 直接执行
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

  // 关键一步：模拟"打开文档 → 创建界面容器"，
  // 崩溃就发生在这一步（批注卡片创建后立刻挂回答风格切换控件）。
  if (window.__SMOKE__ && typeof window.__SMOKE__.ensureAllToolbarsExist === 'function') {
    window.__SMOKE__.ensureAllToolbarsExist();
  } else {
    throw new Error('未能取得 ensureAllToolbarsExist（暴露点失效，冒烟测试形同虚设）');
  }
} catch (e) {
  error = e;
}

console.log('===== 初始化冒烟测试（jsdom 真实 DOM） =====');
console.log(`执行文件：${path.relative(ROOT, VIEWER)}`);

// 复现用的覆盖只服务于"让创建分支真的跑起来"；检查阶段要还原成真实查找
document.getElementById = rawGetElementById;

if (error) {
  console.log('\n❌ 初始化抛异常 —— 真实环境下用户会看到：PDF 不加载 / 无译文 / 主题错乱');
  console.log(`   ${error.name}: ${error.message}`);
  const stack = (error.stack || '').split('\n').slice(0, 5).join('\n');
  console.log(stack);
  process.exit(1);
}

// 关键 DOM 是否真的被创建出来（证明初始化跑到了最后，而不只是"没报错"）
const checks = [
  ['批注卡片', '#annotationPopover'],
  ['AI 问答弹窗', '#aiAssistantModal'],
  ['批注入口的回答风格切换控件（崩溃就发生在这里）', '.ai-style-switch-annot']
];
let miss = 0;
checks.forEach(([label, sel]) => {
  const ok = !!document.querySelector(sel);
  if (!ok) miss++;
  console.log(`   ${ok ? '✅' : '❌'} ${label} 已创建`);
});
console.log(`   提示条容器：${document.getElementById('readerToast') ? '✅' : '（首次提示时才创建，正常）'}`);
console.log(`   问答弹窗的风格控件：${document.querySelector('#aiModalStyleSlot .ai-style-switch') ? '✅ 已创建' : '（首次打开弹窗时创建，正常）'}`);

if (miss > 0) {
  console.log('\n⚠️ 初始化未抛异常，但有界面元素没建出来 —— 可能仍有问题');
  process.exit(1);
}
console.log('\n✅ 初始化全程无异常，关键界面元素齐备');
