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
    collectFocusMath,
    extractMathSymbols,
    buildMathIndex,
    invalidateMathIndex,
    setVisionStructure: v => {
      paperData.visionStructure = v || {};
      invalidateMathIndex();
    },
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

// 逐符号表：解释公式时模型最常用的格式（真实回答 AOT #17 整段都是这种表）
const mdTable = T.renderMarkdownToHtml(
  '| 符号 | 含义 |\n|---|---|\n| `AttLT` | 长期注意力，跨多帧匹配 |\n| $X^l$ | 第 $l$ 层特征图 |\n'
);
checkTrue(
  'GFM 表格渲染为 table（不再是一堆竖线）',
  /<table class="md-table">/.test(mdTable) && /<thead>/.test(mdTable) && /<tbody>/.test(mdTable),
  mdTable
);
checkTrue('表头两格 + 表体两行', (mdTable.match(/<th>/g) || []).length === 2 && (mdTable.match(/<tr>/g) || []).length === 3, mdTable);
checkTrue('表体单元里的 $...$ 照常渲染', /md-math/.test(mdTable), mdTable);
checkTrue('表体不再出现字面竖线', !/\|/.test(mdTable), mdTable);
const mdTableShort = T.renderMarkdownToHtml('| a | b | c |\n|---|---|---|\n| 1 |\n');
checkTrue(
  '缺格子的表格行按表头列数补齐（布局不塌）',
  (mdTableShort.match(/<td>/g) || []).length === 3 && /<td>1<\/td><td><\/td><td><\/td>/.test(mdTableShort),
  mdTableShort
);
const mdPipe = T.renderMarkdownToHtml('| 这不是表格，因为没有分隔行\n');
checkTrue('没有分隔行的竖线行不当表格', !/<table/.test(mdPipe), mdPipe);
const mdEscape = T.renderMarkdownToHtml('| a | b |\n|---|---|\n| x \\| y | z |\n');
checkTrue('单元里的 \\| 是字面竖线', /x \| y/.test(mdEscape) && !/<td>x <\/td>/.test(mdEscape), mdEscape);

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
  // gutterX / isSingleColumnPage / GUTTER_CLEARANCE 在源码里定义在 reorderFigureBlocks **之前**，
  // 抽片段时不会带进来 → 必须当参数传进去，否则函数里引用它们会直接 ReferenceError。
  const run = new Function(
    'orderedLines',
    'gutterX',
    'isSingleColumnPage',
    'GUTTER_CLEARANCE',
    `${code.slice(start, end + 5)}\n return orderedLines;`
  );
  const GUTTER = 297;
  const runP2 = lines => run(lines, GUTTER, false, 15);
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
  const out = runP2(input);
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

  const out2 = runP2([...body, ...t1, ...t3]);
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

  // 场景三：**真实第 6 页整页 97 行**（由 scratch/order_probe.js 6 导出，含真实坐标与文本）。
  // 这是用户反馈"有时候这个段的顺序是乱的"的那一页，也是旧实现的错法：
  //   ① colTop 取"两栏里最高的一行"（这里是右栏 y=708），左栏正文顶边 y=139 完全够不着；
  //   ② 拿块的底边比正文顶边 → 高的块（Table 2，y 460→247）反倒被判成"在正文之下"；
  //   ③ 块不分栏 → 右栏 Table 3 被提到正文之前。
  // 旧输出：表1行 → 表1注 → 表3注 → 标题 → 正文 → 表2行 → 表2注（表1/表3 的数据行还被并成一段）。
  // 期望：表1 → 表2 → 左栏正文 → 表3 → 右栏正文。
  const P6_RAW = `
708.0|187|270|figure-label|Seen Unseen
691.3|131|273|figure-label|Overall J F J F
674.3|58|279|figure-label|OSMN [ 40 ] 51.2 60.0 60.1 40.6 44.0
662.4|58|279|figure-label|MSK [ 26 ] 53.1 59.9 59.5 45.0 47.9
650.4|58|272|figure-label|RGMP [ 24 ] 53.8 59.5 - 45.2 -
638.5|58|279|figure-label|OnAVOS [ 34 ] 55.2 60.1 62.7 46.6 51.4
626.5|58|279|figure-label|RVOS [ 32 ] 56.8 63.6 67.2 45.5 51.0
614.6|58|279|figure-label|OSVOS [ 2 ] 58.8 59.8 60.5 54.2 60.7
602.6|58|279|figure-label|S2S [ 38 ] 64.4 71.0 70.0 55.5 61.2
590.6|58|272|figure-label|A-GAME [ 13 ] 66.1 67.8 - 60.8 -
578.7|58|279|figure-label|PreMVOS [ 20 ] 66.9 71.4 75.9 56.5 63.7
566.7|58|272|figure-label|BoLTVOS [ 35 ] 71.1 71.6 - 64.3 -
549.8|58|279|figure-label|Ours 79.4 79.7 84.2 72.8 80.9
525.3|50|286|caption|Table 1: The quantitative evaluation of multi-object video
513.4|50|286|caption|object segmentation on Youtube-VOS [ 38 ] validation set.
501.4|50|286|caption|Results for other methods are directly copied from [ 37 , 13 ,
489.5|50|81|caption|32 , 35 ].
459.8|142|280|figure-label|OL J Mean F Mean Time
442.9|56|274|figure-label|S2S (+YV) [ 38 ] X 79.1 - 9 s
430.9|56|276|figure-label|MSK [ 26 ] X 79.7 75.4 12 s
419.0|56|274|figure-label|OSVOS [ 2 ] X 79.8 80.6 9 s
407.0|56|271|figure-label|MaskRNN [ 11 ] X 80.7 80.9 -
395.1|56|280|figure-label|VideoMatch [ 12 ] 81.0 - 0.32 s
383.1|56|280|figure-label|FEELVOS (+YV) [ 33 ] 81.1 82.2 0.45 s
371.1|56|280|figure-label|RGMP [ 24 ] 81.5 82.0 0.13 s
359.2|56|280|figure-label|A-GAME (+YV) [ 13 ] 82.0 82.2 0.07 s
347.2|56|278|figure-label|FAVOS [ 4 ] 82.4 79.5 1.8 s
335.3|56|271|figure-label|LSE [ 6 ] X 82.9 80.3 -
323.3|56|280|figure-label|CINN [ 1 ] X 83.4 85.0 > 30 s
311.4|56|280|figure-label|PReMVOS [ 20 ] X 84.9 88.6 > 30 s
303.0|88|93|figure-label|S
299.4|56|278|figure-label|OSVOS [ 21 ] X 85.6 86.4 4.5 s
287.4|56|276|figure-label|OnAVOS [ 34 ] X 86.1 84.9 13 s
275.5|56|280|figure-label|DyeNet [ 18 ] X 86.2 - 2.32 s
258.5|56|280|figure-label|Ours 84.8 88.1 0.16 s
246.6|56|280|figure-label|Ours (+YV) 88.7 89.9 0.16 s
222.2|50|286|caption|Table 2: The quantitative evaluation on DAVIS-2016 valida-
210.2|50|286|caption|tion set. OL indicates online learning. (+YV) indicates the
198.2|50|286|caption|use of Youtube-VOS for training. Methods with J Mean
186.3|50|286|caption|below 79 are omitted due to the space limit and the com-
174.3|50|262|caption|plete table is available in the supplementary material.
138.7|50|101|col1|4.2. DAVIS
116.9|50|286|col1|Single object (DAVIS-2016). DAVIS-2016 [ 27 ] is one of
104.9|50|286|col1|the most popular benchmark datasets for video object seg-
93.0|50|286|col1|mentation tasks. We use the validation set that contains 20
81.0|50|286|col1|videos annotated with high-quality masks each for a single
708.0|426|530|figure-label|OL J Mean F Mean
691.1|324|522|figure-label|OSMN [ 40 ] 52.5 57.1
679.1|324|522|figure-label|FAVOS [ 4 ] 54.6 61.8
667.2|324|522|figure-label|VidMatch [ 12 ] 56.5 68.2
655.2|324|522|figure-label|OSVOS [ 2 ] X 56.6 63.9
643.3|324|515|figure-label|MaskRNN [ 11 ] X 60.5 -
631.3|324|522|figure-label|OnAVOS [ 34 ] X 64.5 71.2
623.0|356|361|figure-label|S
619.3|324|522|figure-label|OSVOS [ 2 ] X 64.7 71.3
607.4|324|522|figure-label|RGMP [ 24 ] 64.8 68.6
595.4|324|522|figure-label|CINN [ 1 ] X 67.2 74.2
583.5|324|522|figure-label|A-GAME (+YV) [ 13 ] 67.2 72.7
571.5|324|522|figure-label|FEELVOS (+YV) [ 33 ] 69.1 74.0
559.6|324|479|figure-label|DyeNet [ 18 ] X *74.1
547.6|324|522|figure-label|PReMVOS [ 20 ] X 73.9 81.7
530.7|324|522|figure-label|Ours 69.2 74.0
518.7|324|522|figure-label|Ours (+YV) 79.2 84.3
494.3|309|545|caption|Table 3: The quantitative evaluation on DAVIS-2017 val-
482.3|309|545|caption|idation set. OL indicates online learning. (+YV) indicates
470.4|309|545|caption|the use of Youtube-VOS for training. *: average of J Mean
458.4|309|362|caption|and F Mean.
421.8|309|545|col2|target object. We compare our method with state-of-the-art
409.8|309|545|col2|methods in Table 2 . In the table, we indicate the use of
397.8|309|545|col2|online learning and provide approximate runtimes of each
385.9|309|545|col2|method. Most of the previous top-performing methods rely
373.9|309|545|col2|on online learning that severely harms the running speed.
362.0|309|545|col2|Our method achieves the best accuracy among all compet-
350.0|309|545|col2|ing methods without online learning, and shows competitive
338.1|309|545|col2|results with the top-performing online learning based meth-
326.1|309|545|col2|ods while running in a fraction of time. Our method trained
314.2|309|545|col2|with additional data from Youtube-VOS outperforms all the
302.2|309|417|col2|methods by a large margin.
285.8|309|545|col2|Multiple objects (DAVIS-2017). DAVIS-2017 [ 28 ] is a
273.9|309|545|col2|multi-object extension of DAVIS-2016. The validation set
261.9|309|545|col2|consists of 59 objects in 30 videos. In Table Table 3 , we
250.0|309|545|col2|report the results of multi-object video segmentation on the
238.0|309|545|col2|validation set. Again, our method shows the best perfor-
226.0|309|545|mance among fast methods without online learning. With
214.1|309|545|col2|additional Youtube-VOS data, our method largely outper-
202.1|309|545|col2|forms all the previous state-of-the-art methods including the
190.2|309|545|col2|2018 DAVIS challenge winner [ 20 ]. Our results on the test-
178.2|309|510|col2|dev set is included in the supplementary materials.
164.7|321|545|col2|The large performance leap by using additional training
152.7|309|545|col2|data indicates that DAVIS is too small to train a general-
140.8|309|545|col2|izable deep network due to over-fitting. It also explains
128.8|309|545|col2|why top performing online learning methods on the DAVIS
116.9|309|545|col2|benchmark do not show good performance on the large-
104.9|309|545|col2|scale Youtube-VOS benchmark. Online learning methods
93.0|309|545|col2|are hardly aided by large training data. Those methods usu-
81.0|309|545|col2|ally require an extensive parameter search ( e.g . data syn-
35.0|297|315|col2|9231`;
  // 真实分栏线是 293.3（单元测试里显式传进去，避免依赖源码里的 detectColumnStructure）
  const p6Lines = P6_RAW.trim()
    .split('\n')
    .map(row => {
      const [y, minX, maxX, section, ...text] = row.split('|');
      return mk(Number(y), Number(minX), Number(maxX), text.join('|'), section);
    });
  const out3 = run(p6Lines, 293.3, false, 15);
  const exact = t => out3.findIndex(l => l.spans[0].textContent === t);
  const [iT1row, iT1cap] = [exact('Seen Unseen'), exact('Table 1: The quantitative evaluation of multi-object video')];
  const [iT2row, iT2cap] = [exact('OL J Mean F Mean Time'), exact('Table 2: The quantitative evaluation on DAVIS-2016 valida-')];
  const [iT3row, iT3cap] = [exact('OL J Mean F Mean'), exact('Table 3: The quantitative evaluation on DAVIS-2017 val-')];
  const iBody1 = exact('4.2. DAVIS');
  const iBody2 = exact('target object. We compare our method with state-of-the-art');
  checkTrue(
    '第 6 页整页：阅读顺序为 表1 → 表2 → 左栏正文 → 表3 → 右栏正文',
    iT1row >= 0 &&
      iT1row < iT1cap &&
      iT1cap < iT2row &&
      iT2row < iT2cap &&
      iT2cap < iBody1 &&
      iBody1 < iT3row &&
      iT3row < iT3cap &&
      iT3cap < iBody2,
    `表1行@${iT1row} 表1注@${iT1cap} 表2行@${iT2row} 表2注@${iT2cap} 左正文@${iBody1} 表3行@${iT3row} 表3注@${iT3cap} 右正文@${iBody2}`
  );
  checkTrue(
    '第 6 页整页：表1 的 13 行数据紧接 4 行图注（中间不夹别的行）',
    iT1cap - iT1row === 13 &&
      out3.slice(iT1row, iT1cap).every(l => l.section === 'figure-label') &&
      out3.slice(iT1cap, iT1cap + 4).every(l => l.section === 'caption'),
    `${iT1row}..${iT1cap} = ${out3
      .slice(iT1row, iT1cap + 4)
      .map(l => l.section)
      .join(',')}`
  );
  checkTrue(
    '第 6 页整页：表2 的 19 行数据紧接 5 行图注',
    iT2cap - iT2row === 19 &&
      out3.slice(iT2row, iT2cap).every(l => l.section === 'figure-label') &&
      out3.slice(iT2cap, iT2cap + 5).every(l => l.section === 'caption'),
    `${iT2row}..${iT2cap}`
  );
  checkTrue(
    '第 6 页整页：表3 的 17 行数据紧接 4 行图注，且排在左栏正文之后',
    iT3cap - iT3row === 17 &&
      out3.slice(iT3row, iT3cap).every(l => l.section === 'figure-label') &&
      out3.slice(iT3cap, iT3cap + 4).every(l => l.section === 'caption') &&
      iT3row > iBody1,
    `${iT3row}..${iT3cap}（左栏正文在 ${iBody1}）`
  );
  checkTrue(
    '第 6 页整页：左栏正文之后不会又冒出左栏行（栏序不倒挂）',
    out3.slice(iBody1 + 5).every(l => l.section !== 'col1'),
    out3
      .slice(iBody1 + 5)
      .map(l => l.section)
      .filter((s, i, a) => s === 'col1' && a.indexOf(s) === i)
      .join(',') || '（无）'
  );
  checkTrue(
    '第 6 页整页：表1 与表3 的数据行没有被并成一段（一个在左栏、一个在右栏）',
    iT3row - iT1cap > 1,
    `表1注@${iT1cap} 表3行@${iT3row}`
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

  // 真实第 6 页：8.6 改成"图表块按栏内联"之后，Table 3 的数据行与图注会**插在**
  // 左栏尾段（"…masks each for a single"）和右栏首段（"target object. We compare…"）之间。
  // 旧实现只比较相邻两段 → 这条跨栏句被图表切断，两半各自翻译成读不懂的残句。
  const p5 = [
    mkPara(0, 'body', 'videos annotated with high-quality masks each for a single', 50, 286),
    mkPara(1, 'figure-label', 'OL J Mean F Mean OSMN [ 40 ] 52.5 57.1', 324, 522),
    mkPara(2, 'caption', 'Table 3: The quantitative evaluation on DAVIS-2017 validation set.', 309, 545),
    mkPara(3, 'body', 'target object. We compare our method with state-of-the-art methods.', 309, 545)
  ];
  run(p5, false, 293, split);
  // 合并会把右栏那一段并进左栏尾段（剩下 3 段：合并后的正文 + 被跳过的图表两段）
  checkTrue('跨栏续句可以跳过中间的图表段落（右栏那段被并走）', p5.length === 3, `剩 ${p5.length} 段`);
  checkTrue(
    '跨栏续句合并后仍是完整句（…each for a single target object. We compare…）',
    p5.length === 3 && /each for a single target object\. We compare our method/.test(p5[0].cleanText),
    p5[0] ? p5[0].cleanText.slice(-80) : '(无)'
  );
  checkTrue(
    '被跳过的图表段落仍在（顺序不乱、不丢内容）',
    p5.length === 3 && p5[1].type === 'figure-label' && p5[2].type === 'caption',
    p5.map(p => p.type).join(',')
  );

  // 反例 5：中间的段落是**正文**（不是图表）→ 绝不许跳过去粘两段正文
  const p6 = [
    mkPara(0, 'body', 'this paragraph stops in the middle of', 50, 286),
    mkPara(1, 'body', 'a totally unrelated paragraph that happens to be here.', 50, 286),
    mkPara(2, 'body', 'lowercase continuation of the first one', 309, 545)
  ];
  run(p6, false, 293, split);
  checkTrue('中间隔着正文 → 不跨段合并', p6.length === 3, `剩 ${p6.length} 段`);
})();

// ---------- 15. AI 问答：打开弹窗不得自动发问；发送按钮只能有一个 ----------
console.log('\n===== T15 AI 弹窗不自动分析 / 按钮不重复 =====');
(function aiModalNoAutoSendTest() {
  const callers = (code.match(/openAiAssistantModal\(\{/g) || []).length;
  checkTrue('存在多个调用入口', callers >= 5, `实际 ${callers} 处`);
  checkTrue(
    '所有调用入口都不再传 autoSend: true（打开弹窗不烧 token）',
    !/autoSend: true/.test(code),
    `仍有 ${(code.match(/autoSend: true/g) || []).length} 处 autoSend: true`
  );
  checkTrue('保留了 autoSend 开关本身（供将来自动化使用）', /options\.autoSend === true/.test(code));
  checkTrue('预设问题只预填、不自动发送', /aiPresetQuestion = options\.presetQuestion/.test(code));
  checkTrue(
    '已有对话时输入框留空，方便直接追问',
    /input\.value = aiConversation\.length > 0 \? '' : aiPresetQuestion;/.test(code)
  );

  // 「开始分析」按钮与「发送」功能重叠（预设问题本来就预填进输入框），且会无视用户编辑 →
  // 0.5.18 起移除，预设问题改成快捷提问芯片。这里把"不许再加回来"钉住。
  checkTrue(
    '不再生成「开始分析」按钮（与「发送」重复）',
    !/id="btnAnalyzeAiModal"[^>]*class="btn-analyze-ai"/.test(code) && !/analyzeBtn\.onclick/.test(code)
  );
  checkTrue('旧版遗留的该按钮会被主动清掉（老 webview 缓存也不会残留）', /querySelector\('#btnAnalyzeAiModal'\)/.test(code) && /legacyAnalyzeBtn\.remove\(\)/.test(code));
  checkTrue(
    '预设分析问题改为快捷提问芯片',
    /function renderPresetChip\(/.test(code) && /ai-chip-preset/.test(code) && /renderPresetChip\(/.test(code)
  );
  checkTrue('芯片点击会把预设问题填进输入框再发送', /input\.value = question;[\s\S]{0,80}sendAiModalQuestion\(question\)/.test(code));
  checkTrue('无预设时芯片会被移除', /if \(!question\) \{[\s\S]{0,80}chip\.remove\(\)/.test(code));
  const css = fs.readFileSync(path.join(path.dirname(VIEWER), 'viewer.css'), 'utf8');
  checkTrue('快捷芯片样式已定义', /\.ai-chip\s*\{/.test(css));
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
    /*
     * commitParagraph 现在依赖数学层（每个 span 要知道自己是不是公式）。
     * 这里按真实语义注入桩：textContent.items 为空 → 没有 pdf.js item → 全部按正文处理，
     * 于是这段测试测的仍是"标题判定"本身，不会因为数学层而失真。
     * （stub 必须返回**空数组**而不是 undefined：真实 findMathRegions 对无公式文本就返回 []。
     *  早前测试桩一律返回真值的教训见 docs/design-notes.md。）
     */
    'textContent',
    'mathInfoByIdx',
    'findMathRegions',
    'paraSpanGap',
    'segmentGap',
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
  const paras = run(lines, labelRe, 6, split, false, 293, { log() {}, warn() {}, error() {} }, { items: [] }, {}, () => [], () => 0, () => null);

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
  const paras2 = run(real, labelRe, 6, split, false, 293, { log() {}, warn() {}, error() {} }, { items: [] }, {}, () => [], () => 0, () => null);
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

  const styles = ['concise', 'standard', 'expert'];
  const missing = styles.filter(s => !code.includes(`key: '${s}'`));
  checkTrue(`三档齐全（${styles.join(' / ')}）`, missing.length === 0, `缺少 ${missing.join(',')}`);
  checkTrue('点击后写回设置（否则重载就丢）', /type: 'setAnswerStyle', style: next/.test(code));
  checkTrue(
    '切换函数有三档校验（非法值回落 standard）',
    /function normalizeAiStyle\(style\)/.test(code) && /return AI_STYLES\.some\(s => s\.key === v\) \? v : 'standard'/.test(code)
  );
  checkTrue(
    '旧档位 reviewer（审稿）被归一为 expert（专家）',
    /if \(v === 'reviewer'\) return 'expert'/.test(code)
  );
  checkTrue('切换后立刻给用户反馈', /showReaderToast\(`回答风格：/.test(code));
  checkTrue('有高亮当前档位的函数（作用于所有入口）', /function syncAiStyleButtons\(\)/.test(code) && /document\.querySelectorAll\('\.ai-style-btn'\)/.test(code));
  checkTrue(
    'modelInfo 到达后刷新高亮（且风格名先归一）',
    (() => {
      const fn = code.slice(code.indexOf('function handleModelInfo('));
      const body = fn.slice(0, fn.indexOf('\n  }'));
      return /aiStyle = normalizeAiStyle\(msg\.answerStyle\)/.test(body) && /syncAiStyleButtons\(\)/.test(body);
    })()
  );
  checkTrue('提问请求带上所选风格', /answerStyle: aiStyle \|\| ''/.test(code));
  // 专家模式：必须把**整篇文献**一起发过去（不是"翻过的页"）
  checkTrue(
    '专家模式会先抽取整篇文献再提问',
    /async function collectWholePaperText\(\)/.test(code) &&
      /if \(\(aiStyle \|\| ''\) === 'expert'\)/.test(code) &&
      /fullText = await collectWholePaperText\(\)/.test(code) &&
      /answerStyle: aiStyle \|\| '',\s*\n\s*fullText,/.test(code)
  );
  checkTrue('全文抽取走 pdf.js 逐页取文本层，并缓存（只抽一次）', /pdfDoc\.getPage\(p\)/.test(code) && /wholePaperTextCache = chunks\.join/.test(code));
  const ext = fs.readFileSync(path.join(path.dirname(VIEWER), '..', 'src', 'pdfEditorProvider.ts'), 'utf8');
  checkTrue(
    '宿主侧处理 setAnswerStyle 并校验取值（旧名 reviewer 写回时归一成 expert）',
    /case 'setAnswerStyle'/.test(ext) && /\['concise', 'standard', 'expert'\]\.includes\(raw\)/.test(ext)
  );
  checkTrue('宿主把整篇文献透传给 AI（fullText）', /fullText: typeof fullText === 'string' \? fullText : ''/.test(ext));
  const translatorSrc = fs.readFileSync(path.join(path.dirname(VIEWER), '..', 'src', 'translator.ts'), 'utf8');
  checkTrue(
    '专家模式：整篇上下文 + 不限篇幅 + 拆掉输出上限',
    /private buildWholePaperContext\(/.test(translatorSrc) &&
      /if \(style === 'expert'\) return 16384/.test(translatorSrc) &&
      /\*\*不限篇幅\*\*/.test(translatorSrc) &&
      /const wholePaper = isExpert \? this\.buildWholePaperContext\(options\.fullText\) : ''/.test(translatorSrc)
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

  // —— 风格控件必须放在"永不滚动"的弹窗头部（曾被放进滚动主体而看不见） ——
  checkTrue(
    '问答弹窗的风格槽位位于固定头部内',
    /ai-modal-header-actions[\s\S]{0,200}id="aiModalStyleSlot"/.test(code) ||
      /id="aiModalStyleSlot"[\s\S]{0,200}btnClearAiConversation/.test(code)
  );
  checkTrue('不再把槽位放进滚动主体（输入框区域）', !/ai-question-input-wrapper[\s\S]{0,120}id="aiModalStyleSlot"/.test(code));
  checkTrue('全文档只有一个风格槽位', (code.match(/id="aiModalStyleSlot"/g) || []).length === 1);
  checkTrue('弹窗标题旁显示扩展版本号（便于确认实际运行版本）', /id="aiModalVersion"/.test(code) && /msg\.extensionVersion/.test(code));
  checkTrue('宿主下发扩展版本号', /extensionVersion:/.test(ext));
})();

// ---------- 20. 纯公式/符号段落不送翻译（否则会被判成"未翻译"） ----------
console.log('\n===== T20 公式段落识别 =====');
(function formulaParagraphTest() {
  const start = code.indexOf('function isFormulaLikePara(para) {');
  const end = code.indexOf('\n  }', code.indexOf('return density >= 0.35', start));
  checkTrue('能从真实源码里抽出判据函数', start > 0 && end > start);
  if (start < 0 || end <= start) return;
  // eslint-disable-next-line no-new-func
  const isFormula = new Function(`${code.slice(start, end + 4)}\n return isFormulaLikePara;`)();
  const P = (t) => ({ cleanText: t });
  // 真实样本（cycle.pdf 第 4 页）
  checkTrue('纯符号段 → 判为公式（不送翻译）', isFormula(P('| Ω | ̂')));
  checkTrue('集合记号段 → 判为公式', isFormula(P('X ̂ t ⊂ { X ̂ i | i ∈ [2, t] }, Y ̂ t ⊂ { Y i | i ∈ [2, t] }.')));
  checkTrue('损失函数定义 → 判为公式', isFormula(P('L cycle,t = L (Y ̂ t, Y t) + L (Y ̂ 1, Y 1)  (3)')));
  // 反例：散文里带公式的段落**必须**继续翻译，不能被误伤
  checkTrue(
    '散文带公式（20+ 字母的整句）→ 不判为公式',
    !isFormula(P('mask. Hence, we have Y ̂ t − 1 ⊂ { Y 1 } { Y i | i ∈ [2, t − 1] }.'))
  );
  checkTrue(
    '正常英文句子 → 不判为公式',
    !isFormula(P('For the sake of mitigating error propagation during training, we incorporate the cyclical process.'))
  );
  checkTrue('空段落 → 不判为公式', !isFormula(P('   ')));
  checkTrue('已是中文 → 不判为公式', !isFormula(P('我们提出了一种循环机制。')));
  // 接线：这类段落必须从翻译队列里排除，并在归档里标成 formula
  checkTrue('自动翻译队列排除公式段', /!isFormulaLikePara\(p\)/.test(code));
  checkTrue('对照翻译列表也排除公式段（含跳过提示）', /skippedFormula/.test(code) && /段公式\/符号/.test(code));
  checkTrue('归档时标成 formula（导出据此写"无需翻译"）', /isFormulaLikePara\(p\) \? 'formula'/.test(code));
  checkTrue('Markdown 精读稿对公式段写"无需翻译"', /公式\/符号段落，无需翻译/.test(code));
})();

// ---------- 21. 视觉手术：真的按模型判断合并 / 拆分（纯函数，直接从真实源码抽出） ----------
console.log('\n===== T21 视觉手术（合并 / 拆分 / 图块 / 锚点定位） =====');
(function visionSurgeryTest() {
  const start = code.indexOf('  function normalizeVisionType(t) {');
  const end = code.indexOf('  function applyVisionSegments(pageNum, result) {');
  checkTrue('能从真实源码里抽出手术这一段（含锚点定位与全部辅助函数）', start > 0 && end > start);
  if (start < 0 || end <= start) return;

  // eslint-disable-next-line no-new-func
  const mkSurgery = new Function(
    'splitEnglishSentencesSmart',
    `${code.slice(start, end)}
     return { visionSurgery, locateAnchorIndex, normalizeVisionType, sentencesConsistent, mergeParagraphs };`
  );
  const M = mkSurgery(T.splitEnglishSentencesSmart);

  const spanStub = () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const mkPara = (id, type, text, translations) => {
    const charMap = [];
    const spans = [];
    for (let i = 0; i < text.length; i++) {
      const sp = spanStub();
      spans.push(sp);
      charMap.push({ span: sp, offset: i });
    }
    return {
      id,
      type,
      cleanText: text,
      charMap,
      rawSpans: spans,
      sentencesEn: T.splitEnglishSentencesSmart(text),
      sentenceTranslations: Array.isArray(translations) ? translations : [],
      translation: ''
    };
  };
  const consistent = list =>
    list.every(p => p.cleanText.length === p.charMap.length) &&
    list.every(p => (p.sentencesEn || []).every(s => p.cleanText.slice(s.startIdx, s.endIdx) === s.text));
  const texts = list => list.map(p => p.cleanText);

  // ---- 锚点定位：文本层残渣（组合抑扬符）vs 模型"顺手写对"的写法 ----
  const residue = 'L cycle,t = L (Y \u0302 t, Y t) + L (Y \u0302 1, Y 1) (3) In implementation, we utilize';
  checkTrue(
    '锚点精确定位（照抄残渣写法）',
    M.locateAnchorIndex(residue, 'In implementation, we utilize') === residue.indexOf('In implementation')
  );
  checkTrue(
    '锚点归一化定位（模型把 "Y ̂" 写成 "Ŷ"、去掉空白也能找到）',
    M.locateAnchorIndex(residue, 'L cycle,t=L(Ŷt,Yt)') === 0,
    String(M.locateAnchorIndex(residue, 'L cycle,t=L(Ŷt,Yt)'))
  );
  checkTrue('锚点模糊定位（掉几个字符也能找到大致位置）', M.locateAnchorIndex(residue, 'In implementaton, we utilze') >= 0);
  checkTrue('定位不到时返回 -1（调用方据此跳过该处手术，绝不猜位置）', M.locateAnchorIndex(residue, '完全不相干的一段文字') === -1);

  // ---- 拆分：正文 + 公式 + 正文 ----
  (function splitTest() {
    const p = mkPara(
      0,
      'body',
      'As shown below. L cycle,t = L (Y \u0302 t, Y t) (2) In implementation, we utilize the combination of two losses.'
    );
    const list = [p];
    const stats = M.visionSurgery(list, {
      segments: [
        {
          index: 0,
          type: 'body',
          action: 'split',
          parts: [
            { type: 'body' },
            { type: 'formula', at: 'L cycle,t = L (Y \u0302 t, Y t) (2)', latex: '\\mathcal{L}_{cycle,t}' },
            { type: 'body', at: 'In implementation' }
          ]
        }
      ]
    });
    checkTrue('一段被拆成三段', list.length === 3, texts(list).map(t => t.slice(0, 22)).join(' | '));
    checkTrue('每片的类型来自 parts（中间那片是公式）', list[1].type === 'formula' && list[1].visionLatex === '\\mathcal{L}_{cycle,t}');
    checkTrue('首片与末片是正文', list[0].type === 'body' && list[2].type === 'body');
    checkTrue('切出来的文本拼回去等于原文', texts(list).join(' ') === p.cleanText.replace(/\s+/g, ' '), texts(list).join(' | '));
    checkTrue('不变量：charMap 与文本 1:1、句子下标自洽', consistent(list));
    checkTrue('id 重新编号（0..n-1）', list.map(x => x.id).join(',') === '0,1,2');
    checkTrue('统计里记下拆分处数', stats.split === 1 && stats.split !== 0);

    // 拆分继承逐句译文：原段已对齐时，落在各片里的句子连同译文一起搬过来
    const q = mkPara(0, 'body', 'First sentence here. Second sentence follows.');
    q.sentenceTranslations = ['第一句在这里。', '第二句跟在后面。'];
    const list2 = [q];
    M.visionSurgery(list2, {
      segments: [{ index: 0, type: 'body', action: 'split', parts: [{ type: 'body' }, { type: 'body', at: 'Second sentence follows.' }] }]
    });
    checkTrue('拆分后各片继承自己那几句的译文（不重译、不串句）', list2.length === 2 && list2[1].sentenceTranslations[0] === '第二句跟在后面。', JSON.stringify(list2[1].sentenceTranslations));
    checkTrue('继承来的句子下标在新片里依然自洽', consistent(list2));

    // 切点落在句子中间 → 两边都不留半句，交给翻译队列重译（宁可重译也不贴半句译文）
    const r = mkPara(0, 'body', 'The appearance of the target object during test time.');
    r.sentenceTranslations = ['测试时间内目标对象的外观。'];
    const list3 = [r];
    M.visionSurgery(list3, {
      segments: [{ index: 0, type: 'body', action: 'split', parts: [{ type: 'body' }, { type: 'body', at: 'target object during test time.' }] }]
    });
    checkTrue(
      '切点落在句中 → 不留半句译文（那片标成需重译）',
      list3.length === 2 && list3.every(x => !x.sentenceTranslations.length) && list3.every(x => x.needsRetranslate === true)
    );
    checkTrue('切点落在句中时句子下标仍严格自洽', consistent(list3));

    // 锚点定位不到 → 跳过该处手术，段落原样保留
    const s = mkPara(0, 'body', 'Some ordinary paragraph without any formula inside.');
    const list4 = [s];
    const stats4 = M.visionSurgery(list4, {
      segments: [{ index: 0, type: 'body', action: 'split', parts: [{ type: 'body' }, { type: 'body', at: '完全定位不到的文字' }] }]
    });
    checkTrue('锚点定位不到 → 不拆（段落数量不变）', list4.length === 1 && texts(list4)[0] === s.cleanText);
    checkTrue('并且如实记下"跳过了这一处"', stats4.anchorMissed === 1 && stats4.notes.length === 1, JSON.stringify(stats4.notes));

    // 【真实 AOT 第 3 页】模型给的拆分点**跨到了下一段**：
    // 第 7 段（正文）的 parts[1] 是公式片，锚点 "′ N t m m N t m m Y = A (F (I, I, Y 1)"
    // 其实落在**第 8 段**（本地第 8 段本来就是那条公式，type=formula）。
    // 旧实现只在本段里找锚点 → 找不到就整段放弃 → 模型给的公式 latex 被**静默丢掉**，
    // 第 8 段没有任何 latex，公式整条不渲染（用户看到的"latex 渲染失败"）。
    const body7 = mkPara(
      0,
      'body',
      'In VOS, many common video scenarios have multiple targets or objects required for tracking and segmenting.'
    );
    const formula8 = mkPara(1, 'formula', '\u2032 N t m m N t m m Y = A (F (I, I, Y 1), ..., F (I, I, Y N)), (1)');
    const list5 = [body7, formula8];
    const stats5 = M.visionSurgery(list5, {
      segments: [
        {
          index: 0,
          type: 'body',
          action: 'split',
          parts: [
            { type: 'body', at: 'In VOS, many common video scenarios' },
            {
              type: 'formula',
              at: '\u2032 N t m m N t m m Y = A (F (I, I, Y 1)',
              latex: "Y' = A\\left(\\mathcal{F}^{\\mathcal{N}}(I^t, I^m, Y_1^m), ...\\right)"
            }
          ]
        }
      ]
    });
    checkTrue('拆分点落在下一段 → 先把两段接起来再拆（正文 / 公式 两片）', list5.length === 2, texts(list5).map(t => t.slice(0, 24)).join(' | '));
    checkTrue(
      '公式片拿到了 latex（不再静默丢失 → 公式能渲染）',
      list5.length === 2 && list5[1].type === 'formula' && /^Y' = A/.test(String(list5[1].visionLatex || '')),
      JSON.stringify(String(list5[1] && list5[1].visionLatex))
    );
    checkTrue('正文片仍是正文（没有把正文也标成公式）', list5.length === 2 && list5[0].type === 'body');
    checkTrue('跨段拆分后不变量仍成立（charMap 1:1、句子下标自洽）', consistent(list5));
    checkTrue('并且如实记下"这一处拆分点跨段了"', stats5.split === 1 && stats5.notes.some(n => /跨到了下一段/.test(n)), JSON.stringify(stats5.notes));

    // 【真实 AOT 第 4 页】第二种形态：模型连 index 都标错了。
    // 它把拆分挂在第 7 段（"In this section, we introduce…"），可两个锚点分别在
    // **第 10 段**（"To formulate, we define Q ∈ R"）和**第 11 段**（那条公式）里。
    // 旧实现只在本段里找锚点 → 整段放弃 → 第 11 段（type=formula）没有 latex、公式整条不渲染。
    const intro7 = mkPara(0, 'body', 'In this section, we introduce our identification mechanism proposed for efficient multi-object VOS.');
    const body10 = mkPara(1, 'body', 'HW × C T HW × C T HW × C To formulate, we define Q \u2208 R, K \u2208 R, and V \u2208 R as the query embedding of the current frame.');
    const formula11 = mkPara(2, 'formula', 'Att (Q, K, V) = Corr (Q, K) V = sof tmax (\u221a) V, (2) C');
    const list6 = [intro7, body10, formula11];
    const stats6 = M.visionSurgery(list6, {
      segments: [
        {
          index: 0,
          type: 'body',
          action: 'split',
          parts: [
            { type: 'body', at: 'To formulate, we define Q \u2208 R' },
            {
              type: 'formula',
              at: 'Att (Q, K, V) = Corr (Q, K) V',
              latex: '\\operatorname{Att}(Q,K,V) = \\operatorname{Corr}(Q,K)V = \\operatorname{softmax}\\left(\\frac{QK^{tr}}{\\sqrt{C}}\\right)V'
            }
          ]
        }
      ]
    });
    checkTrue('拆分被标到别的段上 → 按锚点挪过去（本段仍是 3 段之一）', list6.length === 3, texts(list6).map(t => t.slice(0, 20)).join(' | '));
    checkTrue('本段（第 0 段）没被卷进拆分，内容一字未改', list6[0].cleanText === intro7.cleanText && list6[0].type === 'body');
    checkTrue(
      '公式段拿到了 latex（不再静默丢失 → 公式能渲染）',
      list6[2].type === 'formula' && /^\\operatorname\{Att\}/.test(String(list6[2].visionLatex || '')),
      JSON.stringify(String(list6[2] && list6[2].visionLatex).slice(0, 60))
    );
    checkTrue('中间那段仍是正文（正文 / 公式 分得开）', list6[1].type === 'body');
    checkTrue('按锚点挪位后不变量仍成立（charMap 1:1、句子下标自洽）', consistent(list6));
    checkTrue('并且如实记下"挪到了正确的段"', stats6.split === 1 && stats6.notes.some(n => /挪到正确的段/.test(n)), JSON.stringify(stats6.notes));

    // 【真实 AOT 第 5 页】第三种形态：parts[0] **没有锚点**（模型认为首片就从本段开始），
    // 而 parts[1] 的锚点在第 9 段、parts[2] 的锚点在第 10 段——"本段开始"这个前提本身就是错的。
    // 另外同一页第 6 段的拆分先吸收了第 9、10 段，第 7 段要再往第 12 段找锚点：
    // 搜索已吸收的段必须**跳过**而不是停下，否则第二处拆分又会白丢。
    const L = [
      mkPara(0, 'body', 'V = AttID (Q, K, V, Y | D) = Att (Q, K, V + ID (Y, D)) = Att (Q, K, V + E), (4)'),
      mkPara(1, 'body', '′ HW × C where V ∈ R aggregates all the multiple targets’ embeddings from the propagation.'),
      mkPara(2, 'body', 'For Identification Decoding, i.e., predicting all the targets’ probabilities from the aggregated ′ feature V,'),
      mkPara(3, 'formula', 'Y = sof tmax (P F (V)) = sof tmax (P L), (5)'),
      mkPara(4, 'body', 'D HW × M where L ∈ R is all the M identities’ probability logits, P is the same as the selecting matrix.')
    ];
    const stats7 = M.visionSurgery(L, {
      segments: [
        {
          index: 0,
          type: 'body',
          action: 'split',
          why: '正文夹公式(5)',
          parts: [
            { type: 'body' },
            {
              type: 'formula',
              at: 'Y = sof tmax (P F (V)) = sof tmax (P L), (5)',
              latex: "Y' = \\mathit{softmax}(PF^{\\mathcal{D}}(V')) = \\mathit{softmax}(PL^{\\mathcal{M}})"
            },
            { type: 'body', at: 'D HW × M where L ∈ R is all the M' }
          ]
        }
      ]
    });
    checkTrue(
      'parts[0] 没有锚点时，用 parts[1] 的锚点定位起点（公式不再被丢掉）',
      L.length === 5 && L[3].type === 'formula' && /^Y' = \\mathit\{softmax\}/.test(String(L[3].visionLatex || '')),
      `${L.length} 段；第 4 段 type=${L[3] && L[3].type} latex=${JSON.stringify(String((L[3] && L[3].visionLatex) || '').slice(0, 40))}`
    );
    checkTrue(
      '中间那两段（公式后正文 / 正文）一个字没改、也没被吞掉',
      L[1].cleanText.startsWith('′ HW × C where V') && L[2].cleanText.startsWith('For Identification Decoding')
    );
    checkTrue('本段（第 0 段）没被卷进拆分', L[0].cleanText.startsWith('V = AttID (Q, K, V, Y | D)'));
    checkTrue('挪位后不变量仍成立（charMap 1:1、句子下标自洽）', consistent(L));
    checkTrue('并且如实记下这一处是挪过去的', stats7.split === 1 && stats7.notes.some(n => /挪到正确的段/.test(n)), JSON.stringify(stats7.notes));
  })();

  // ---- 合并：跨栏半句 ----
  (function mergeTest() {
    const a = mkPara(0, 'body', 'A related work fine-tunes deep network models on the initial object mask to remember the appearance of the', [
      '相关工作在首帧的目标掩码上微调深度网络，以记住'
    ]);
    const b = mkPara(1, 'body', 'target object [2,34,26,14,26,11,18] during the test time.', ['测试时间内的目标对象外观。']);
    const list = [a, b];
    const stats = M.visionSurgery(list, {
      segments: [
        { index: 0, type: 'body', order: 1, action: 'merge_next' },
        { index: 1, type: 'body', order: 2, action: 'keep' }
      ]
    });
    checkTrue('两段合并成一段', list.length === 1);
    checkTrue(
      '合并后的文本是完整句子',
      /appearance of the target object \[2,34,26,14,26,11,18\] during the test time\.$/.test(list[0].cleanText),
      list[0].cleanText.slice(-80)
    );
    checkTrue('合并后句子下标与文本严格自洽（跨栏半句被真正拼成一句）', consistent(list));
    checkTrue('合并后只剩一句（半句不再单独成句）', list[0].sentencesEn.length === 1, JSON.stringify(list[0].sentencesEn.map(s => s.text.slice(0, 24))));
    checkTrue('两句译文被拼到同一句上（不是丢掉重来）', list[0].sentenceTranslations.length === 1 && /相关工作/.test(list[0].sentenceTranslations[0]) && /目标对象外观/.test(list[0].sentenceTranslations[0]), JSON.stringify(list[0].sentenceTranslations));
    checkTrue('合并后 span 重新挂到存活段落的 id', list[0].rawSpans.every(sp => String(sp.attrs['data-para-id']) === '0'));
    checkTrue('统计里记下合并处数', stats.merged === 1);

    // 反例：下一段被判定要拆 → 不合并（拆分语义优先，避免"一半合一半拆"）
    const c = mkPara(0, 'body', 'ends mid sentence', ['半句']);
    const d = mkPara(1, 'body', 'Some. Other.');
    const list2 = [c, d];
    M.visionSurgery(list2, {
      segments: [
        { index: 0, type: 'body', order: 1, action: 'merge_next' },
        { index: 1, type: 'body', order: 2, action: 'split', parts: [{ type: 'body' }, { type: 'body', at: 'Other.' }] }
      ]
    });
    checkTrue(
      '下一段还要拆 → 不与它合并（拆分优先，且合并落在拆出来的碎片上语义不清）',
      list2.length === 3 && texts(list2)[0] === 'ends mid sentence',
      texts(list2).join(' | ')
    );

    // 反例：模型没判断过的相邻段（没有编号）→ 邻接关系不可信，不合并
    const e = mkPara(0, 'body', 'ends mid sentence too');
    const f = mkPara(1, 'body', 'not judged by the model.');
    const list3 = [e, f];
    M.visionSurgery(list3, { segments: [{ index: 0, type: 'body', action: 'merge_next' }] });
    checkTrue('只合并模型明确判断过的相邻段', list3.length === 2);

    // 合并时两段的行内公式替换表必须**合起来**：
    // 模型常把公式的替换表给在"被判 merge_next 的下一段"上，只留前一段的会让公式又变回残渣
    const m1 = mkPara(0, 'body', 'the inference stage, the corresponding predicted mask Y ̂ t is used as the approximation of the reference');
    const m2 = mkPara(1, 'body', 'mask. Hence, we have Y ̂ t − 1 ⊂ { Y 1 } { Y i | i ∈ [2, t − 1] }.');
    const list6 = [m1, m2];
    M.visionSurgery(list6, {
      segments: [
        { index: 0, type: 'body', order: 1, action: 'merge_next', inline: [{ find: 'Y ̂ t', latex: '\\hat{Y}_t' }] },
        {
          index: 1,
          type: 'body',
          order: 2,
          action: 'keep',
          inline: [{ find: 'Y ̂ t − 1 ⊂ { Y 1 }', latex: '\\mathcal{Y}_{t-1}' }]
        }
      ]
    });
    checkTrue(
      '合并后两段的行内公式替换表都在（否则后一段的公式又变回残渣）',
      list6.length === 1 && (list6[0].visionInline || []).length === 2,
      JSON.stringify((list6[0].visionInline || []).map(x => x.find))
    );

    // 护栏一：下一段以大写开头 = 新段落的开头（模型有把"本段续上一段"错标成 merge_next 的倾向）
    const g = mkPara(0, 'body', 'background camel will serve as the foundation for our');
    const h = mkPara(1, 'body', 'Based on these observations, we design a new module.');
    const list4 = [g, h];
    M.visionSurgery(list4, {
      segments: [
        { index: 0, type: 'body', order: 1, action: 'merge_next', why: '小写起首，上页续句' },
        { index: 1, type: 'body', order: 2, action: 'keep' }
      ]
    });
    checkTrue('下一段以大写开头 → 不合并（实测模型会在这里给假 merge_next）', list4.length === 2, texts(list4).join(' | '));

    // 护栏二：下一段是小节标题 → 不合并（"2 Related works" → "2.1 Semi-supervised…" 字面很像续句）
    const k = mkPara(0, 'body', '2 Related works');
    const l = mkPara(1, 'body', '2.1 Semi-supervised video object segmentation.');
    const list5 = [k, l];
    M.visionSurgery(list5, {
      segments: [
        { index: 0, type: 'heading', order: 1, action: 'merge_next' },
        { index: 1, type: 'heading', order: 2, action: 'keep' }
      ]
    });
    checkTrue('下一段是标题/图注类 → 不合并', list5.length === 2, texts(list5).join(' | '));
  })();

  // ---- 图块分组：图注留下、图内文字剔出正文 ----
  (function groupTest() {
    const list = [
      mkPara(0, 'caption', 'Figure 2: Overview of the framework.'),
      mkPara(1, 'body', 'Segmentation Network'),
      mkPara(2, 'body', 'Loss'),
      mkPara(3, 'body', 'Real body paragraph that must stay.')
    ];
    const stats = M.visionSurgery(list, {
      segments: [
        { index: 0, type: 'figure_caption', order: 1, group: 1, action: 'keep' },
        { index: 1, type: 'figure', order: 2, group: 1, action: 'keep' },
        { index: 2, type: 'figure', order: 3, group: 1, action: 'keep' },
        { index: 3, type: 'body', order: 4, action: 'keep' }
      ]
    });
    checkTrue(
      '图内文字被剔成 figure-label（不翻译、不出卡片）',
      list.filter(p => p.type === 'figure-label').length === 2,
      list.map(p => p.type).join(',')
    );
    checkTrue('图注仍是 caption（保留为一张卡片）', list[0].type === 'caption');
    checkTrue('图块成员排在一起', list.slice(0, 3).every(p => p.type !== 'body'), list.map(p => p.type).join(','));
    checkTrue('正文段落没被误伤', list[3].type === 'body');
    checkTrue('统计里记下图块数', stats.grouped === 1);

    // 护栏：模型把图下方的正文也归进同一 group 时，正文不能被当成图内文字丢掉
    const list3 = [
      mkPara(0, 'caption', 'Figure 3: Another framework.'),
      mkPara(1, 'body', 'Segmentation Network'),
      mkPara(
        2,
        'body',
        'We further observe that the cyclic mechanism works well across all evaluated datasets, and the improvement is consistent.'
      )
    ];
    const stats3 = M.visionSurgery(list3, {
      segments: [
        { index: 0, type: 'figure_caption', order: 1, group: 2, action: 'keep' },
        { index: 1, type: 'figure', order: 2, group: 2, action: 'keep' },
        { index: 2, type: 'figure', order: 3, group: 2, action: 'keep' }
      ]
    });
    checkTrue(
      '图块里明显是正文的成员不被丢掉（宁可少删，不能删错）',
      list3[2].type === 'body' && /We further observe/.test(list3[2].cleanText),
      list3.map(p => p.type).join(',')
    );
    checkTrue('并且如实记下"已保留"', stats3.notes.some(n => /明显是正文/.test(n)), JSON.stringify(stats3.notes));

    // 没有图注做锚点 → 只收拢顺序，什么都不丢
    const list2 = [mkPara(0, 'body', 'Axis label'), mkPara(1, 'body', 'Legend item')];
    const stats2 = M.visionSurgery(list2, {
      segments: [
        { index: 0, type: 'figure', order: 1, group: 3, action: 'keep' },
        { index: 1, type: 'figure', order: 2, group: 3, action: 'keep' }
      ]
    });
    checkTrue('图块里没标出图注 → 不做任何丢弃（宁可少删，不能删错）', list2.every(p => p.type === 'figure-label' || p.type === 'body'));
    checkTrue('并且如实记下"只收拢顺序"', stats2.notes.some(n => /没有标出图注/.test(n)), JSON.stringify(stats2.notes));
  })();

  // ---- 类型收敛 / 丢弃 / 阅读顺序 ----
  (function typeAndOrderTest() {
    checkTrue('figure / table → figure-label（否则图内文字照旧被送翻译）', M.normalizeVisionType('figure') === 'figure-label' && M.normalizeVisionType('TABLE') === 'figure-label');
    checkTrue('figure_caption → caption', M.normalizeVisionType('figure_caption') === 'caption');
    checkTrue('page_number / header / footer → noise', M.normalizeVisionType('page_number') === 'noise' && M.normalizeVisionType('footer') === 'noise');
    checkTrue('formula / formula_inline 原样保留', M.normalizeVisionType('formula') === 'formula' && M.normalizeVisionType('formula_inline') === 'formula_inline');
    checkTrue('不认识的类型不硬套（返回空串）', M.normalizeVisionType('whatever') === '');

    const list = [
      mkPara(0, 'body', 'first paragraph here.'),
      mkPara(1, 'body', 'PDF-4'),
      mkPara(2, 'body', 'second paragraph here.')
    ];
    M.visionSurgery(list, {
      segments: [
        { index: 2, type: 'body', order: 1, action: 'keep' },
        { index: 0, type: 'body', order: 2, action: 'keep' },
        { index: 1, type: 'page_number', order: 3, action: 'drop' }
      ]
    });
    checkTrue('阅读顺序按 order 重排', texts(list)[0].indexOf('second') === 0, texts(list).join(' | '));
    checkTrue('判定丢弃的段落标成 noise', list.some(p => p.type === 'noise' && /PDF-4/.test(p.cleanText)));

    // 模型不给 order（或给得不全）→ 按回包里 segments 的数组顺序（提示词要求它按阅读顺序列出）
    const list2 = [mkPara(0, 'body', 'aaa.'), mkPara(1, 'body', 'bbb.')];
    M.visionSurgery(list2, {
      segments: [
        { index: 1, type: 'body', action: 'keep' },
        { index: 0, type: 'body', action: 'keep' }
      ]
    });
    checkTrue('没有 order 时按回包数组顺序（= 模型给的阅读顺序）', texts(list2)[0].indexOf('bbb') === 0, texts(list2).join(' | '));
  })();

  // ---- 接线检查：手术永远在"本地原件"上重放，且能撤销 ----
  checkTrue('手术作用于本地原件而不是"已手术过的当前结果"', /function visionBaseParagraphs\(\)/.test(code) && /localParagraphsSnapshot/.test(code));
  checkTrue('渲染完成时留档本地原件', /localParagraphsSnapshot = cloneParagraphs\(paras\)/.test(code));
  checkTrue('重复应用不会叠加（每次先克隆原件）', /const list = cloneParagraphs\(visionBaseParagraphs\(\)\)/.test(code));
  // 撤销功能已移除：默认每页都套用视觉重排，不留"这一页被排除在外"的岔路
  checkTrue(
    '代码里不再有任何撤销入口',
    !/undoVisionStructure|doUndoVision|撤销本页视觉改动/.test(code) && !/vision-status-action/.test(code)
  );
  checkTrue(
    '历史遗留的 disabled 标记被忽略（不再短路）',
    /function isUsableVisionCache\(entry\)/.test(code) && !/entry\.disabled\) return false/.test(code) && !/cached\.disabled\) return;/.test(code)
  );
  checkTrue(
    '每一页都默认调度视觉重排（没有"撤销过就跳过"的分支）',
    /if \(engine === 'vision' \|\| \(engine === 'auto' && looksLowConfidence\(paras\)\)\)/.test(code) &&
      !/const undone = /.test(code)
  );
  checkTrue('v1 协议缓存判废（缺 parts/group/inline）', /Number\(entry\.version\) >= 2/.test(code));
  // 「视觉重排」按钮也移除：每页默认都做，按钮是冗余入口；"重判本页"改由"换视觉模型"承担
  const providerSrc = fs.readFileSync(path.join(path.dirname(VIEWER), '..', 'src', 'pdfEditorProvider.ts'), 'utf8');
  checkTrue(
    '「视觉重排」按钮已移除（viewer.js 与宿主 HTML 都不再引用）',
    !/visionRestructureBtn/.test(code) && !/visionRestructureBtn/.test(providerSrc)
  );
  checkTrue(
    '换视觉模型 → 该页视觉缓存判废、下次渲染重判（移除按钮后的重判入口）',
    /configuredVisionModel/.test(code) &&
      /entry\.requested === configuredVisionModel/.test(code) &&
      /!\(Number\(entry\.version\) >= 2\)/.test(code) &&
      /requested: configuredVisionModel \|\| ''/.test(code)
  );
  checkTrue('请求视觉时发的是本地未手术的分段', /localParagraphsPage === pageNum && localParagraphsSnapshot \? localParagraphsSnapshot/.test(code));
  checkTrue('手术抛异常时回退到"只改类型"的老路径', /视觉手术失败，回退到只改类型/.test(code));
  checkTrue('设置项可关闭手术（关掉 = 只改类型/顺序/丢弃）', /visionSurgeryAllowed \? applyVisionStructure\(page, result\) : applyVisionSegments\(page, result\)/.test(code));
  checkTrue('行内公式只在显示层替换（原文/坐标不动）', /function renderEnTextHtml\(text, inline\)/.test(code));
  // 1.4.0：卡片原文侧统一走 renderParaEnHtml（**本地数学层优先**，视觉替换表只作兜底）
  checkTrue(
    '卡片里的英文原文走行内公式渲染（本地公式优先）',
    /div class="sent-en">\$\{renderParaEnHtml\(sent\.text, para\)\}/.test(code) &&
      /function renderParaEnHtml\(text, para\)/.test(code)
  );
  // 视觉手术会重新编号 → 批注不能只按编号找段落（否则"点批注跳到别的段"）
  checkTrue(
    '批注定位改成"引文文字优先、编号兜底"',
    /function findParaForAnnotation\(annot\)/.test(code) &&
      /if \(byId && \(!text \|\| matches\(byId\)\)\) return byId;/.test(code) &&
      (code.match(/const matchedPara = findParaForAnnotation\(annot\);/g) || []).length === 2
  );
})();

// ---------- 22. 公式渲染：latex 里夹着 $ 定界符 / 孤儿组合符（真实存档数据） ----------
console.log('\n===== T22 公式渲染（视觉 latex 的脏数据 + 残渣孤儿帽子） =====');
(function formulaRenderTest() {
  const start = code.indexOf('  const RESIDUE_HAT_RE');
  const end = code.indexOf('\n  function renderInlineMarkdown(');
  const locateStart = code.indexOf('  const VISION_CHAR_EQUIV = {');
  const locateEnd = code.indexOf('\n  }', code.indexOf('  function locateAnchorIndex(text, anchor, from) {'));
  checkTrue('能从真实源码里抽出渲染片段（含 residue 规则与 renderEnTextHtml）', start > 0 && end > start && locateStart > 0 && locateEnd > locateStart);
  if (start < 0 || end <= start) return;
  // 旧版没有 renderVisionMathHtml（latex 直接进 KaTeX）→ 明确失败，而不是让整个测试文件崩掉
  checkTrue('源码里有 renderVisionMathHtml（视觉 latex 的统一渲染入口）', /function renderVisionMathHtml\(/.test(code));
  if (!/function renderVisionMathHtml\(/.test(code)) return;

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // KaTeX 用桩：只看"哪段文字被送进了数学模式"，以及有没有残留的组合符
  const katexStub = (tex, display) => `<KATEX${display ? '-D' : ''}>${tex}</KATEX>`;
  // eslint-disable-next-line no-new-func
  const locate = new Function(
    `${code.slice(locateStart, locateEnd + 4)}
     return {
       locateAnchorIndex,
       locateAnchorRange: typeof locateAnchorRange === 'function' ? locateAnchorRange : null
     };`
  )();
  // 旧版没有 locateAnchorRange（替换区间用 find.length 取，命中长度一比就切坏）→ 明确失败
  checkTrue(
    '源码里有 locateAnchorRange（替换区间按真实命中长度取）',
    typeof locate.locateAnchorRange === 'function'
  );
  // eslint-disable-next-line no-new-func
  const R = new Function(
    'escapeHtml',
    'renderMathSpan',
    'locateAnchorIndex',
    'locateAnchorRange',
    `${code.slice(start, end)}
     return { renderEnTextHtml, renderTextWithMath, renderVisionMathHtml };`
  )(esc, katexStub, locate.locateAnchorIndex, locate.locateAnchorRange || (() => null));

  const HAT = '\u0302';

  // ---- ① 视觉模型把"整句 + $ 定界符"塞进 latex（真实 cycle 第 6 页的替换表） ----
  // 旧实现直接丢给 KaTeX → Can't use function '$' in math mode → 界面上是一块红色的报错。
  const dirty = 'learning rate $10^{-5}$';
  const dirtyHtml = R.renderVisionMathHtml(dirty, false);
  checkTrue(
    'latex 里夹着 $ 时不再整条进数学模式（否则 KaTeX 直接报错）',
    !/<KATEX[^>]*>[^<]*learning rate/.test(dirtyHtml),
    dirtyHtml
  );
  checkTrue('文字部分照原样显示，只有 $...$ 里的公式进渲染', /learning rate/.test(dirtyHtml) && /<KATEX[^>]*>10\^\{-5\}<\/KATEX>/.test(dirtyHtml), dirtyHtml);
  checkTrue('纯公式仍整条走数学模式（不受这条规则影响）', R.renderVisionMathHtml('\\hat{Y}_t', false) === '<KATEX>\\hat{Y}_t</KATEX>');

  // 同一个替换表经 renderEnTextHtml 落到正文里，效果相同
  const src = 'We set M = 50 and learning rate 10.';
  const table = [{ find: 'learning rate 10', latex: dirty }];
  const html = R.renderEnTextHtml(src, table);
  checkTrue(
    '替换表里的脏 latex 经正文渲染也不会把散文丢进 KaTeX',
    !/<KATEX[^>]*>[^<]*learning rate/.test(html) && /learning rate/.test(html),
    html
  );

  // ---- ② 没有基字母的孤儿组合符（真实 cycle 第 4/5 页："(̂)" 与 "| Ω | ̂"） ----
  const orphan = `(${HAT}) M cycle-ERF (Y l) = ReLU Y l (6)`;
  const orphanHtml = R.renderTextWithMath(orphan);
  checkTrue('孤儿帽子（前面不是字母）被清掉，不再漂在字外', !orphanHtml.includes(HAT), orphanHtml);
  checkTrue('公式编号的括号还在（只去掉那个没意义的组合符）', /^\(\)/.test(orphanHtml.replace(/<[^>]+>/g, '')), orphanHtml);

  const tailOrphan = `| \u03a9 | ${HAT}`;
  checkTrue('行尾的孤儿帽子同样被清掉', !R.renderTextWithMath(tailOrphan).includes(HAT), R.renderTextWithMath(tailOrphan));

  // 反例：有基字母的帽子仍必须转成公式（清理规则绝不能吃掉它）
  const realHat = `Y ${HAT} t = S \u03b8 (X t)`;
  const realHtml = R.renderTextWithMath(realHat);
  checkTrue(
    '有基字母的帽子照旧转成公式（清理规则没有误伤）',
    /<KATEX[^>]*>\\hat\{Y\}_\{t\}<\/KATEX>/.test(realHtml),
    realHtml
  );
  checkTrue('并且不会在输出里留下裸组合符', !realHtml.includes(HAT), realHtml);

  // ---- ③ 旧式译文：替换区间必须按**真实命中长度**取，不能按 find 的长度 ----
  // 真实 AOT 第 5 页：模型给的 find 是 "Y ∈ { 0, 1 }"（12 字、带空格），而中文译文里写的是
  // "Y ∈ {0, 1}"（10 字）——旧实现用 find.length 当结尾，多吃的两个字正好是后面那个上标的
  // `^{`，于是界面上变成"公式 + 悬空的 } + 一段重复的公式"（用户反馈"翻译乱套了"）。
  const oldStyleZh =
    '假设视频场景中有 N（N < M）个目标，将目标的独热掩码 Y ∈ {0, 1}^{T HW × N} 嵌入为身份嵌入 E ∈ R^{T HW × C} 的公式为，';
  const table5 = [
    { find: 'T HW × N', latex: 'THW \\times N' },
    { find: 'T HW × C', latex: 'THW \\times C' },
    { find: 'Y ∈ { 0, 1 }', latex: 'Y \\in \\{0,1\\}^{THW \\times N}' },
    { find: 'E ∈ R', latex: 'E \\in \\mathbb{R}^{THW \\times C}' }
  ];
  const fixedZh = R.renderEnTextHtml(oldStyleZh, table5);
  checkTrue(
    '旧式译文：只出 2 条公式（不重复、不多吃字符）',
    (fixedZh.match(/<KATEX>/g) || []).length === 2,
    fixedZh
  );
  checkTrue(
    '旧式译文：公式后面不再吊着悬空的 } / ^{...}',
    !/<\/KATEX>\s*\}/.test(fixedZh) && !/<\/KATEX>\s*\^/.test(fixedZh),
    fixedZh
  );
  checkTrue(
    '旧式译文：上标被算进同一条公式（latex 自带 ^ 时是"吃掉"，不是再并一个）',
    fixedZh.includes('<KATEX>Y \\in \\{0,1\\}^{THW \\times N}</KATEX>') &&
      fixedZh.includes('<KATEX>E \\in \\mathbb{R}^{THW \\times C}</KATEX>') &&
      !/\\hat\{Y\}_t\^/.test(fixedZh),
    fixedZh
  );

  // ---- ④ 新式译文（模型自己写了 $...$）：替换表绝不能伸进数学区间里 ----
  // 真实 AOT 第 5 页存在第二份译文缓存（模型自己转写了 LaTeX）。替换表的 find 是文本层残渣写法，
  // 归一化+模糊匹配很容易命中已经正确的 LaTeX，一旦命中就把一条完整公式从中间劈开。
  const newStyleZh =
    '将目标的独热掩码 $Y \\in \\{0,1\\}^{T \\times H \\times W \\times N}$ 嵌入为身份嵌入 $E \\in \\mathbb{R}^{T \\times H \\times W \\times C}$ 的公式为';
  const newHtml = R.renderEnTextHtml(newStyleZh, table5);
  checkTrue(
    '新式译文：$...$ 原样进数学模式（模型自己写的 LaTeX 不被替换表动）',
    newHtml.includes('<KATEX>Y \\in \\{0,1\\}^{T \\times H \\times W \\times N}</KATEX>') &&
      newHtml.includes('<KATEX>E \\in \\mathbb{R}^{T \\times H \\times W \\times C}</KATEX>'),
    newHtml
  );
  checkTrue(
    '新式译文：没有把残渣公式拼进去（不该出现 THW \\times N）',
    !newHtml.includes('THW \\times N') && (newHtml.match(/<KATEX>/g) || []).length === 2,
    newHtml
  );

  // ---- ⑤ 老行为不能丢：裸上标 + latex 里没有 ^ → 仍然并进同一条公式 ----
  // 真实形态：替换表的 find 只覆盖到主体（`Y ̂ t`），源文本后面还跟着一个裸的 `^N`，
  // 而 latex `\hat{Y}_t` 里**没有** `^`（\hat 不是上标）→ 必须并成 \hat{Y}_t^{N}。
  const supCase = R.renderEnTextHtml(`经过 Y ${HAT} t^N 次迭代`, [{ find: `Y ${HAT} t`, latex: '\\hat{Y}_t' }]);
  checkTrue('latex 没有上标时，裸上标照旧并进公式', supCase.includes('<KATEX>\\hat{Y}_t^{N}</KATEX>'), supCase);
})();

// ---------- 23. AI 回答里的公式：HTML 实体 / 行内 \tag / 落单的 $ ----------
console.log('\n===== T23 AI 回答与译文里的公式渲染（真实数据） =====');
(function aiMathRenderTest() {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sliceFn = (sig, endAt) => {
    const s = code.indexOf(sig);
    const e = code.indexOf('\n  }', endAt ? code.indexOf(endAt, s) : s);
    return s >= 0 && e > s ? code.slice(s, e + 4) : '';
  };
  checkTrue('源码里有 decodeMathEntities（数学片段还原 HTML 实体）', /function decodeMathEntities\(/.test(code));
  if (!/function decodeMathEntities\(/.test(code)) return;
  // 【关键】不能用桩替换 renderMathSpan：实体还原与行内 \tag 改写都在它里面。
  // 用**真 KaTeX**包一层记录（renderMathSpan 读的是 window.katex）：
  // 这样既能记下送进去的 tex，又能真的判定"渲染不出来就留成代码块"这条闸门。
  const start = code.indexOf('  function renderInlineMarkdown(text) {');
  const end = code.indexOf('\n  function renderMarkdownToHtml(md) {');
  checkTrue('能从真实源码里抽出渲染片段', start > 0 && end > start);
  if (start < 0 || end <= start) return;
  let realKatex = null;
  try {
    realKatex = require(path.join(__dirname, '..', '..', 'media', 'katex', 'katex.min.js'));
  } catch (e) {
    checkTrue('能加载本地 KaTeX（公式渲染复核需要它）', false, String(e && e.message));
    return;
  }
  const seen = [];
  const prevWindow = global.window;
  global.window = {
    katex: {
      renderToString: (tex, opts) => {
        seen.push({ tex: String(tex), display: !!(opts && opts.displayMode) });
        return realKatex.renderToString(tex, opts);
      }
    }
  };
  // eslint-disable-next-line no-new-func
  const renderInline = new Function(
    'escapeHtml',
    'console',
    `${sliceFn('  function looksLikeMath(tex) {', '  function looksLikeInlineMath(tex) {')}
     ${sliceFn('  function looksLikeInlineMath(tex) {', '  function looksLikeMathResidue(s) {')}
     ${sliceFn('  function decodeMathEntities(tex) {', '  function renderMathSpan(tex, displayMode) {')}
     ${sliceFn('  function renderMathSpan(tex, displayMode) {')}
     ${code.slice(start, end)}
     return renderInlineMarkdown;`
  )(esc, { log() {}, warn() {} });
  const texOf = () => (seen.length ? seen[seen.length - 1].tex : '');
  const isMathRendered = html => /class="md-math-rendered/.test(html);
  const isCodePill = html => /<code class="md-code">/.test(html);

  // ---- ① HTML 实体：`$N(N<M)$` 经 escapeHtml 后若把 &lt; 直接喂给 KaTeX 会报
  //      "Expected 'EOF', got '&'"，界面上是一整块红字（真实回答里出现过 N(N<M)、N<M、y > t）
  const esc1 = renderInline('条件是 $N(N<M)$ 时');
  checkTrue(
    '实体还原：< 以真字符送进 KaTeX（不是 &lt;）',
    texOf().includes('N(N<M)') && !texOf().includes('&lt;'),
    esc1
  );
  const esc2 = renderInline('只要 $y > t$ 就成立');
  checkTrue('实体还原：> 同理（不是 &gt;）', texOf().includes('y > t') && !texOf().includes('&gt;'), esc2);

  // ---- ② 行内 \tag：KaTeX 规定 \tag 只能用于 display，行内会报
  //      "\tag works only in display equations" → 改写成 \quad\text{(N)}
  const tagInline = renderInline('见 $E = ID(Y,D) = YPD, \\tag{3}$ 这一式');
  checkTrue(
    '行内 \\tag 改写成 \\quad\\text{(3)}（不再让 KaTeX 报错）',
    texOf().includes('\\quad\\text{(3)}') && !texOf().includes('\\tag'),
    tagInline
  );
  const tagDisplay = renderInline('$$E = YPD, \\tag{3}$$');
  checkTrue('display 公式里的 \\tag 保持原样（那里合法）', texOf().includes('\\tag{3}'), tagDisplay);

  // ---- ③ 落单的 $：join(' ') 之后会和远处的 $ 配成一对，把一大段散文塞进 KaTeX ——
  //      实测被吞的片段长这样（含 #、|、**、中文标点）→ 必须拒绝、原样显示
  const stray = renderInline('| 身份库中身份向量总数 | 标量 | ## 二、那个 tr 到底是什么');
  checkTrue('落单 $ 配出的散文片段不被当成公式', !isMathRendered(stray), stray);

  // ---- ④ 但不能误伤真公式：短式子（$t+1$、$l+1$、$N < M$）必须照常渲染
  ['$t+1$', '$l+1$', '$N < M$', '$X_t$', '$\\hat{X}_t$'].forEach(expr => {
    const html = renderInline(`这是 ${expr} 的说明`);
    checkTrue(`短式子 ${expr} 照常渲染`, isMathRendered(html), html);
  });

  // ---- ⑤ 模型爱用反引号包变量/公式（真实回答里 $...$ 是 0 个、反引号片段 129 个）----
  //      照 Markdown 渲染就是一片灰底代码块（实测 500 个），必须按行内公式渲染
  ['`W_K`', '`X^l W^l`', '`Q ∈ R^{HW×C}`', '`Y ∈ {0,1}^{THW×N}`', '`V\' = AttID(Q, K, V, Y | D)`', '`X̂_t`', '`∂L_S/∂Ŷ`', '`$W_K$`'].forEach(
    span => {
      const html = renderInline(`这里的 ${span} 是什么`);
      checkTrue(`反引号里的公式 ${span} 按行内公式渲染`, isMathRendered(html) && !isCodePill(html), html);
    }
  );
  checkTrue('模型把公式写了两层定界符（\\`$W_K$\\`）时剥掉再渲染', !texOf().includes('$'), JSON.stringify(texOf()));

  // ---- ⑥ 真正的代码/命令仍必须是代码块（不能为了公式把代码也渲染了）
  ['`npm run vsix`', '`media/viewer.js`', '`const a = 1`', '`D:\\kx\\path`', '`hello world foo`'].forEach(span => {
    const html = renderInline(`执行 ${span} 即可`);
    checkTrue(`真代码 ${span} 仍按代码块显示`, isCodePill(html) && !isMathRendered(html), html);
  });

  // ---- ⑦ 硬闸门：形状像数学但 KaTeX 渲染不出来的，必须退回代码块（绝不出现红字）
  const badTex = renderInline('写成 `\\frac{1}` 是错的');
  checkTrue('KaTeX 渲染不出来的片段退回代码块（不会变成报错红字）', !/katex-error/.test(badTex), badTex);
  global.window = prevWindow;
})();

// ---------- 24. 问 AI 时把规范公式交给模型（focusMath） ----------
console.log('\n===== T24 公式聚焦：把规范 LaTeX 交给模型 =====');
(function focusMathTest() {
  checkTrue('源码里有 collectFocusMath（提问时收集规范公式）', /function collectFocusMath\(/.test(code));
  if (!/function collectFocusMath\(/.test(code)) return;

  // 场景一：公式段落（真实数据取自 AOT 第 5 页公式 (4)）
  const formulaPara = {
    id: 6,
    type: 'formula',
    cleanText: 'V = AttID (Q, K, V, Y | D) = Att (Q, K, V + ID (Y, D)) = Att (Q, K, V + E), (4)',
    visionLatex: "V' = \\mathit{AttID}(Q, K, V, Y \\mid D) = \\mathit{Att}(Q, K, V + \\mathrm{ID}(Y, D))"
  };
  checkTrue('公式段落：带上规范 LaTeX', T.collectFocusMath(formulaPara, formulaPara.cleanText).includes('\\mathit{AttID}'));
  checkTrue('文本层残渣不会被当成规范式送出去', !T.collectFocusMath(formulaPara, '').includes('Y | D'));

  // 场景二：正文段落里的行内公式（真实数据取自 AOT 第 5 页第 3 段）
  const bodyPara = {
    id: 3,
    type: 'body',
    cleanText: 'First, an Identification Embedding mechanism is proposed to embed the masks of multiple different targets into V',
    visionInline: [
      { find: 'Y ∈ { 0, 1 }', latex: 'Y \\in \\{0,1\\}^{THW \\times N}' },
      { find: 'E ∈ R', latex: 'E \\in \\mathbb{R}^{THW \\times C}' },
      { find: 'D ∈ R', latex: 'D \\in \\mathbb{R}^{M \\times C}' }
    ]
  };
  const oneSent = T.collectFocusMath(bodyPara, 'embed the masks Y ∈ { 0, 1 } into');
  checkTrue('只带"聚焦文本里确实出现"的那条行内公式', oneSent.includes('THW \\times N') && !oneSent.includes('M \\times C'), oneSent);
  const whole = T.collectFocusMath(bodyPara, bodyPara.cleanText);
  checkTrue('聚焦整段时带上整段的公式', whole.includes('THW \\times N') && whole.includes('M \\times C'));
  checkTrue('同一条公式不重复出现', (whole.match(/THW \\times N/g) || []).length === 1);

  // 场景三：没有公式 / 没有段落时不能硬造
  checkTrue('普通段落不产生 focusMath', T.collectFocusMath({ id: 1, type: 'body', cleanText: 'plain text' }, 'plain') === '');
  checkTrue('没有聚焦段落时返回空串', T.collectFocusMath(null, 'x') === '');

  // 场景四：上限（避免把整段十几条公式全塞进提示词）
  const many = { id: 9, type: 'body', cleanText: 'x', visionInline: [] };
  for (let k = 0; k < 20; k++) many.visionInline.push({ find: 'x', latex: `L_{${k}}` });
  const capped = T.collectFocusMath(many, 'x').split('\n');
  checkTrue('公式条数有上限（最多 8 条）', capped.length === 8, String(capped.length));
})();

// ---------- 25. 全文公式与符号索引 ----------
console.log('\n===== T25 公式与符号索引（真实 AOT 回包） =====');
(function mathIndexTest() {
  checkTrue('源码里有 extractMathSymbols（从 LaTeX 抽符号）', /function extractMathSymbols\(/.test(code));
  if (!/function extractMathSymbols\(/.test(code)) return;

  // ① 符号抽取：真实 AOT 第 5 页式 (4)
  const syms4 = T.extractMathSymbols("V' = \\mathit{AttID}(Q, K, V, Y \\mid D) = \\mathit{Att}(Q, K, V + \\mathrm{ID}(Y, D))");
  ['AttID', 'Att', 'ID', 'Q', 'K', 'V', 'Y', 'D'].forEach(s =>
    checkTrue(`抽出符号 ${s}`, syms4.includes(s), JSON.stringify(syms4))
  );
  checkTrue('关系/排版命令不进符号表', !syms4.some(s => /^\\/.test(s)), JSON.stringify(syms4.filter(s => /^\\/.test(s))));

  // 上下标要跟着符号走（读者查的就是 W^l 这种）
  const syms6 = T.extractMathSymbols('\\mathrm{AttLT}(X^l, X^l, Y) = \\mathit{AttID}(X^l W^l, X^l W^l, X^l W^l, Y \\mid D)');
  checkTrue('上下标并进符号名（X^l / W^l）', syms6.includes('X^l') && syms6.includes('W^l'), JSON.stringify(syms6));
  checkTrue('希腊字母保留（那是要查的符号）', T.extractMathSymbols('\\alpha \\cdot x^2').includes('\\alpha'));
  checkTrue('运算号丢掉（\\cdot 不是符号）', !T.extractMathSymbols('\\alpha \\cdot x^2').some(s => s === '\\cdot'));
  checkTrue('空输入返回空数组', Array.isArray(T.extractMathSymbols('')) && T.extractMathSymbols('').length === 0);

  // ② 索引汇总：用真实回包结构（含 split 的 parts、块级 latex、行内表）
  T.setVisionStructure({
    '5': {
      version: 2,
      fixes: '拆出公式(3)(4)(5)',
      segments: [
        { index: 4, type: 'formula', latex: 'E = \\mathit{ID}(Y, D) = YPD', inline: [{ find: 'D ∈ R', latex: 'D \\in \\mathbb{R}^{M \\times C}' }] },
        {
          index: 6,
          type: 'split',
          parts: [
            { type: 'body' },
            { type: 'formula', at: 'V = AttID', latex: "V' = \\mathit{AttID}(Q, K, V, Y \\mid D)" }
          ]
        }
      ]
    },
    '6': { version: 2, segments: [{ index: 2, type: 'formula', latex: 'Y = \\mathrm{softmax}(PL_D)' }] }
  });
  const idx = T.buildMathIndex();
  checkTrue('索引收集到全部公式（含 parts 里的公式片）', idx.formulas.length === 4, `${idx.formulas.length} 条`);
  checkTrue('每条公式都带页码', idx.formulas.every(f => Number.isFinite(f.page)));
  checkTrue('同一条 latex 不重复收录', new Set(idx.formulas.map(f => f.tex)).size === idx.formulas.length);
  const ySym = idx.symbols.find(s => s.name === 'Y');
  checkTrue('符号统计出现次数与首次出现页', !!ySym && ySym.count >= 2 && ySym.firstPage === 5, ySym ? `Y ×${ySym.count} 首现 p${ySym.firstPage}` : '缺 Y');
  checkTrue('符号表按出现次数降序（常用的排前面）', idx.symbols.length > 1 && idx.symbols[0].count >= idx.symbols[idx.symbols.length - 1].count);
  checkTrue('垮页公式都能索引到（第 6 页那条也在）', idx.formulas.some(f => f.page === 6));
  // 缓存与失效
  checkTrue('重复调用走缓存（同一份数据）', T.buildMathIndex() === idx);
  T.setVisionStructure({});
  checkTrue('换了回包后索引会失效重算', T.buildMathIndex().formulas.length === 0);
  T.setVisionStructure({});
})();

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 || loadError ? 1 : 0);