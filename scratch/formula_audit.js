/**
 * 公式渲染审计（素材全部来自用户本机存档，0 次 API）。
 *
 * 【为什么要它】用户反馈"段落内的公式提取不完整导致 latex 渲染失败"。
 * 这条链路完全能在本机复原，不必猜：
 *   ① `pageArchive[page]`     —— 本地切出来的**原件**段落（视觉手术永远在它上面重放）；
 *   ② `visionStructure[page]` —— 视觉模型的真实回包（type/order/parts/inline/latex）；
 *   ③ 真实的 `visionSurgery` / `renderEnTextHtml` / `renderVisionMathHtml` / `renderMathSpan`
 *      （从 media/viewer.js 抽出来），并且用**真的 KaTeX**（media/katex/katex.min.js）。
 * 于是"渲染失败"有了可验证的定义：渲染出来的 HTML 里出现 `katex-error`
 * （KaTeX 在 throwOnError:false 时会渲染成一块红色的报错文本，用户看到的就是这个）。
 *
 * 三类问题：
 *   F1 界面上出现 katex-error（LaTeX 被 KaTeX 拒绝）；
 *   F2 该是公式的段落没拿到 latex（visionLatex 为空）→ 公式整条不渲染；
 *   F3 渲染后仍残留裸组合符（帽子没有基字母）→ 界面上一个漂着的重音符。
 *
 * 用法：
 *   node scratch/formula_audit.js                  # 扫全部存档
 *   node scratch/formula_audit.js --file cycle     # 只看某一篇
 *   node scratch/formula_audit.js --verbose        # 打印全部条目
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// VIEWER_SRC 指向另一份 viewer.js（如 git show HEAD:media/viewer.js）可做 before/after 对照
const code = fs.readFileSync(process.env.VIEWER_SRC || path.join(ROOT, 'media', 'viewer.js'), 'utf8');

const argv = process.argv.slice(2);
const argOf = n => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const onlyFile = argOf('--file');
const verbose = argv.includes('--verbose');

// ---------- 真 KaTeX（renderMathSpan 读的是 window.katex） ----------
let katex = null;
try {
  katex = require(path.join(ROOT, 'media', 'katex', 'katex.min.js'));
  global.window = { katex };
} catch (e) {
  console.log(`（提示：没能加载本地 KaTeX，F1 只能跳过：${e.message}）`);
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 抽一个顶层 function 声明 */
function extractFn(name) {
  const start = code.indexOf(`  function ${name}(`);
  const end = code.indexOf('\n  }', start);
  if (start < 0 || end < 0) throw new Error(`抽不到 ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function('escapeHtml', `${code.slice(start, end + 4)}\n return ${name};`)(esc);
}

const renderMathSpan = (() => {
  // renderMathSpan 依赖 decodeMathEntities（紧邻其上的小函数）；旧版没有它 → 兼容两种
  const dec = code.indexOf('  function decodeMathEntities(tex) {');
  const rs = code.indexOf('  function renderMathSpan(tex, displayMode) {');
  const re = code.indexOf('\n  }', rs);
  if (rs < 0 || re < 0) throw new Error('抽不到 renderMathSpan');
  const body = dec >= 0 && dec < rs ? `${code.slice(dec, rs)}\n ${code.slice(rs, re + 4)}` : code.slice(rs, re + 4);
  // eslint-disable-next-line no-new-func
  return new Function('escapeHtml', `${body}\n return renderMathSpan;`)(esc);
})();
const splitEnglishSentencesSmart = extractFn('splitEnglishSentencesSmart');

/** 手术片段（normalizeVisionType → applyVisionSegments 之前）+ 渲染片段（RESIDUE_HAT_RE 起） */
function extractApi() {
  const surgStart = code.indexOf('  function normalizeVisionType(t) {');
  const surgEnd = code.indexOf('  function applyVisionSegments(pageNum, result) {');
  const htmlStart = code.indexOf('  const RESIDUE_HAT_RE');
  const htmlEnd = code.indexOf('\n  function renderInlineMarkdown(');
  if (surgStart < 0 || surgEnd < 0 || htmlStart < 0 || htmlEnd < 0) throw new Error('viewer.js 抽片锚点失效');
  // eslint-disable-next-line no-new-func
  return new Function(
    'splitEnglishSentencesSmart',
    'escapeHtml',
    'renderMathSpan',
    'console',
    `${code.slice(surgStart, surgEnd)}
     ${code.slice(htmlStart, htmlEnd)}
     // 修复前的版本没有 renderVisionMathHtml（latex 直接进 KaTeX）→ 用等价的朴素实现兜底，
     // 这样同一份审计也能对"修复前"的产物跑 before/after 对照。
     const visionMath = typeof renderVisionMathHtml === 'function'
       ? renderVisionMathHtml
       : (tex, display) => renderMathSpan(String(tex == null ? '' : tex).trim(), display);
     return { visionSurgery, renderEnTextHtml, renderVisionMathHtml: visionMath };`
  )(splitEnglishSentencesSmart, esc, renderMathSpan, { log() {}, warn() {}, error() {} });
}
const API = extractApi();

// ---------- 读本机存档 ----------
function storeDirs() {
  const dirs = [];
  const add = p => {
    try {
      if (p && fs.existsSync(p)) dirs.push(p);
    } catch (e) {
      /* 忽略 */
    }
  };
  [
    ['Code', 'User'],
    ['Code - Insiders', 'User'],
    ['Antigravity', 'User']
  ].forEach(([app, user]) =>
    add(path.join(process.env.APPDATA || '', app, user, 'globalStorage', 'paper-reader.academic-pdf-reader'))
  );
  add(path.join(process.env.USERPROFILE || '', '.antigravity', 'globalStorage', 'paper-reader.academic-pdf-reader'));
  return dirs;
}

const MARK = /[\u0302\u0303]/;
const files = [];
storeDirs().forEach(d =>
  fs.readdirSync(d).forEach(f => {
    if (f.startsWith('paper_') && f.endsWith('.json')) files.push(path.join(d, f));
  })
);
if (files.length === 0) {
  console.log('本机没有找到扩展存档（globalStorage）');
  process.exit(0);
}

const found = { F1: [], F2: [], F3: [], F4: [] };
let totalPages = 0;
let totalParas = 0;
let totalTex = 0;

files.forEach(fp => {
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const name = path.basename(j.pdfPath || j.pdfName || fp);
  if (onlyFile && !name.includes(onlyFile)) return;
  const vs = j.visionStructure || {};
  const pages = Object.keys(vs);
  if (pages.length === 0) return;

  pages.forEach(pg => {
    const result = vs[pg];
    const local = j.pageArchive && j.pageArchive[pg];
    if (!result || !local) return;
    totalPages++;
    const list = (Array.isArray(local) ? local : Object.values(local)).map(p => JSON.parse(JSON.stringify(p)));
    API.visionSurgery(list, result);

    list.forEach(p => {
      totalParas++;
      const text = String(p.cleanText || '');
      const inlineList = Array.isArray(p.visionInline) ? p.visionInline : [];
      totalTex += inlineList.filter(it => it && it.latex).length + (String(p.visionLatex || '').trim() ? 1 : 0);

      // F1：走**真实渲染入口**，看输出的 HTML 里有没有 KaTeX 报错块。
      // 公式卡片：renderVisionMathHtml(visionLatex, true)；正文：renderEnTextHtml（含行内替换表）
      const htmlEn = API.renderEnTextHtml(text, p.visionInline);
      if (/katex-error/.test(htmlEn)) {
        const bad = inlineList.filter(it => it && it.latex && /katex-error/.test(renderMathSpan(it.latex, false)));
        found.F1.push({
          name,
          pg,
          id: p.id,
          kind: 'inline',
          tex: bad.map(b => b.latex).join(' | '),
          find: bad.map(b => b.find).join(' | '),
          html: htmlEn
        });
      }
      if (String(p.visionLatex || '').trim()) {
        const htmlTex = API.renderVisionMathHtml(p.visionLatex, true);
        if (/katex-error/.test(htmlTex)) {
          found.F1.push({ name, pg, id: p.id, kind: 'visionLatex', tex: p.visionLatex, html: htmlTex });
        }
      }

      // F4：译文侧被替换表**切坏**——公式 span 后面直接吊着 `}` 或 `^{...}`。
      // 真实成因：替换区间按 find.length 取，而命中片段是归一化匹配、长度往往更短，
      // 多吃的字符正好是后面那个上标的 `^{`（实测 AOT 第 5 页中文译文）。
      const zhList = [];
      if (p.translation) zhList.push(['pageArchive.translation', String(p.translation)]);
      (Array.isArray(p.sentenceTranslations) ? p.sentenceTranslations : []).forEach((t, i) => {
        if (t) zhList.push([`pageArchive.sentenceTranslations[${i}]`, String(t)]);
      });
      zhList.forEach(([where, zh]) => {
        const html = API.renderEnTextHtml(zh, p.visionInline);
        const plain = html.replace(/<[^>]+>/g, '');
        // 切坏的签名：公式 span 后面吊着一个**多余的** `}`。原文里 `{ X 1 }` 那种是成对的，
        // 所以用"花括号不平衡 + span 后紧跟 }"两条一起判，避免把正常公式误报成切坏。
        const open = (plain.match(/\{/g) || []).length;
        const close = (plain.match(/\}/g) || []).length;
        if (close > open && /<\/span>\s*\}/.test(html)) {
          found.F4.push({ name, pg, id: p.id, where, zh, tail: '}', html: plain });
        }
      });

      // F2：公式段落没拿到 latex
      if (p.type === 'formula' && !String(p.visionLatex || '').trim()) {
        found.F2.push({ name, pg, id: p.id, text });
      }

      // F3：渲染后仍残留裸组合符
      if (p.type !== 'formula' && MARK.test(text)) {
        const plain = htmlEn.replace(/<[^>]+>/g, '');
        if (MARK.test(plain)) {
          const idx = plain.search(MARK);
          found.F3.push({ name, pg, id: p.id, text, plain, orphan: !/[A-Za-z]/.test(text[idx - 1] || '') });
        }
      }
    });
  });
});

const show = (title, arr, fmt) => {
  console.log(`\n--- ${title}：${arr.length} 条 ---`);
  (verbose ? arr : arr.slice(0, 10)).forEach(x => console.log(fmt(x)));
  if (!verbose && arr.length > 10) console.log(`   …还有 ${arr.length - 10} 条（加 --verbose 看全部）`);
};

console.log('\n===== 汇总 =====');
console.log(`存档 ${files.length} 份；有视觉回包的页 ${totalPages}；手术后的段落 ${totalParas}；渲染过的 LaTeX ${totalTex} 条`);
console.log(`F1 界面出现 katex-error ${found.F1.length}；F2 公式段缺 latex ${found.F2.length}；F3 残留裸组合符 ${found.F3.length}；F4 译文被替换表切坏 ${found.F4.length}`);

show('F1 KaTeX 报错（用户看到的红字）', found.F1, x =>
  `[${x.name} p${x.pg}#${x.id} ${x.kind}] ${JSON.stringify(x.tex)}${x.find ? `  find=${JSON.stringify(x.find)}` : ''}`
);
show('F2 该是公式却没有 latex（整条不渲染）', found.F2, x => `[${x.name} p${x.pg}#${x.id}] ${x.text.slice(0, 90)}`);
show('F3 渲染后仍残留组合符', found.F3, x =>
  `[${x.name} p${x.pg}#${x.id}] 孤儿帽子=${x.orphan}\n     原文: ${x.text.slice(0, 110)}\n     渲染: ${x.plain.slice(0, 150)}`
);
show('F4 译文被替换表切坏（公式后面吊着 } 或 ^{）', found.F4, x =>
  `[${x.name} p${x.pg}#${x.id}] ${x.where} 尾巴=${JSON.stringify(x.tail)}\n     译文: ${x.zh.slice(0, 120)}\n     渲染: ${x.html.replace(/<[^>]+>/g, '').slice(0, 160)}`
);
