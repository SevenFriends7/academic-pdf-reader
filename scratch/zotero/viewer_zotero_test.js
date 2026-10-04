/**
 * Zotero 联动的 webview 侧回归测试（真 jsdom，真派发消息）。
 *
 * 【为什么必须有这一层】`zoteroData` 是**异步到达**的消息（宿主探测完本地接口才发），
 * 完全可能早于 initPdfData。历史上这个仓库被"暂时性死区"坑过两次：
 * 初始化路径里读一个 `let` 声明在后面的变量 → ReferenceError → 整段初始化中断 → PDF 空白。
 * 所以这里不只做源码静态断言，还在真 DOM 里把消息派发进去，验证：
 *   ① IIFE 能加载；
 *   ② `zoteroData` 处理完不抛异常（TDZ 就会在这里炸）；
 *   ③ 认领成功时提示里带论文身份；接口没开时给的是"怎么开"的指引。
 *
 * 用法：node scratch/zotero/viewer_zotero_test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const VIEWER = process.env.VIEWER_PATH || path.join(ROOT, 'media', 'viewer.js');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  const candidates = [
    path.join(process.env.TEMP || '', 'jsdomtest', 'node_modules', 'jsdom'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'jsdom'),
    path.join(ROOT, 'node_modules', 'jsdom')
  ];
  for (const c of candidates) {
    try {
      ({ JSDOM } = require(c));
      break;
    } catch {
      /* 继续找 */
    }
  }
  if (!JSDOM) {
    console.error('需要 jsdom：npm install --prefix "%TEMP%\\jsdomtest" --no-save jsdom');
    process.exit(2);
  }
}

let pass = 0;
let fail = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}\n     ${(e && e.message) || e}`);
    console.log(`  ❌ ${name}\n     ${(e && e.message) || e}`);
  }
}

const html = `<!DOCTYPE html><html><head></head><body>
  <div id="pdfViewerContainer"><div class="pdf-pages"></div></div>
  <div id="toolbar"></div><span id="paperTitle"></span>
  <div id="notesList"></div><span id="notesBadge"></span>
  <div id="readerToast"></div>
</body></html>`;

const code = fs.readFileSync(VIEWER, 'utf8');

console.log('===== Zotero 联动：webview 侧回归测试（jsdom 真实 DOM + 真派发消息）=====\n');

// ---------------------------------------------------------------------------
console.log('【1】加载期：IIFE 不能在声明顺序上出错');
// ---------------------------------------------------------------------------
t('viewer.js 里 zoteroInfo 有且只有一处顶层声明（禁止重复声明/漏声明）', () => {
  const decls = code.match(/^\s{2}let zoteroInfo\b/gm) || [];
  assert.strictEqual(decls.length, 1, `期望 1 处顶层 let 声明，实际 ${decls.length} 处`);
});
t('zoteroInfo 的声明位置早于所有使用点（TDZ 防线）', () => {
  /*
   * 只比较**代码位置**，把注释里的提及排除掉。
   * 这里踩过两次：先按行剥注释，行内的 `/* … *​/` 能剥掉，但**跨行块注释**没剥干净，
   * 于是声明上方那段 JSDoc 里的 zoteroInfo 又被算成"使用点"（先差 2565、再差 2225）。
   * 所以先用带 [\s\S] 的正则把整块跨行注释剥掉，再逐行剥行尾注释。
   */
  const stripComments = src =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');
  const codeOnly = stripComments(code);
  const declMatch = /^\s{2}let zoteroInfo\b/m.exec(codeOnly);
  assert.ok(declMatch, '在代码里找不到 `let zoteroInfo` 顶层声明');
  /*
   * 比**行号**而不是字符偏移：声明语句整体匹配到的位置比标识符本身早 6 个字符
   * （两个空格 + `let ` ），拿偏移直接比会一直差 6 —— 判据本身写错了。
   * 行号口径才是"声明在使用之前"这句话的真实含义。
   */
  const lineOf = idx => codeOnly.slice(0, idx).split('\n').length;
  const declLine = lineOf(declMatch.index);
  const uses = [];
  const re = /\bzoteroInfo\b/g;
  let m;
  while ((m = re.exec(codeOnly))) uses.push(lineOf(m.index));
  assert.ok(uses.length >= 2, `zoteroInfo 应当至少"声明 + 使用"两处，实际 ${uses.length} 处`);
  const firstUse = Math.min(...uses);
  assert.ok(
    firstUse >= declLine,
    `zoteroInfo 首次出现在第 ${firstUse} 行，声明却在第 ${declLine} 行 —— 这就是暂时性死区崩溃的形态`
  );
  assert.ok(uses.some(l => l > declLine), '声明之后必须真的有用到它，否则这个变量是死代码');
});

/**
 * 按需补齐容器元素：真实 webview 的 HTML 里有一大批空容器，
 * 这里对普通 id 现造一个（否则 viewer.js 里 `dom.closePopoverBtn.addEventListener` 会打在 null 上）。
 *
 * 但这两个 id **必须保持缺失** —— viewer.js 用"取不到就创建"的方式生成它们，
 * 而历史崩溃正是发生在创建之后的代码里；替它们造好元素会让创建分支被跳过，
 * 测试就变成"永远通过"（这一条纪律照抄 scratch/smoke_init.js）。
 */
const MUST_STAY_MISSING = new Set(['annotationPopover', 'aiAssistantModal']);
function patchElementLookup(document) {
  const rawGet = document.getElementById.bind(document);
  document.getElementById = id => {
    const found = rawGet(id);
    if (found) return found;
    if (MUST_STAY_MISSING.has(id)) return null;
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    return el;
  };
}

/** 给一个 jsdom 窗口补齐 viewer.js 需要的浏览器 API（照抄 smoke_init.js 的口径） */
function prepareWindow(w) {
  w.HTMLCanvasElement.prototype.getContext = () => null;
  if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
  w.document.createRange = () => ({
    setStart() {},
    setEnd() {},
    getClientRects: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
  });
  patchElementLookup(w.document);
}

/** 在给定窗口里跑 viewer.js 的 IIFE（可注入"暴露内部函数"的补丁） */
function runViewer(w, source, vscodeStub) {
  const fn = new Function(
    'window', 'document', 'vscode', 'localStorage', 'navigator', 'pdfjsLib',
    'acquireVsCodeApi', 'console', 'fetch', 'setTimeout', 'clearTimeout', 'requestAnimationFrame',
    source
  );
  fn(
    w,
    w.document,
    vscodeStub,
    localStorageStub,
    w.navigator,
    pdfjsLib,
    () => vscodeStub,
    console,
    () => Promise.reject(new Error('no fetch in test')),
    (f, ms) => w.setTimeout(f, ms),
    id => w.clearTimeout(id),
    cb => w.setTimeout(() => cb(Date.now()), 0)
  );
}

// ---------------------------------------------------------------------------
console.log('\n【2】真 DOM：加载 viewer.js 并派发 zoteroData');
// ---------------------------------------------------------------------------
const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://localhost/' });
const { window } = dom;
const document = window.document;
prepareWindow(window);

const localStorageStub = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); }
};
/** 抓 webview 发出的宿主消息（不真发） */
const sent = [];
const vscode = {
  postMessage(m) { sent.push(m); },
  setState() {},
  getState: () => null
};
const pdfjsLib = {
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 0,
      getPage: () => Promise.resolve({ getViewport: () => ({ width: 612, height: 792 }), getTextContent: () => Promise.resolve({ items: [] }) })
    })
  })
};

/**
 * 抓 toast 文本。
 * 首选按真实实现选择：`showReaderToast` 会把文本写进带 `reader-toast` class 的盒子
 * （见 media/viewer.js 的 showReaderToast/ensureReaderToast）。兜底扫描只是防止
 * class 名改版后测试静默失灵——但兜底命中时要能在断言消息里看出来。
 */
function toastText() {
  const box = document.querySelector('.reader-toast');
  if (box && (box.textContent || '').trim()) return box.textContent.trim();
  const all = [...document.querySelectorAll('*')];
  const hit = all.find(e => /已认领 Zotero|Zotero 在运行|没检测到 Zotero|允许本机其它程序/.test(e.textContent || ''));
  return hit ? hit.textContent.trim() : '';
}

let loadError = null;
try {
  runViewer(window, code, vscode);
} catch (e) {
  loadError = e;
}

t('加载 media/viewer.js 的 IIFE 不抛异常', () => {
  assert.strictEqual(loadError, null, loadError ? `${loadError.name}: ${loadError.message}` : '');
});

function send(data) {
  const ev = new window.MessageEvent('message', { data });
  window.dispatchEvent(ev);
}

// 认领成功：真值是本机 Zotero 里 STM 那篇的实际字段
t('收到「认领成功」消息：不抛异常，且提示里带论文身份与上下文页数', () => {
  assert.strictEqual(loadError, null, 'IIFE 没加载成功，后续断言无意义');
  send({
    type: 'zoteroData',
    link: {
      attachmentKey: 'NQI6N4AP',
      parentKey: 'BYHD7ZKU',
      matchedBy: 'basename',
      fileName: 'Oh 等 - 2019 - Video Object Segmentation Using Space-Time Memory Networks.pdf',
      meta: {
        title: 'Video Object Segmentation Using Space-Time Memory Networks',
        creators: 'Oh et al.',
        year: '2019',
        venue: '2019 IEEE/CVF International Conference on Computer Vision (ICCV)',
        doi: '10.1109/ICCV.2019.00932',
        url: '',
        itemType: 'conferencePaper',
        summary: 'Oh et al. · 2019 · ICCV'
      },
      annotationCount: 0,
      fullTextPages: 10,
      pageCountMismatch: false
    },
    detect: { available: true, message: 'ok', prefsPath: null, baseUrl: 'http://127.0.0.1:23119' }
  });
  const txt = toastText();
  assert.ok(/已认领 Zotero 论文/.test(txt), `提示文本里没有认领字样，实际：「${txt}」`);
  assert.ok(document.querySelector('.reader-toast'), 'toast 必须落在 .reader-toast 盒子里（真实实现的选择器），否则用户看不到');
  assert.ok(/Oh et al\. · 2019 · ICCV/.test(txt), `提示里没有论文身份，实际：「${txt}」`);
  assert.ok(/10 页/.test(txt), `提示里没有"全书 10 页加入上下文"，实际：「${txt}」`);
});

t('页数不一致时：提示明说"全文上下文已跳过"（错位上下文比没有更坏）', () => {
  send({
    type: 'zoteroData',
    link: {
      attachmentKey: 'X',
      matchedBy: 'size',
      fileName: 'a.pdf',
      meta: { title: 'T', creators: '', year: '', venue: '', doi: '', url: '', itemType: '', summary: '' },
      annotationCount: 0,
      fullTextPages: 3,
      pageCountMismatch: true
    },
    detect: { available: true, message: 'ok', prefsPath: null, baseUrl: '' }
  });
  const txt = toastText();
  assert.ok(/已跳过/.test(txt), `应当提示已跳过全文上下文，实际：「${txt}」`);
});

t('没认领到 + 接口没开：给出"去 Zotero 设置里勾选"的指引（而不是静默）', () => {
  send({
    type: 'zoteroData',
    link: null,
    detect: {
      available: false,
      reason: 'api-disabled',
      message: 'Zotero 在运行，但本地接口没打开：Zotero 设置 → 高级 → 勾选「允许本机其它程序与 Zotero 通信」，然后重启 Zotero。',
      prefsPath: null,
      baseUrl: 'http://127.0.0.1:23119'
    }
  });
  const txt = toastText();
  assert.ok(/允许本机其它程序/.test(txt), `提示里没有给出开关指引，实际：「${txt}」`);
});

t('Zotero 没开 + 完全没认领到：静默通过（不打扰用户，阅读器照常用）', () => {
  const before = JSON.stringify(sent.length);
  send({ type: 'zoteroData', link: null, detect: { available: false, reason: 'not-running', message: '没检测到 Zotero', prefsPath: null, baseUrl: '' } });
  assert.ok(true, `不抛异常即可（发送计数 ${before} → ${sent.length}）`);
});

t('收到畸形消息（既没有 link 也没有 detect）也不崩', () => {
  send({ type: 'zoteroData' });
  send({ type: 'zoteroData', link: {}, detect: null });
  assert.ok(true);
});

// ---------------------------------------------------------------------------
console.log('\n【3】导出的精读稿要带上 Zotero 著录信息');
// ---------------------------------------------------------------------------
/**
 * 造一个"带补丁的副本"：在 IIFE 结尾前把内部函数挂到 window 上（只改内存副本，不动源文件）。
 * 每个副本一份独立 DOM/状态 —— 因为 zoteroInfo 是闭包内的单例，跨断言会互相污染。
 */
function makeInstance(exposeName, extraExpose) {
  const tail = '})();';
  const idx = code.lastIndexOf(tail);
  if (idx < 0) throw new Error('找不到 IIFE 结尾');
  const expose = `
  window.${exposeName} = {
    buildReadingDocMarkdown,
    setZoteroInfo: v => { zoteroInfo = v; },
    getZoteroInfo: () => zoteroInfo${extraExpose || ''}
  };
  `;
  const patched = code.slice(0, idx) + expose + code.slice(idx);
  const d = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://localhost/' });
  const w = d.window;
  prepareWindow(w);
  runViewer(w, patched, vscode);
  return w[exposeName];
}

t('没认领到 Zotero 时，精读稿里不出现 zotero_ 字段（不能凭空编造著录信息）', () => {
  const api = makeInstance('__ZTEST_A__');
  assert.ok(api, '补丁副本加载失败');
  const md = api.buildReadingDocMarkdown();
  assert.ok(!/zotero_title/.test(md), '没有认领却写了 zotero_title');
  assert.ok(!/zotero_doi/.test(md), '没有认领却写了 zotero_doi');
});

t('认领后导出：frontmatter 里有 zotero_title/authors/year/venue/doi/item，引言块有引用行', () => {
  const api = makeInstance('__ZTEST_B__');
  api.setZoteroInfo({
    key: 'NQI6N4AP',
    meta: {
      title: 'Video Object Segmentation Using Space-Time Memory Networks',
      creators: 'Oh et al.',
      year: '2019',
      venue: 'ICCV',
      doi: '10.1109/ICCV.2019.00932',
      url: '',
      itemType: 'conferencePaper',
      summary: 'Oh et al. · 2019 · ICCV'
    }
  });
  const md = api.buildReadingDocMarkdown();
  assert.ok(/zotero_title: "Video Object Segmentation/.test(md), `frontmatter 缺 zotero_title：\n${md.slice(0, 600)}`);
  assert.ok(/zotero_authors: "Oh et al\."/.test(md), 'frontmatter 缺 zotero_authors');
  assert.ok(/zotero_year: 2019/.test(md), 'frontmatter 缺 zotero_year');
  assert.ok(/zotero_venue: "ICCV"/.test(md), 'frontmatter 缺 zotero_venue');
  assert.ok(/zotero_doi: 10\.1109\/ICCV\.2019\.00932/.test(md), 'frontmatter 缺 zotero_doi');
  assert.ok(/zotero_item: NQI6N4AP/.test(md), 'frontmatter 缺 zotero_item');
  assert.ok(/> Zotero：Video Object Segmentation/.test(md), '引言块里没有 Zotero 引用行');
});

t('标题/作者里的双引号不会把 YAML frontmatter 破坏掉', () => {
  const api = makeInstance('__ZTEST_C__');
  api.setZoteroInfo({
    key: 'K',
    meta: { title: 'A "quoted" title', creators: 'X "Y" Z', year: '', venue: '', doi: '', url: '', itemType: '', summary: '' }
  });
  const md = api.buildReadingDocMarkdown();
  const line = md.split('\n').find(l => l.startsWith('zotero_title:'));
  assert.ok(line, '没写 zotero_title');
  assert.ok(/A 'quoted' title/.test(line), `双引号没被替换成单引号：${line}`);
  assert.ok(!/zotero_title: "A "quoted"/.test(md), 'frontmatter 被未转义的双引号截断');
});

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  - ' + f));
}
// 同 zotero_client_test.js：同步写 + 只设 exitCode，别在异步写未落盘时 process.exit
process.exitCode = fail ? 1 : 0;
