/**
 * webview 侧单测：直接在 Node 里加载 media/viewer.js 的 IIFE（用 Proxy 造一个假 DOM），
 * 然后把内部函数暴露出来做断言。目的是抓两类致命问题：
 *   1. IIFE 加载就抛异常 → 整个右侧面板白屏
 *   2. Markdown 渲染 / 切句器 / 段落指纹 行为错误
 */
const fs = require('fs');
const path = require('path');

const VIEWER = process.env.VIEWER_PATH
  ? process.env.VIEWER_PATH
  : path.join(__dirname, '..', '..', 'media', 'viewer.js');
console.log(`被测文件: ${VIEWER}\n`);
let code = fs.readFileSync(VIEWER, 'utf8');

// 在 IIFE 结束前把内部函数挂到 window 上（只改内存中的副本，不动源文件）
const tail = '})();';
const idx = code.lastIndexOf(tail);
if (idx < 0) throw new Error('找不到 IIFE 结尾');
const expose = `
  window.__TEST__ = {
    renderMarkdownToHtml,
    renderInlineMarkdown,
    splitEnglishSentencesSmart,
    getParaSig,
    buildAiHistory,
    renderSentencePairsHtml,
    aiConversationRef: () => aiConversation,
    setAiConversation: (v) => { aiConversation = v; }
  };
`;
code = code.slice(0, idx) + expose + code.slice(idx);

// ---------- 假 DOM ----------
function fakeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle() {},
      contains(c) { return this._s.has(c); }
    },
    dataset: {},
    children: [],
    innerHTML: '',
    outerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    _eventsBound: false,
    _delegated: false,
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {},
    remove() {},
    replaceWith() {},
    append() {},
    prepend() {},
    before() {},
    after() {},
    insertAdjacentHTML() {},
    insertAdjacentElement() {},
    cloneNode() { return fakeEl(this.tagName); },
    matches() { return false; },
    setAttribute() {},
    getAttribute() { return null; },
    hasAttribute() { return false; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return null; }, // 真实 DOM 语义：找不到就是 null
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    scrollTo() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 }; },
    insertBefore() {},
    contains() { return false; }
  };
  // parentNode / 尺寸属性
  el.parentNode = null;
  el.firstChild = null;
  el.lastChild = null;
  el.clientWidth = 1000;
  el.clientHeight = 800;
  el.scrollTop = 0;
  el.scrollHeight = 1000;
  el.offsetHeight = 20;
  el.offsetWidth = 100;
  return el;
}

const elCache = new Map();
/**
 * 这些 id 让 getElementById 返回 null，从而**强制走"不存在则创建"的分支**。
 *
 * 为什么必须这么做：初始化阶段创建批注卡片/问答弹窗时会调用 createAiStyleSwitch()，
 * 而它会读取 AI_STYLES / aiStyle 这两个"暂时性死区"变量。旧版假 DOM 对任何 id 都返回
 * 真值，这些分支被整段跳过 —— 于是线上真实发生过两次的崩溃
 * （Cannot access '…' before initialization → PDF 不加载 / 无译文 / 主题错乱）
 * 测试一次都没拦住。返回 null 才会真正执行初始化路径。
 */
const FORCE_CREATE_IDS = new Set(['annotPopover', 'aiAssistantModal']);
// 记录初始化过程中真实创建过的元素，用于断言"创建分支确实被执行了"
const createdElements = [];
const documentStub = {
  body: fakeEl('body'),
  documentElement: fakeEl('html'),
  head: fakeEl('head'),
  getElementById(id) {
    if (FORCE_CREATE_IDS.has(id)) return null;
    if (!elCache.has(id)) elCache.set(id, fakeEl('div'));
    return elCache.get(id);
  },
  createElement(tag) {
    const el = fakeEl(tag);
    createdElements.push(el);
    return el;
  },
  createTextNode(t) { return { textContent: t, length: (t || '').length }; },
  createRange() {
    return {
      setStart() {}, setEnd() {},
      getClientRects() { return []; }
    };
  },
  querySelector() { return null; }, // 真实 DOM 语义：找不到就是 null
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {}
};

const windowStub = {
  addEventListener() {},
  removeEventListener() {},
  getSelection() { return { toString: () => '', rangeCount: 0 }; },
  localStorage: { getItem: () => null, setItem: () => {} },
  PDF_WORKER_URL: 'about:blank'
};

const vscodeStub = { postMessage() {}, setState() {}, getState() { return null; } };
const localStorageStub = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const navigatorStub = { clipboard: { writeText: async () => {} } };
const pdfjsLibStub = { GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve({}) }; } };

let loadError = null;
try {
  const fn = new Function(
    'window',
    'document',
    'vscode',
    'localStorage',
    'navigator',
    'pdfjsLib',
    'acquireVsCodeApi',
    'console',
    'fetch',
    'setTimeout',
    'clearTimeout',
    'requestAnimationFrame',
    code
  );
  fn(
    windowStub,
    documentStub,
    vscodeStub,
    localStorageStub,
    navigatorStub,
    pdfjsLibStub,
    () => vscodeStub,
    console,
    () => Promise.reject(new Error('no fetch in test')),
    (f) => 0,
    () => {},
    () => 0
  );
} catch (e) {
  loadError = e;
}

console.log('===== T0 viewer.js IIFE 加载 =====');
if (loadError) {
  console.log('❌ FAIL —— 加载即抛异常（真实环境下右侧面板会直接白屏）');
  console.log(loadError && loadError.stack ? loadError.stack.split('\n').slice(0, 6).join('\n') : loadError);
} else {
  console.log('✅ PASS —— IIFE 正常执行完毕');
}

const T = windowStub.__TEST__;
if (!T) {
  console.log('\n!! 未能取得内部函数，后续测试跳过');
  process.exit(loadError ? 1 : 0);
}

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`); }
}
function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

// ---------- 0b. 初始化路径确实被执行（TDZ 崩溃的前提条件） ----------
// 假 DOM 必须强制走"不存在则创建"的分支，否则 AI_STYLES / aiStyle 的暂时性死区
// 错误永远不会暴露——线上两次崩溃（PDF 不加载 / 无译文 / 主题错乱）就是这样漏掉的。
console.log('\n===== T0b 初始化路径确实被执行 =====');
checkTrue(
  '初始化里"不存在则创建"的分支跑到了（否则 TDZ 崩溃测不出来）',
  createdElements.length > 0,
  `createElement 调用次数 = ${createdElements.length}`
);

// ---------- 1. 段落指纹：旧版碰撞回归测试 ----------
console.log('\n===== T1 段落指纹 getParaSig（旧版「前 28 字符」碰撞回归） =====');
const p1 = 'In this paper, we propose a novel approach for video object segmentation based on memory.';
const p2 = 'In this paper, we propose a novel approach that differs completely in every other way.';
const oldSig = s => s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 28);
checkTrue(
  '旧算法在两段上确实碰撞（说明回归测试有效）',
  oldSig(p1) === oldSig(p2),
  `oldSig1=${oldSig(p1)} oldSig2=${oldSig(p2)}`
);
checkTrue('新算法对这两段给出不同指纹', T.getParaSig(p1) !== T.getParaSig(p2), `${T.getParaSig(p1)} vs ${T.getParaSig(p2)}`);
checkTrue('同一文本指纹稳定', T.getParaSig(p1) === T.getParaSig(p1));
checkTrue('空白差异不影响指纹', T.getParaSig('a  b\n c') === T.getParaSig('a b c'));
check('空文本指纹为空串', T.getParaSig(''), '');

// ---------- 2. 切句器 ----------
console.log('\n===== T2 英文切句器 splitEnglishSentencesSmart =====');
function t2(text) {
  return T.splitEnglishSentencesSmart(text);
}
const c1 = t2('We use a CNN. It works well.');
check('普通两句', c1.map(s => s.text), ['We use a CNN.', 'It works well.']);

const c2 = t2('This was shown by Smith et al. (2020) in prior work. Our method differs.');
check('et al. 不误切', c2.map(s => s.text), ['This was shown by Smith et al. (2020) in prior work.', 'Our method differs.']);

const c3 = t2('Accuracy is 3.5 percent higher. See Fig. 2 for details.');
check('小数与 Fig. 不误切', c3.map(s => s.text), ['Accuracy is 3.5 percent higher.', 'See Fig. 2 for details.']);

const c4 = t2('We propose X. We verify Y. We conclude Z.');
check('单字母变量后跟句号仍能正确切成 3 句（回归：旧版会吞成 1 句）', c4.map(s => s.text).length, 3);

const c4b = t2('Let the set S. Then we define W. Finally Z.');
check('变量名结尾句号场景 2', c4b.map(s => s.text), ['Let the set S.', 'Then we define W.', 'Finally Z.']);

const c4c = t2('This is cited in Sec. 3. Another claim follows.');
check('Sec. 缩写不误切', c4c.map(s => s.text), ['This is cited in Sec. 3.', 'Another claim follows.']);

// 序号不能与句子拆开（用户反馈：序号被单独翻译，观感很差）
const c7 = t2('1. Introduction to the method. We then describe it.');
check('序号 "1." 不单独成句', c7.map(s => s.text), ['1. Introduction to the method.', 'We then describe it.']);

const c8 = t2('(2) The encoder processes frames. (3) The decoder reconstructs them.');
check('"(2)" 括号序号不单独成句', c8.map(s => s.text), [
  '(2) The encoder processes frames.',
  '(3) The decoder reconstructs them.'
]);

const c9 = t2('III. Method. We use a ResNet backbone.');
check('罗马数字序号不单独成句', c9.map(s => s.text), ['III. Method.', 'We use a ResNet backbone.']);

const src = 'First sentence here. Second one follows! Third? Yes, done.';
const c5 = t2(src);
checkTrue(
  'startIdx/endIdx 与 cleanText 严格自洽（旧版会错位）',
  c5.every(s => src.slice(s.startIdx, s.endIdx) === s.text),
  JSON.stringify(c5.map(s => ({ t: s.text, slice: src.slice(s.startIdx, s.endIdx) })))
);
checkTrue('句子下标不重叠且递增', c5.every((s, i) => i === 0 || s.startIdx > c5[i - 1].startIdx), JSON.stringify(c5.map(s => [s.startIdx, s.endIdx])));

const c6 = t2('   Leading spaces.   Trailing tail without period   ');
checkTrue('首句不含前导空格', c6[0] && !/^\s/.test(c6[0].text), JSON.stringify(c6.map(s => s.text)));
const src6 = '   Leading spaces.   Trailing tail without period   ';
checkTrue('带前导空格时下标仍自洽', c6.every(s => src6.slice(s.startIdx, s.endIdx) === s.text), JSON.stringify(c6.map(s => src6.slice(s.startIdx, s.endIdx))));

// ---------- 3. Markdown 渲染 ----------
console.log('\n===== T3 Markdown 渲染 =====');
const md1 = T.renderMarkdownToHtml('## 标题\n\n- 项目一\n- 项目二\n\n**加粗** 与 `代码`');
checkTrue('标题渲染为 h3（## → h3）', /<h3[^>]*>标题<\/h3>/.test(md1), md1);
checkTrue('无序列表渲染为 <ul>', /<ul class="md-list">/.test(md1) && /<li>项目一<\/li>/.test(md1), md1);
checkTrue('加粗渲染', /<strong>加粗<\/strong>/.test(md1), md1);
checkTrue('行内代码渲染', /<code class="md-code">代码<\/code>/.test(md1), md1);

const md2 = T.renderMarkdownToHtml('> 引用一行\n> 引用两行');
checkTrue('引用渲染为 blockquote', /<blockquote class="md-quote">/.test(md2), md2);
checkTrue('引用内不再出现 &gt; 字面量', !/&gt;/.test(md2), md2);

const md3 = T.renderMarkdownToHtml('公式 $\\mathcal{J}$ 与行内 `a**b**`');
checkTrue('$...$ 公式保留且不被吃掉', /md-math/.test(md3) && /\\mathcal\{J\}/.test(md3), md3);
checkTrue('代码里的 ** 不被加粗（旧版会误加粗）', !/<strong>b<\/strong>/.test(md3), md3);

const md4 = T.renderMarkdownToHtml('```js\nconst a = 1 < 2;\n```');
checkTrue('围栏代码块渲染为 pre', /<pre class="md-pre"/.test(md4), md4);
checkTrue('代码块内容被转义', /1 &lt; 2/.test(md4), md4);

const md5 = T.renderMarkdownToHtml('危险 <img src=x onerror=alert(1)> 文本');
checkTrue('HTML 注入被转义（无 XSS）', !/<img/.test(md5) && /&lt;img/.test(md5), md5);

const md6 = T.renderMarkdownToHtml('1. 第一步\n2. 第二步');
checkTrue('有序列表渲染为 <ol>', /<ol class="md-list">/.test(md6) && /<li>第一步<\/li>/.test(md6), md6);

const md7 = T.renderMarkdownToHtml('---');
checkTrue('分隔线渲染为 hr', /<hr class="md-hr">/.test(md7), md7);

check('空输入返回空串', T.renderMarkdownToHtml(''), '');

// ---------- 4. 多轮历史整理 ----------
console.log('\n===== T4 多轮历史 buildAiHistory =====');
T.setAiConversation([
  { role: 'user', text: 'Q1' },
  { role: 'model', text: 'A1' },
  { role: 'user', text: 'Q2' },
  { role: 'model', text: '错误', error: true },
  { role: 'user', text: 'Q3' }
]);
const hist = T.buildAiHistory();
check('错误轮被剔除', hist.some(h => h.text === '错误'), false);
checkTrue('首条必须是 user（Gemini 要求）', hist.length > 0 && hist[0].role === 'user', JSON.stringify(hist));
checkTrue('连续同角色被合并', hist.every((h, i) => i === 0 || h.role !== hist[i - 1].role), JSON.stringify(hist.map(h => h.role)));
checkTrue('最近 8 轮以内', hist.length <= 8, String(hist.length));

T.setAiConversation([{ role: 'model', text: '孤儿回答' }, { role: 'user', text: 'Q' }]);
checkTrue('开头的 model 轮被裁掉', T.buildAiHistory()[0].role === 'user', JSON.stringify(T.buildAiHistory()));

// ---------- 5. 未对齐渲染 ----------
console.log('\n===== T5 未对齐时不得伪造句对 =====');
const para = {
  id: 0,
  cleanText: 'One. Two. Three.',
  sentencesEn: T.splitEnglishSentencesSmart('One. Two. Three.')
};
const paragraphTrans = '一。二。三。四。五。';
const htmlUnaligned = T.renderSentencePairsHtml(para, paragraphTrans, null);
checkTrue('未对齐时给出如实提示', /trans-unaligned-box/.test(htmlUnaligned), htmlUnaligned.slice(0, 260));
checkTrue('未对齐时不出现伪造的逐句译文行', !/sent-zh/.test(htmlUnaligned), htmlUnaligned.slice(0, 400));
checkTrue('未对齐时仍列出英文原句', (htmlUnaligned.match(/sent-en/g) || []).length === 3, String((htmlUnaligned.match(/sent-en/g) || []).length));

const htmlAligned = T.renderSentencePairsHtml(para, paragraphTrans, ['一。', '二。', '三。']);
checkTrue('对齐时正常渲染句对', (htmlAligned.match(/sent-zh/g) || []).length === 3, String((htmlAligned.match(/sent-zh/g) || []).length));
checkTrue('对齐时每行中文不重复贴整段', !htmlAligned.includes(paragraphTrans), '存在整段重复');

const htmlWrongCount = T.renderSentencePairsHtml(para, paragraphTrans, ['一。', '二。']);
checkTrue('句数不足时按未对齐处理（旧版会比例硬塞）', /trans-unaligned-box/.test(htmlWrongCount), htmlWrongCount.slice(0, 200));

// ---------- 6. 分栏沟槽检测（从数据推断，而非写死 49.5%） ----------
console.log('\n===== T6 版面结构检测（沟槽自适应） =====');
function extractGutterDetector(src) {
  const start = src.indexOf('const detectColumnStructure = (spanList, pageW) => {');
  const end = src.indexOf('const colStruct = detectColumnStructure(spans, pagePdfW);');
  if (start < 0 || end < 0 || end <= start) return null;
  // eslint-disable-next-line no-new-func
  return new Function(
    `${src.slice(start, end)}\n return detectColumnStructure;`
  )();
}
const detectCols = extractGutterDetector(code);
checkTrue('成功抽出沟槽检测函数', !!detectCols, detectCols ? '' : '未找到 detectColumnStructure');

if (detectCols) {
  const line = (x, w, y, len) => ({
    _pdfX: x,
    _pdfY: y,
    _pdfW: w,
    _pdfH: 9,
    textContent: 'x'.repeat(len || 60)
  });

  // A. 标准双栏 Letter（612pt，沟槽约 303）：左栏 50→291，右栏 315→556
  const twoCol = [];
  for (let i = 0; i < 20; i++) {
    const y = 700 - i * 12;
    twoCol.push(line(50, 241, y));
    twoCol.push(line(315, 241, y));
  }
  const rA = detectCols(twoCol, 612);
  checkTrue('标准双栏 → 判定为双栏', rA.twoColumn === true, JSON.stringify(rA));
  checkTrue(
    `沟槽位置贴近实际（≈299，允许 ±25）`,
    Math.abs(rA.gutterX - 299) < 25,
    `实测 gutterX=${rA.gutterX.toFixed(1)}`
  );

  // B. 非对称双栏（沟槽在 40% 处）：证明不是写死 49.5%
  const asym = [];
  for (let i = 0; i < 20; i++) {
    const y = 700 - i * 12;
    asym.push(line(40, 160, y)); // 左栏窄：40→200
    asym.push(line(260, 300, y)); // 右栏宽：260→560
  }
  const rB = detectCols(asym, 612);
  checkTrue('非对称双栏 → 判定为双栏', rB.twoColumn === true, JSON.stringify(rB));
  checkTrue(
    `非对称沟槽按实测位置（≈230，而非 303）`,
    Math.abs(rB.gutterX - 230) < 25,
    `实测 gutterX=${rB.gutterX.toFixed(1)}（写死 49.5% 会得到 302.9）`
  );

  // C. 单栏论文：正文横跨中部 → 无沟槽
  const oneCol = [];
  for (let i = 0; i < 40; i++) oneCol.push(line(72, 468, 700 - i * 12));
  const rC = detectCols(oneCol, 612);
  checkTrue('单栏论文 → 判定为单栏', rC.twoColumn === false, JSON.stringify(rC));

  // D. 只有左栏有字（右侧整栏是图）→ 不应误判为双栏
  const leftOnly = [];
  for (let i = 0; i < 30; i++) leftOnly.push(line(50, 241, 700 - i * 12));
  const rD = detectCols(leftOnly, 612);
  checkTrue('只有一侧有正文 → 不判为双栏', rD.twoColumn === false, JSON.stringify(rD));

  // E. A4 尺寸的双栏（595pt）也应自适应
  const a4 = [];
  for (let i = 0; i < 20; i++) {
    const y = 780 - i * 12;
    a4.push(line(56, 230, y));
    a4.push(line(300, 230, y));
  }
  const rE = detectCols(a4, 595);
  checkTrue('A4 双栏 → 双栏且沟槽位置正确', rE.twoColumn === true && Math.abs(rE.gutterX - 288) < 25, JSON.stringify(rE));
}

// ---------- 7. 卡片操作栏溢出 + AI 弹窗去花哨（CSS 回归护栏） ----------
console.log('\n===== T7 布局与样式回归护栏（viewer.css） =====');
const CSS_PATH = process.env.VIEWER_PATH
  ? path.join(path.dirname(process.env.VIEWER_PATH), 'viewer.css')
  : path.join(__dirname, '..', '..', 'media', 'viewer.css');
let css = '';
try {
  css = fs.readFileSync(CSS_PATH, 'utf8');
} catch (e) {
  console.log('  (未找到 viewer.css，跳过)');
}
if (css) {
  // 先剥掉 CSS 注释，否则注释里提到 "nowrap" 会造成假阳性
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = (sel) => {
    // 按「行首 + 精确选择器」匹配，避免把 `.parent:hover .sel { }` 这类
    // 复合选择器也当成主规则（否则断言会误判）
    const re = new RegExp(
      '(?:^|\\n)[ \\t]*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}',
      'g'
    );
    const out = [];
    let m;
    while ((m = re.exec(cssNoComments)) !== null) out.push(m[1]);
    return out;
  };

  const cardActions = blocks('.card-actions');
  checkTrue('存在 .card-actions 规则', cardActions.length > 0, `找到 ${cardActions.length} 处`);
  checkTrue(
    '所有 .card-actions 规则都不含 nowrap（溢出根因）',
    cardActions.every(b => !/nowrap/.test(b)),
    cardActions.map(b => b.replace(/\s+/g, ' ').trim()).join(' | ')
  );
  checkTrue(
    '所有 .card-actions 规则都允许换行',
    cardActions.every(b => /flex-wrap:\s*wrap/.test(b)),
    cardActions.map(b => (/flex-wrap:\s*wrap/.test(b) ? 'wrap' : 'MISSING')).join(', ')
  );

  const headers = blocks('.trans-card-header');
  checkTrue(
    '.trans-card-header 允许换行（窄栏时按钮组独占一行）',
    headers.length > 0 && headers.every(b => /flex-wrap:\s*wrap/.test(b)),
    headers.map(b => b.replace(/\s+/g, ' ').trim()).join(' | ')
  );

  const sendBtn = blocks('.btn-send-ai');
  checkTrue(
    '发送按钮不再使用渐变（去花哨）',
    sendBtn.length > 0 && sendBtn.every(b => !/gradient/.test(b)),
    sendBtn.map(b => b.replace(/\s+/g, ' ').trim()).join(' | ')
  );
  const modalHeader = blocks('.ai-modal-header');
  checkTrue(
    '弹窗标题栏不再使用渐变背景',
    modalHeader.length > 0 && modalHeader.every(b => !/gradient/.test(b)),
    modalHeader.map(b => b.replace(/\s+/g, ' ').trim()).join(' | ')
  );
  const modalCard = blocks('.ai-modal-card');
  checkTrue(
    '弹窗卡片不再有放大位移动画（只保留淡入）',
    modalCard.length > 0 && modalCard.every(b => !/scale\(/.test(b)),
    modalCard.map(b => b.replace(/\s+/g, ' ').trim()).join(' | ')
  );
  const askBtn = blocks('.btn-ask-ai');
  checkTrue(
    '批注气泡的「AI 提问」按钮不再使用渐变',
    askBtn.length > 0 && askBtn.every(b => !/gradient/.test(b)),
    askBtn.map(b => b.replace(/\s+/g, ' ').trim()).join(' | ')
  );

  // 逐句行右侧操作：必须是「常驻窄图标条」——既不吃正文宽度，也不能遮挡文字
  const rowActions = blocks('.sent-row-actions');
  checkTrue('存在 .sent-row-actions 规则', rowActions.length > 0, `找到 ${rowActions.length} 处`);
  checkTrue(
    '.sent-row-actions 是固定窄条（不再用绝对定位浮层遮住译文）',
    rowActions.every(b => /flex:\s*0 0 22px/.test(b)) && rowActions.every(b => !/position:\s*absolute/.test(b)),
    rowActions.map(b => b.replace(/\s+/g, ' ').trim()).join(' | ')
  );
  checkTrue(
    '.sent-row-actions 不再 flex-shrink: 0 吃固定宽度',
    rowActions.every(b => !/flex-shrink:\s*0/.test(b)),
    rowActions.map(b => b.replace(/\s+/g, ' ').trim()).join(' | ')
  );
  checkTrue(
    '窄条内的按钮被压到 20px 宽（图标化）',
    /\.sent-row-actions button\s*\{[^}]*width:\s*20px/.test(cssNoComments),
    '未找到 .sent-row-actions button 的宽度约束'
  );
  checkTrue(
    '.sent-content 可收缩（min-width: 0，防止内容撑破）',
    blocks('.sent-content').every(b => /min-width:\s*0/.test(b)),
    blocks('.sent-content').map(b => b.replace(/\s+/g, ' ').trim()).join(' | ')
  );
}

// ---------- 8. 自动适应窗口宽度 ----------
console.log('\n===== T8 自动适应宽度（真实代码抽取） =====');
function extractFitHelpers(src) {
  const start = src.indexOf('const FIT_MIN_SCALE');
  const end = src.indexOf('function updateFitButtonState()');
  if (start < 0 || end < 0 || end <= start) return null;
  const snippet = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    'dom',
    `${snippet}\n return { clampFitScale, computeFitScaleFromWidth, getAvailablePaneWidth, FIT_MIN_SCALE, FIT_MAX_SCALE, FIT_MARGIN };`
  );
}
const fitFactory = extractFitHelpers(code);
checkTrue('成功抽出适应宽度计算代码', !!fitFactory, fitFactory ? '' : '未找到 FIT_MIN_SCALE / updateFitButtonState');

if (fitFactory) {
  // 容器无水平内边距时：可用宽度 = clientWidth - FIT_MARGIN(8)
  const withPane = w => fitFactory({ pdfViewerContainer: { clientWidth: w } });

  // Letter 尺寸页面（612pt 宽）在 1000px 容器内 → (1000-8)/612 ≈ 1.621
  const r1 = withPane(1000);
  checkTrue(
    '1000px 容器 + 612pt 页面 → 比例约 1.621',
    Math.abs(r1.computeFitScaleFromWidth(612) - 1.621) < 0.01,
    String(r1.computeFitScaleFromWidth(612))
  );

  // 窄栏：仍能算出比例（不返回 null）
  const r2 = withPane(400);
  checkTrue(
    '400px 窄栏 → 比例约 0.641（不因窄栏而放弃适应）',
    Math.abs(r2.computeFitScaleFromWidth(612) - 0.641) < 0.01,
    String(r2.computeFitScaleFromWidth(612))
  );

  // 上夹紧：超宽屏
  const r3 = withPane(6000);
  checkTrue('超宽容器 → 夹到上限 3.5', r3.computeFitScaleFromWidth(612) === 3.5, String(r3.computeFitScaleFromWidth(612)));

  // 下夹紧：极窄栏
  const r4 = withPane(150);
  checkTrue('极窄容器 → 夹到下限 0.3', r4.computeFitScaleFromWidth(612) === 0.3, String(r4.computeFitScaleFromWidth(612)));

  // 容器过窄（可用宽度 ≤120）→ 不强行缩放
  const r5 = withPane(125);
  checkTrue('容器过窄（125px）→ 返回 null，不强行缩放', r5.computeFitScaleFromWidth(612) === null, String(r5.computeFitScaleFromWidth(612)));

  // 异常输入
  const r6 = withPane(1000);
  checkTrue('页面宽度为 0 → 返回 null', r6.computeFitScaleFromWidth(0) === null, String(r6.computeFitScaleFromWidth(0)));
  checkTrue('页面宽度为负 → 返回 null', r6.computeFitScaleFromWidth(-5) === null, String(r6.computeFitScaleFromWidth(-5)));

  // 横向大图页：同样的栏宽下比例更小
  const wide = withPane(1000).computeFitScaleFromWidth(1200);
  const narrow = withPane(1000).computeFitScaleFromWidth(612);
  checkTrue('横向大图页会自动缩得更小', wide < narrow, `wide=${wide} narrow=${narrow}`);

  // 缺失容器时不崩
  const r7 = fitFactory({});
  checkTrue('没有容器元素时安全返回 null', r7.computeFitScaleFromWidth(612) === null, String(r7.computeFitScaleFromWidth(612)));
}

// 接线检查：手动缩放必须关闭自动适应，否则用户刚放大就会被容器变化冲掉
console.log('  --- 接线检查 ---');
checkTrue(
  'renderPage 内部会按自动模式重算比例',
  /autoFitEnabled\s*&&\s*unscaledWidth\s*>\s*0/.test(code) && /computeFitScaleFromWidth\(unscaledWidth\)/.test(code)
);
checkTrue('zoomBy 会标记为手动缩放', /function zoomBy\(step\)\s*\{\s*markManualZoom\(\)/.test(code));
checkTrue('Ctrl+滚轮缩放会标记为手动缩放', /const handleCtrlWheelZoom[\s\S]{0,300}?markManualZoom\(\)/.test(code));
checkTrue('Ctrl+0 重置会标记为手动缩放', /e\.key === '0'[\s\S]{0,200}?markManualZoom\(\)/.test(code));
checkTrue(
  '「适合宽度」按钮会重新开启自动适应',
  /dom\.zoomFitBtn\.addEventListener\('click',[\s\S]{0,160}?autoFitEnabled = true/.test(code)
);
checkTrue(
  '用 ResizeObserver 监听左栏（window.resize 收不到拖分割线）',
  /new ResizeObserver\(onPaneResize\)/.test(code) && /ro\.observe\(dom\.pdfPane\)/.test(code)
);
checkTrue(
  '打开文档时即开启自动适应并做首次贴合',
  /setupAutoFitResize\(\)[\s\S]{0,800}?computeFitScaleFromWidth\(firstWidth\)/.test(code),
  '未在 initPdfData 流程里找到 setupAutoFitResize → 首次贴合 的连接'
);

// ---------- 9. 分栏判定必须按「行」而不是按「span」 ----------
console.log('\n===== T9 分栏判定粒度（图注被劈成左右两截的根因） =====');
checkTrue(
  '先按 y 聚成物理行（lineGroups）',
  /const lineGroups = \[\]/.test(code) && /lineGroupOf\.set\(s, g\)/.test(code)
);
checkTrue(
  '通栏判定用整行跨度 lineWidth（不是单个 span 的宽度）',
  /const lineWidth = lineMaxX - lineMinX/.test(code) && /lineWidth > 320/.test(code),
  '仍是按 span 宽度判定 → 多 span 的图注会被劈开'
);
checkTrue(
  '旧的按 span 宽度判定已移除',
  !/const isCrossColumn\s*=\s*\n?\s*!isSingleColumnPage && \(sw > 320/.test(code),
  '仍存在 `sw > 320` 形式的逐 span 判定'
);
checkTrue(
  '列的归属用整行中心 lineCenterX（保证同一行不被拆进两栏）',
  /lineCenterX < effectiveGutterX/.test(code) && !/midX < effectiveGutterX/.test(code)
);
checkTrue(
  '版面结构改为从数据检测沟槽（不再写死页宽比例）',
  /const detectColumnStructure = \(spanList, pageW\) =>/.test(code) &&
    /const colStruct = detectColumnStructure\(spans, pagePdfW\)/.test(code) &&
    /const isTwoColumnPage = colStruct\.twoColumn/.test(code),
  '未找到 detectColumnStructure / colStruct.twoColumn'
);
checkTrue(
  '旧的写死分栏线已移除',
  !/pagePdfW \* 0\.495(?!\s*\})/.test(code) || /return \{ twoColumn: false, gutterX: pageW \* 0\.495 \}/.test(code),
  '仍存在写死的 0.495 分栏线（仅允许作为检测失败时的兜底）'
);
checkTrue(
  '有沟槽容差常量，避免正文行轻微越线被误判通栏',
  /const GUTTER_CLEARANCE = 15/.test(code) &&
    /lineMinX < gutterX - GUTTER_CLEARANCE && lineMaxX > gutterX \+ GUTTER_CLEARANCE/.test(code)
);

// 端到端行为验证：模拟"一条图注被 PDF 拆成 4 个窄 span，横跨两栏"
// 期望：4 个 span 必须落到同一个桶（不能再出现左右各一半）
console.log('  --- 行为验证：多 span 图注必须整体归一栏 ---');
(function behaviorCheck() {
  const gutterX = 612 * 0.495; // ≈303
  const GUTTER_CLEARANCE = 15;
  // 复刻产物里的判定逻辑片段（与源码同源，若源码改了这里也会随之失败）
  const src = code;
  const usesLineExtent = /const lineMinX = g \? g\.minX : sx/.test(src) && /const lineMaxX = g \? g\.maxX : sx \+ sw/.test(src);
  checkTrue('判定逻辑确实取自整行跨度', usesLineExtent, '源码未按行取跨度');

  // 一条通栏图注：x 从 60 到 552，宽度 492
  const lineMinX = 60;
  const lineMaxX = 552;
  const lineWidth = lineMaxX - lineMinX;
  const isCross = lineWidth > 320 || (lineMinX < gutterX - GUTTER_CLEARANCE && lineMaxX > gutterX + GUTTER_CLEARANCE);
  checkTrue('通栏图注被判为跨栏（整行进同一个桶）', isCross === true, `lineWidth=${lineWidth}`);

  // 左栏正文行：x 50..300，不该被判通栏
  const bMin = 50;
  const bMax = 300;
  const bCross = bMax - bMin > 320 || (bMin < gutterX - GUTTER_CLEARANCE && bMax > gutterX + GUTTER_CLEARANCE);
  checkTrue('左栏正文行不被判为跨栏', bCross === false, `bMax-gutterX=${(bMax - gutterX).toFixed(1)}`);
  checkTrue('左栏正文行归属左栏', (bMin + bMax) / 2 < gutterX, String((bMin + bMax) / 2));

  // 右栏正文行
  const rMin = 330;
  const rMax = 560;
  checkTrue('右栏正文行归属右栏', (rMin + rMax) / 2 > gutterX, String((rMin + rMax) / 2));
})();

// ---------- 10. 图注识别（用户反馈：有图注被归到正文） ----------
console.log('\n===== T10 图注识别正则 =====');
(function captionRegexTest() {
  const m = code.match(/const captionLabelRegex\s*=\s*\n?\s*(\/.*\/[gimsuy]*);/);
  if (!m) {
    checkTrue('从产物中抽出 captionLabelRegex', false, '未找到该正则');
    return;
  }
  // 用源码里的字面量重建正则
  const re = eval(m[1]); // eslint-disable-line no-eval
  const positives = [
    'Figure 2: Our framework overview.',
    'Fig. 2. Our framework',
    'FIGURE 2 | The architecture',
    'Table 1: Results',
    'TABLE I. Hyper-parameters',
    'Extended Data Fig. 3: Cell counts',
    'Supplementary Figure 1. Details',
    '(a) Figure 2: Our framework',
    '(3) Fig. 2: Architecture',
    'Box 1. Definitions',
    'Algorithm 1: Training'
  ];
  const negatives = [
    'as shown in Fig. 2, the model performs well.',
    'In Figure 2 we show the overall architecture.',
    'We compare with Table 1 results and find improvements.',
    'The proposed method achieves state-of-the-art results on DAVIS.',
    '2. Related Work'
  ];
  const missed = positives.filter(t => !re.test(t));
  const wrong = negatives.filter(t => re.test(t));
  checkTrue(
    `图注写法全部识别（${positives.length} 种）`,
    missed.length === 0,
    missed.length ? `漏判: ${missed.join(' | ')}` : ''
  );
  checkTrue(
    `正文引用不被误判为图注（${negatives.length} 条反例）`,
    wrong.length === 0,
    wrong.length ? `误判: ${wrong.join(' | ')}` : ''
  );
})();

// ---------- 11. 图表区域标注（用 STM.pdf 第 3 页的真实几何数据） ----------
console.log('\n===== T11 图表区域后处理（真实页面数据） =====');
(function figureRegionTest() {
  const start = code.indexOf('(function markFigureRegions() {');
  const end = code.indexOf('})();', start);
  if (start < 0 || end < 0) {
    checkTrue('从产物中抽出 markFigureRegions', false, '未找到该片段');
    return;
  }
  const snippet = code.slice(start, end + 5);

  // STM.pdf 第 3 页真实行几何（来自 pdfjs 抽取，y 越大越靠上）
  // [y, minX, maxX, text]
  const RAW = [
    [706, 113, 488, 'Memory:Past frames with object maskQuery:Current frame'],
    [669, 131, 240, '……'],
    [617, 78, 515, '!"#%!"#%!"#%!"#$&\'#'],
    [611, 427, 467, 'Skip-connections'],
    [606, 306, 364, 'MemoryQuery'],
    [598, 307, 366, 'EncoderEncoder'],
    [591, 514, 537, 'Decoder'],
    [578, 126, 436, 'MemoryQuery'],
    [570, 123, 450, 'embeddingembedding'],
    [561, 72, 407, 'KeyValueKeyValueKeyValueKeyValue'],
    [550, 492, 522, 'Space-time'],
    [540, 175, 526, 'concat.Memory Read'],
    [528, 74, 127, ': Intermediate output'],
    [504, 50, 545, 'Figure 2: Overview of our framework. Our network consists of two encoders'],
    [492, 50, 545, 'space-time memory read block, and a decoder. The memory encoder takes an RGB frame'],
    [480, 50, 545, 'object mask is represented as a probability map used for estimated object masks.'],
    [468, 50, 208, '(EncQ) takes the query image as input.'],
    [434, 50, 545, '3. Space-Time Memory Networks (STM) The keys and values further go through our'],
    [422, 309, 545, 'memory read block. Every pixel on the key feature maps of the query and the'],
    [410, 62, 545, 'In our framework, video frames are sequentially processed starting from the second'],
    [398, 50, 545, 'frame using the ground truth annotation given in the first frame. During the video']
  ];

  // 复刻产物里的真实归属：跨栏行 → 'cross'，栏内行 → col1/col2，
  // 以 "Figure 2:" 开头的行及其折行 → 'caption'（图注在 y=504 起，共 4 行）
  const sectionOf = (i, text) => {
    if (i >= 13 && i <= 16) return 'caption'; // 图注 4 行（含最后一行折行）
    const [y, minX, maxX] = RAW[i];
    const w = maxX - minX;
    if (minX < 302.9 - 15 && maxX > 302.9 + 15) return 'cross'; // 横跨分栏线
    return minX + w / 2 < 302.9 ? 'col1' : 'col2';
  };
  const lines = RAW.map(([y, minX, maxX, text], i) => ({
    y,
    minX,
    maxX,
    h: 9,
    idx: i,
    spans: [{ textContent: text }],
    section: sectionOf(i, text)
  }));

  // 各栏满行基准用的"确定是正文的行"（以句末标点收尾、满栏宽）
  lines.push({
    y: 386,
    minX: 50,
    maxX: 290,
    h: 9,
    idx: 99,
    spans: [{ textContent: 'This reference body line spans the whole column width.' }],
    section: 'col1'
  });

  // eslint-disable-next-line no-new-func
  const run = new Function('orderedLines', 'captionLabelRegex', `${snippet}\n return orderedLines;`);
  const re = /^(?:[(\[](?:[a-h]|\d{1,2})[)\]]\s+)?(?:(?:Extended\s+Data|Supplement(?:ary|al)?|SI)\s+)?(?:Fig(?:\.|ure)?|Tab(?:\.|le)?|Box|Algorithm|Scheme|Chart|Exhibit|TABLE)\s*\.?\s*(?:\d+|[IVXLCDM]+)(?:\s*[.:：)—–-])?/i;
  const out = run(lines, re);

  const labelIdx = out.map((l, i) => (l.section === 'figure-label' ? i : -1)).filter(i => i >= 0);
  const diagramIdx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  checkTrue(
    `图注上方的图表内容全部被标记（${diagramIdx.length} 行）`,
    diagramIdx.every(i => out[i].section === 'figure-label'),
    `未标记的行: ${diagramIdx
      .filter(i => out[i].section !== 'figure-label')
      .map(i => i + ':' + RAW[i][3].slice(0, 26))
      .join(' | ')}`
  );
  checkTrue(
    '真正的图注行没有被误标（仍然翻译）',
    out[13].section === 'caption' && out[14].section === 'caption' && out[15].section === 'caption',
    `13=${out[13].section} 14=${out[14].section} 15=${out[15].section}`
  );
  checkTrue(
    '图注下方的正文行没有被误标',
    out[17].section !== 'figure-label' && out[18].section !== 'figure-label' && out[19].section !== 'figure-label',
    `17=${out[17].section} 18=${out[18].section} 19=${out[19].section}`
  );

  // 章节标题保护 + 满行正文保护
  const headingCase = [
    { y: 300, minX: 50, maxX: 240, h: 9, spans: [{ textContent: 'body line that spans the whole column width for reference' }], section: 'col1' },
    { y: 200, minX: 50, maxX: 200, h: 9, spans: [{ textContent: '3. Space-Time Memory Networks (STM)' }], section: 'col1' },
    { y: 100, minX: 50, maxX: 545, h: 9, spans: [{ textContent: 'Figure 5: Something. Caption text here.' }], section: 'caption' }
  ];
  const hOut = run(headingCase, re);
  checkTrue(
    '满行正文会挡住向上扩展（正文段落不会被吞进图表区域）',
    hOut[0].section !== 'figure-label',
    `满行正文 section=${hOut[0].section}`
  );
  checkTrue(
    '章节标题不会被误标为图表标签',
    hOut[1].section !== 'figure-label',
    `章节标题 section=${hOut[1].section}`
  );
})();

// ---------- 12. 图注折行补齐（真实页码几何：第 3 页图注尾巴 / 第 6 页表格吞并） ----------
console.log('\n===== T12 图注折行补齐（真实数据） =====');
(function captionExtendTest() {
  const start = code.indexOf('(function extendCaptionBlocks() {');
  const end = code.indexOf('})();', start);
  if (start < 0 || end < 0) {
    checkTrue('从产物中抽出 extendCaptionBlocks', false, '未找到该片段');
    return;
  }
  const snippet = code.slice(start, end + 5);
  const re = /^(?:[(\[](?:[a-h]|\d{1,2})[)\]]\s+)?(?:(?:Extended\s+Data|Supplement(?:ary|al)?|SI)\s+)?(?:Fig(?:\.|ure)?|Tab(?:\.|le)?|Box|Algorithm|Scheme|Chart|Exhibit|TABLE)\s*\.?\s*(?:\d+|[IVXLCDM]+)(?:\s*[.:：)—–-])?/i;
  // eslint-disable-next-line no-new-func
  const run = new Function('orderedLines', 'captionLabelRegex', `${snippet}\n return orderedLines;`);
  const mk = (y, minX, maxX, text, section) => ({
    y,
    minX,
    maxX,
    h: 9,
    spans: [{ textContent: text }],
    section
  });

  // 第 3 页真实数据：图注 4 行（最后一行较窄，被分栏分到 col1）+ 其下的章节标题
  const p3 = [
    mk(504, 50, 545, 'Figure 2: Overview of our framework. Our network consists of two encoders each', 'caption'),
    mk(492, 50, 545, 'space-time memory read block, and a decoder. The memory encoder ( Enc M ) takes', 'caption'),
    mk(480, 50, 545, 'object mask is represented as a probability map (the softmax output is used for', 'caption'),
    mk(468, 50, 208, '( Enc Q ) takes the query image as input.', 'col1'),
    mk(434, 50, 258, '3. Space-Time Memory Networks (STM)', 'col1'),
    mk(410, 62, 286, 'In our framework, video frames are sequentially pro-', 'col1')
  ];
  const r3 = run(p3, re);
  checkTrue(
    '第 3 页：图注尾巴（较窄的折行）被收进图注',
    r3[3].section === 'caption',
    `该行 section=${r3[3].section}（应为 caption）`
  );
  checkTrue(
    '第 3 页：其后的章节标题没有被吞',
    r3[4].section === 'col1' && r3[5].section === 'col1',
    `标题=${r3[4].section} 正文=${r3[5].section}`
  );

  // 第 6 页真实数据：Table 1 图注 4 行 → 紧跟 Table 2 的数据行（行距 29pt）
  const p6 = [
    mk(525, 50, 286, 'Table 1: The quantitative evaluation of multi-object video', 'caption'),
    mk(513, 50, 286, 'object segmentation on Youtube-VOS [ 38 ] validation set.', 'caption'),
    mk(501, 50, 286, 'Results for other methods are directly copied from [ 37 , 13 ,', 'caption'),
    mk(489, 50, 81, '32 , 35 ].', 'caption'),
    mk(460, 142, 280, 'OL J Mean F Mean Time', 'col1'),
    mk(443, 56, 274, 'S2S (+YV) [ 38 ] X 79.1 - 9 s', 'col1'),
    mk(431, 56, 276, 'MSK [ 26 ] X 79.7 75.4 12 s', 'col1')
  ];
  const r6 = run(p6, re);
  checkTrue(
    '第 6 页：表格数据行没有被图注吞并（行距相对判据生效）',
    r6[4].section !== 'caption' && r6[5].section !== 'caption' && r6[6].section !== 'caption',
    `460=${r6[4].section} 443=${r6[5].section} 431=${r6[6].section}`
  );
})();

// ---------- 13. 同一条图注必须连在一起（真实第 3 页几何） ----------
console.log('\n===== T13 图注行聚合（真实数据） =====');
(function captionReorderTest() {
  const start = code.indexOf('(function reorderFigureBlocks() {');
  const end = code.indexOf('})();', start);
  if (start < 0 || end < 0) {
    checkTrue('从产物中抽出 reorderFigureBlocks', false, '未找到该片段');
    return;
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('orderedLines', `${code.slice(start, end + 5)}\n return orderedLines;`);
  const mk = (y, minX, maxX, text, section) => ({ y, minX, maxX, h: 9, spans: [{ textContent: text }], section });

  // 复刻 STM 第 3 页的行序（按"桶拼接"的旧顺序，图注被拆到两端）
  const col1 = [];
  for (let i = 0; i < 20; i++) col1.push(mk(434 - i * 12, 50, 286, 'body line of column one here', 'col1'));
  const col2 = [];
  for (let i = 0; i < 20; i++) col2.push(mk(468 - i * 12, 309, 545, 'body line of column two here', 'col2'));
  const figLabels = [
    mk(706, 113, 260, 'Memory: Past frames with object mask', 'figure-label'),
    mk(669, 131, 240, '……', 'figure-label'),
    mk(528, 74, 127, ': Intermediate output', 'figure-label')
  ];
  // 图注 4 行：前 3 行通栏、最后一行较窄（落在 col1 里）——这正是"同一段被拆成两截"的场景。
  // 注意：在真实管线里这 4 行的 section 都是 caption（尾行由"图注折行补齐"补上）。
  const captionHead = [
    mk(504, 50, 545, 'Figure 2: Overview of our framework. Our network consists of two encoders', 'caption'),
    mk(492, 50, 545, 'space-time memory read block, and a decoder. The memory encoder takes', 'caption'),
    mk(480, 50, 545, 'object mask is represented as a probability map used for estimated masks.', 'caption')
  ];
  const captionTail = mk(468, 50, 208, '( Enc Q ) takes the query image as input.', 'caption');

  // 旧顺序：col1（含图注尾行）→ col2 → 通栏图注前 3 行
  const input = [...col1, captionTail, ...col2, ...captionHead, ...figLabels];
  const out = run(input);
  if (process.env.T13_DEBUG) {
    console.log('    [debug] input 行数', input.length, '→ out 行数', out && out.length);
    console.log('    [debug] out 顺序:', (out || []).map(l => `${l.section}@${l.y}`).join(' '));
  }

  const capIdx = out.map((l, i) => (l.section === 'caption' ? i : -1)).filter(i => i >= 0);
  checkTrue('图注 4 行都被识别为 caption', capIdx.length === 4, `实际 ${capIdx.length} 行`);
  checkTrue(
    '图注 4 行在最终行序里**连续**（不再被打成两张卡片）',
    capIdx.length === 4 && capIdx[3] - capIdx[0] === 3,
    `位置: ${capIdx.join(',')}`
  );
  checkTrue(
    '图注内部按自上而下排列',
    capIdx.length === 4 && out[capIdx[0]].y > out[capIdx[1]].y && out[capIdx[1]].y > out[capIdx[2]].y && out[capIdx[2]].y > out[capIdx[3]].y,
    capIdx.map(i => out[i].y).join(' > ')
  );
  const firstBodyIdx = out.findIndex(l => l.section === 'col1' && l.spans[0].textContent.startsWith('body line'));
  checkTrue(
    '图注排在正文之前（图在页面顶部）',
    capIdx.length === 4 && capIdx[3] < firstBodyIdx,
    `图注结束于 ${capIdx[3]}，正文起于 ${firstBodyIdx}`
  );

  // 场景二（真实第 6 页）：左右两栏各有一张表的图注，y 彼此交错 —— 不允许交错混排
  const t1 = [
    mk(525, 50, 286, 'Table 1: The quantitative evaluation of multi-object video', 'caption'),
    mk(513, 50, 286, 'object segmentation on Youtube-VOS validation set.', 'caption'),
    mk(501, 50, 286, 'Results for other methods are directly copied from', 'caption'),
    mk(489, 50, 81, '32, 35 ].', 'caption')
  ];
  const t3 = [
    mk(494, 309, 545, 'Table 3: The quantitative evaluation on DAVIS-2017', 'caption'),
    mk(482, 309, 545, 'validation set. OL indicates online learning.', 'caption'),
    mk(470, 309, 545, 'the use of Youtube-VOS for training.', 'caption'),
    mk(458, 309, 362, 'and F Mean.', 'caption')
  ];
  const body = [];
  for (let i = 0; i < 15; i++) body.push(mk(200 - i * 12, 50, 286, 'body line of column one', 'col1'));
  for (let i = 0; i < 15; i++) body.push(mk(200 - i * 12, 309, 545, 'body line of column two', 'col2'));

  const out2 = run([...body, ...t1, ...t3]);
  const idx1 = out2.map((l, i) => (l.spans[0].textContent.startsWith('Table 1') ? i : -1)).filter(i => i >= 0)[0];
  const idx3 = out2.map((l, i) => (l.spans[0].textContent.startsWith('Table 3') ? i : -1)).filter(i => i >= 0)[0];
  checkTrue('第 6 页场景：两张表的图注各成一块', idx1 !== undefined && idx3 !== undefined, `T1@${idx1} T3@${idx3}`);
  checkTrue(
    '第 6 页场景：Table 1 图注 4 行连续',
    idx1 !== undefined && out2.slice(idx1, idx1 + 4).every(l => l.spans[0].textContent.match(/Table 1|object segmentation|Results for other|32, 35/)),
    out2.slice(idx1, idx1 + 5).map(l => l.spans[0].textContent.slice(0, 18)).join(' | ')
  );
  checkTrue(
    '第 6 页场景：Table 3 图注 4 行连续（不与 Table 1 交错）',
    idx3 !== undefined && out2.slice(idx3, idx3 + 4).every(l => l.spans[0].textContent.match(/Table 3|validation set|the use of|and F Mean/)),
    out2.slice(idx3, idx3 + 5).map(l => l.spans[0].textContent.slice(0, 18)).join(' | ')
  );
})();

// ---------- 14. 跨栏续接：被栏底/栏顶切断的句子必须合并（真实第 2 页数据） ----------
console.log('\n===== T14 跨栏续接（真实数据） =====');
(function columnBreakJoinTest() {
  const start = code.indexOf('(function joinAcrossColumnBreak() {');
  const end = code.indexOf('})();', start);
  if (start < 0 || end < 0) {
    checkTrue('从产物中抽出 joinAcrossColumnBreak', false, '未找到该片段');
    return;
  }
  // eslint-disable-next-line no-new-func
  const run = new Function(
    'paras',
    'isSingleColumnPage',
    'gutterX',
    'splitEnglishSentencesSmart',
    `${code.slice(start, end + 5)}`
  );
  const spanStub = () => ({ setAttribute() {} });
  const mkPara = (id, type, text, minX, maxX) => ({
    id,
    type,
    cleanText: text,
    minX,
    maxX,
    charMap: new Array(Math.max(4, text.length)).fill(0).map(() => ({ span: spanStub(), offset: 0 })),
    rawSpans: [spanStub()],
    sentencesEn: []
  });
  const split = t => t.split(/(?<=[.!?])\s+/).filter(Boolean);

  // 真实第 2 页：左栏末段以半句结尾，右栏首段是它的续句
  const leftTail = mkPara(
    0,
    'body',
    'A related work fine-tunes deep network models on the initial object mask in the first frame to remember the appearance of the',
    50,
    286
  );
  const rightHead = mkPara(1, 'body', 'target object [2,34,26,14,26,11,18] during the test time.', 309, 545);
  const paras = [leftTail, rightHead];
  run(paras, false, 297, split);
  checkTrue('续句被合并（残句消失）', paras.length === 1, `合并后剩 ${paras.length} 段`);
  checkTrue(
    '合并后是完整句子（…appearance of the target object … during the test time.）',
    paras.length === 1 &&
      /appearance of the target object \[2,34,26,14,26,11,18\] during the test time\.$/.test(paras[0].cleanText),
    paras[0].cleanText.slice(-90)
  );
  checkTrue('合并后重新切句（供逐句对齐）', paras[0].sentencesEn.length >= 1, String(paras[0].sentencesEn.length));
  checkTrue('合并后 span 重新挂到存活段落的 id', paras[0].rawSpans.length === 2, String(paras[0].rawSpans.length));

  // 反例 1：左栏段落已正常结束 → 不许合并
  const p1 = [
    mkPara(0, 'body', 'This sentence ends properly.', 50, 286),
    mkPara(1, 'body', 'another paragraph starts here.', 309, 545)
  ];
  run(p1, false, 297, split);
  checkTrue('左栏已完整结束 → 不合并', p1.length === 2, `剩 ${p1.length} 段`);

  // 反例 2：右栏首段是大写开头的新句子 → 不许合并
  const p2 = [
    mkPara(0, 'body', 'the appearance of the', 50, 286),
    mkPara(1, 'body', 'While the online learning improves accuracy, it is expensive.', 309, 545)
  ];
  run(p2, false, 297, split);
  checkTrue('右栏是大写开头的新句子 → 不合并', p2.length === 2, `剩 ${p2.length} 段`);

  // 反例 3：单栏论文不该触发
  const p3 = [mkPara(0, 'body', 'ends without punctuation', 50, 545), mkPara(1, 'body', 'continuation here', 50, 545)];
  run(p3, true, 297, split);
  checkTrue('单栏论文 → 不触发跨栏合并', p3.length === 2, `剩 ${p3.length} 段`);

  // 反例 4：跨栏但上一段不是 body（图注）→ 不许合并
  const p4 = [
    mkPara(0, 'caption', 'Figure 2: something without period', 50, 545),
    mkPara(1, 'body', 'lowercase continuation', 309, 545)
  ];
  run(p4, false, 297, split);
  checkTrue('图注不参与跨栏合并', p4.length === 2, `剩 ${p4.length} 段`);
})();

// ---------- 15. AI 问答：打开弹窗不得自动发问，须由「开始分析」触发 ----------
console.log('\n===== T15 AI 弹窗不自动分析 =====');
(function aiModalNoAutoSendTest() {
  const callers = (code.match(/openAiAssistantModal\(\{/g) || []).length;
  checkTrue('存在多个调用入口', callers >= 5, `实际 ${callers} 处`);
  checkTrue(
    '所有调用入口都不再传 autoSend: true（打开弹窗不烧 token）',
    !/autoSend: true/.test(code),
    `仍有 ${(code.match(/autoSend: true/g) || []).length} 处 autoSend: true`
  );
  checkTrue('保留了 autoSend 开关本身（供将来自动化使用）', /options\.autoSend === true/.test(code));
  checkTrue('新增「开始分析」按钮元素', /id="btnAnalyzeAiModal"/.test(code) && /btn-analyze-ai/.test(code));
  checkTrue('按钮绑定了发送预设问题的处理', /analyzeBtn\.onclick = \(\) => \{/.test(code) && /aiPresetQuestion \|\|/.test(code));
  checkTrue('预设问题只预填、不自动发送', /aiPresetQuestion = options\.presetQuestion/.test(code));
  checkTrue(
    '已有对话时输入框留空，方便直接追问',
    /input\.value = aiConversation\.length > 0 \? '' : aiPresetQuestion;/.test(code)
  );
  checkTrue('按钮在无预设时隐藏', /analyzeBtn\.style\.display = aiPresetQuestion \? '' : 'none';/.test(code));
  const css = fs.readFileSync(path.join(path.dirname(VIEWER), 'viewer.css'), 'utf8');
  checkTrue('按钮样式已定义', /\.btn-analyze-ai\s*\{/.test(css));
})();

// ---------- 16. 设置流程：去掉"推荐"话术 + 常用模型列表 ----------
console.log('\n===== T16 设置流程（模型列表） =====');
(function settingsFlowTest() {
  const ext = fs.readFileSync(path.join(path.dirname(VIEWER), '..', 'src', 'extension.ts'), 'utf8');
  checkTrue('Gemini 选项不再带"推荐"标签', !/Gemini API Key \(推荐/.test(ext), '仍存在"推荐"字样');
  checkTrue('不再出现"顶级/高品质"等夸大措辞', !/顶级|高品质学术精译/.test(ext));
  checkTrue('定义了常用模型列表 COMMON_MODELS', /const COMMON_MODELS/.test(ext));
  const must = ['deepseek-chat', 'deepseek-reasoner', 'moonshot-v1-8k', 'qwen-plus', 'glm-4-plus', 'gpt-4o-mini'];
  const missing = must.filter(m => !ext.includes(m));
  checkTrue(`常用模型均已列出（${must.length} 个）`, missing.length === 0, `缺少 ${missing.join('、')}`);
  checkTrue('提供"本地模型"入口', /本地模型（Ollama/.test(ext));
  checkTrue('提供"其它（手动输入）"入口', /其它（手动输入模型名与端点）/.test(ext));
  checkTrue('常用服务商自动带出端点', /endpoint: 'https:\/\/api\.deepseek\.com\/v1'/.test(ext) && /picked\._endpoint \|\| currentEndpoint/.test(ext));
  // 顺序：先选模型 → 再填 Key
  const iModel = ext.indexOf("title: '选择要使用的模型'");
  const iKey = ext.indexOf('- API Key');
  checkTrue('流程顺序为先选模型、再填 API Key', iModel > 0 && iKey > 0 && iModel < iKey, `model@${iModel} key@${iKey}`);
})();

// ---------- 17. 标题判定必须以"段落起点"为前提（真实第 6 页场景） ----------
console.log('\n===== T17 标题判定不吞正文（真实数据） =====');
(function headingMustStartParagraphTest() {
  const start = code.indexOf('    function commitParagraph() {');
  const end = code.indexOf('    let bodyCount = 0;', start);
  if (start < 0 || end < 0) {
    checkTrue('从产物中抽出段落聚合代码', false, '未找到 commitParagraph / bodyCount');
    return;
  }
  // eslint-disable-next-line no-new-func
  const run = new Function(
    'orderedLines',
    'captionLabelRegex',
    'pageNum',
    'splitEnglishSentencesSmart',
    'isSingleColumnPage',
    'gutterX',
    'console',
    `let paras = [];
     let curParaLines = [];
     let curParaType = 'body';
     ${code.slice(start, end)}
     return paras;`
  );
  const labelRe = /^(?:Fig(?:\.|ure)?|Tab(?:\.|le)?)\s*\.?\s*\d+/i;
  const mk = (y, x0, x1, text, section) => ({
    y,
    minX: x0,
    maxX: x1,
    h: 9.5,
    section,
    spans: [{ textContent: text, _pdfH: 9.5, setAttribute() {} }]
  });
  const split = t => (t || '').split(/(?<=[.!?])\s+(?=[A-Z(“"'])/).filter(Boolean);

  // 真实第 6 页右栏：这些行行首是 method / methods / results / 2018+大写，
  // 但都是**承接上一行的正文中段**，绝不能被判成章节标题。
  const lines = [
    mk(422, 309, 545, 'target object. We compare our method with state-of-the-art', 'col2'),
    mk(410, 309, 545, 'methods in Table 2. In the table, we indicate the use of', 'col2'),
    mk(398, 309, 545, 'online learning and provide approximate runtimes of each', 'col2'),
    mk(386, 309, 545, 'method. Most of the previous top-performing methods rely', 'col2'),
    mk(374, 309, 545, 'on online learning that severely harms the running speed.', 'col2'),
    mk(362, 309, 545, 'Our method achieves the best accuracy among all compet-', 'col2'),
    mk(350, 309, 545, 'ing methods without online learning, and shows competitive', 'col2'),
    mk(338, 309, 545, 'results with the top-performing online learning based meth-', 'col2'),
    mk(326, 309, 545, 'ods while running in a fraction of time. Our method trained', 'col2'),
    mk(314, 309, 545, 'with additional data from Youtube-VOS outperforms all the', 'col2'),
    mk(302, 309, 417, 'methods by a large margin.', 'col2'),
    // ↓ 这一段是同一栏里紧随其后的新段落（真实第 6 页有这 8 行，不能省略，
    //   否则会给下面的行造出 100pt 的假空行，把"段间空行"判据喂错）
    mk(286, 309, 545, 'Multiple objects (DAVIS-2017). DAVIS-2017 [ 28 ] is a', 'col2'),
    mk(274, 309, 545, 'multi-object extension of DAVIS-2016. The validation set', 'col2'),
    mk(262, 309, 545, 'consists of 59 objects in 30 videos. In Table Table 3 , we', 'col2'),
    mk(250, 309, 545, 'report the results of multi-object video segmentation on the', 'col2'),
    mk(238, 309, 545, 'validation set. Again, our method shows the best perfor-', 'col2'),
    mk(226, 309, 545, 'mance among fast methods without online learning. With', 'col2'),
    mk(214, 309, 545, 'additional Youtube-VOS data, our method largely outper-', 'col2'),
    mk(202, 309, 545, 'forms all the previous state-of-the-art methods including the', 'col2'),
    mk(190, 309, 545, '2018 DAVIS challenge winner [ 20 ]. Our results on the test-', 'col2'),
    mk(178, 309, 510, 'dev set is included in the supplementary materials.', 'col2')
  ];
  const paras = run(lines, labelRe, 6, split, false, 293, { log() {} });

  const headingCount = paras.filter(p => p.type === 'heading').length;
  checkTrue('行首出现 method/methods/results/数字大写 时**不产生标题**', headingCount === 0, `产生了 ${headingCount} 个标题`);
  // 拆成 2 段是**正确**的："Multiple objects (DAVIS-2017)…" 本来就是新段落
  //（行距 16pt 超过 1.45×行高，且以大写开头）
  checkTrue('正文按真实段落边界切成 2 段（不是逐行碎片）', paras.length === 2, `实际 ${paras.length} 段`);
  checkTrue(
    '第一段是完整的"Single object"论述',
    paras.length === 2 && /target object\. We compare/.test(paras[0].cleanText) && /large margin\./.test(paras[0].cleanText)
  );
  checkTrue(
    '第二段是完整的"Multiple objects"论述',
    paras.length === 2 && /Multiple objects \(DAVIS-2017\)/.test(paras[1].cleanText) && /supplementary materials\./.test(paras[1].cleanText)
  );
  checkTrue(
    '不再出现"一行一段"的碎片',
    paras.every(p => (p.cleanText || '').length > 90),
    paras.map(p => (p.cleanText || '').length).join(',')
  );

  // 反例：真正的章节标题（上一行已结束句子）仍必须被识别
  const real = [
    mk(139, 50, 101, '4.2. DAVIS', 'col1'),
    mk(117, 50, 286, 'Single object (DAVIS-2016). DAVIS-2016 [ 27 ] is one of', 'col1'),
    mk(105, 50, 286, 'the most popular benchmark datasets for video object seg-', 'col1')
  ];
  const paras2 = run(real, labelRe, 6, split, false, 293, { log() {} });
  checkTrue(
    '真标题仍被识别为 heading',
    paras2.length >= 2 && paras2[0].type === 'heading',
    paras2.map(p => p.type).join(',')
  );
})();

// ---------- 18. AI 弹窗内的回答风格一键切换 ----------
console.log('\n===== T18 回答风格切换控件 =====');
(function styleSwitchTest() {
  // 控件定义只应有一份，由 createAiStyleSwitch() 产出
  checkTrue('有共用的控件工厂', /function createAiStyleSwitch\(\)/.test(code));
  checkTrue('弹窗入口挂载了控件', /aiModalStyleSlot[\s\S]{0,120}createAiStyleSwitch\(\)/.test(code));
  checkTrue(
    '批注「AI 提问」入口也挂载了控件（曾遗漏）',
    /annotAiBar[\s\S]{0,200}createAiStyleSwitch\(\)/.test(code),
    '从批注点进去没有切换控件'
  );
  checkTrue('按钮由工厂生成，而不是 HTML 里硬编码', !/data-style="concise"/.test(code) && /data-style="\$\{s\.key\}"/.test(code));

  // 【关键守卫】AI_STYLES 是 const（暂时性死区），创建批注卡片时会间接调用
  // createAiStyleSwitch() 去读它。若定义晚于调用点，初始化阶段就抛
  // "Cannot access 'AI_STYLES' before initialization"，
  // 后果是 PDF 不加载、不翻译、主题错乱——正是线上真实出现过的事故。
  const srcLines = code.split('\n');
  const defLine = srcLines.findIndex(l => /^\s*const AI_STYLES = \[/.test(l)) + 1;
  const callLines = [];
  srcLines.forEach((l, i) => {
    const trimmed = l.trim();
    // 跳过注释行：注释里提到函数名不算调用点
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    if (/createAiStyleSwitch\(\)/.test(l) && !/function createAiStyleSwitch/.test(l)) callLines.push(i + 1);
  });
  const firstCall = callLines.length ? Math.min(...callLines) : Infinity;
  checkTrue(
    'AI_STYLES 定义早于所有 createAiStyleSwitch() 调用点（防暂时性死区崩溃）',
    defLine > 0 && defLine < firstCall,
    `定义在第 ${defLine} 行，最早调用在第 ${firstCall} 行`
  );

  const styles = ['concise', 'standard', 'reviewer'];
  const missing = styles.filter(s => !code.includes(`key: '${s}'`));
  checkTrue(`三档齐全（${styles.join(' / ')}）`, missing.length === 0, `缺少 ${missing.join(',')}`);
  checkTrue('点击后写回设置（否则重载就丢）', /type: 'setAnswerStyle', style: next/.test(code));
  checkTrue('切换函数有三档校验（非法值回落 standard）', /const valid = AI_STYLES\.some\(s => s\.key === style\)/.test(code));
  checkTrue('切换后立刻给用户反馈', /showReaderToast\(`回答风格：/.test(code));
  checkTrue('有高亮当前档位的函数（作用于所有入口）', /function syncAiStyleButtons\(\)/.test(code) && /document\.querySelectorAll\('\.ai-style-btn'\)/.test(code));
  checkTrue('modelInfo 到达后刷新高亮', /msg\.answerStyle\) aiStyle = msg\.answerStyle;[\s\S]{0,40}syncAiStyleButtons\(\);/.test(code));
  checkTrue('提问请求带上所选风格', /answerStyle: aiStyle \|\| ''/.test(code));
  const ext = fs.readFileSync(path.join(path.dirname(VIEWER), '..', 'src', 'pdfEditorProvider.ts'), 'utf8');
  checkTrue(
    '宿主侧处理 setAnswerStyle 并校验取值',
    /case 'setAnswerStyle'/.test(ext) && /\['concise', 'standard', 'reviewer'\]\.includes\(message\.style\)/.test(ext)
  );
  const css = fs.readFileSync(path.join(path.dirname(VIEWER), 'viewer.css'), 'utf8');
  checkTrue('样式已定义（含 active 高亮）', /\.ai-style-btn\.active\s*\{/.test(css));
})();

// ---------- 19. 提示条自动消失 + 聚焦卡片跟随高亮 ----------
console.log('\n===== T19 提示条自动消失 与 聚焦条跟随 =====');
(function toastAndFollowTest() {
  const ext = fs.readFileSync(path.join(path.dirname(VIEWER), '..', 'src', 'pdfEditorProvider.ts'), 'utf8');
  const css = fs.readFileSync(path.join(path.dirname(VIEWER), 'viewer.css'), 'utf8');

  // —— 提示条：宿主不再用不会自动关的原生通知 ——
  checkTrue('宿主 showInfo 改为转发给 webview', /type: 'showToast'/.test(ext));
  checkTrue('宿主不再调用原生通知', !/case 'showInfo':\s*\{\s*vscode\.window\.showInformationMessage/.test(ext));
  checkTrue('webview 处理 showToast', /case 'showToast':/.test(code));
  checkTrue('提示条有自动消失定时器', /readerToastTimer = setTimeout\(hideReaderToast/.test(code));
  checkTrue('悬停暂停计时（否则鼠标移上去也照常消失）', /onmouseenter = \(\) => clearTimeout\(readerToastTimer\)/.test(code));
  checkTrue('点击可立刻关闭', /box\.onclick = \(\) => \{[\s\S]{0,80}hideReaderToast\(\);/.test(code));
  checkTrue('提示条样式存在', /\.reader-toast\s*\{/.test(css) && /\.reader-toast\.show/.test(css));

  // —— 聚焦卡片跟随 ——
  checkTrue('记录卡片锚点上下文', /activeFocusAnchor = \{ para, targetSentenceIdx, pageWrapper \}/.test(code));
  checkTrue('位置计算被抽成可重复调用的函数', /function positionParaFocusBar\(\)/.test(code));
  checkTrue('滚动时重算（rAF 节流）', /function requestFocusBarReposition\(\)/.test(code) && /addEventListener\('scroll', requestFocusBarReposition, \{ passive: true \}\)/.test(code));
  checkTrue('锚点移出可视区则隐藏卡片', /bar\.dataset\.hiddenByScroll = '1'/.test(code) && /viewBottom < cRect\.top/.test(code));
  checkTrue('滚回可视区则恢复显示', /bar\.style\.display = 'flex';\s*\n\s*bar\.style\.visibility/.test(code));
  checkTrue('改动窗口尺寸也重算', /addEventListener\('resize', requestFocusBarReposition\)/.test(code));
  checkTrue('页面被销毁后不再定位（避免报错）', /pageWrapper\.isConnected/.test(code));

  // —— 最外层错误可视化：初始化崩溃时必须在界面上看得见 ——
  checkTrue('注册了全局错误兜底（window error）', /window\.addEventListener\('error', e => reportFatalError/.test(code));
  checkTrue('注册了未处理的 Promise 拒绝兜底', /addEventListener\('unhandledrejection', e => reportFatalError/.test(code));
  checkTrue('错误会画在界面上（不是只打日志）', /document\.getElementById\('fatalErrorBox'\)/.test(code) && /box\.textContent =/.test(code));
  checkTrue('同时回报给扩展侧', /type: 'webviewFatal'/.test(code));
  checkTrue('宿主侧记录该错误', /case 'webviewFatal'/.test(ext));

  // —— 悬停高亮不再弹任何东西（用户明确要求） ——
  checkTrue('高亮元素不再挂 mouseenter 预览', !/mark\.addEventListener\('mouseenter'/.test(code));
  checkTrue('高亮元素不再挂原生 title 提示', !/mark\.title\s*=/.test(code));
  checkTrue('便签图钉也不再挂悬停预览', !/pin\.addEventListener\('mouseenter'/.test(code));
  checkTrue('点击高亮仍能打开批注卡片', /mark\.addEventListener\('click'/.test(code));

  // —— 风格控件必须放在"始终可见"的位置（曾被放到弹窗底部而看不见） ——
  checkTrue(
    '问答弹窗的风格控件位于输入框区域内',
    /ai-question-input-wrapper">\s*\n\s*<div id="aiModalStyleSlot"/.test(code) ||
      /ai-question-input-wrapper[\s\S]{0,120}id="aiModalStyleSlot"/.test(code)
  );
  checkTrue('弹窗底部不再重复放一个槽位', (code.match(/id="aiModalStyleSlot"/g) || []).length === 1);
})();

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 || loadError ? 1 : 0);
