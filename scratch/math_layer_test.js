/**
 * 数学层回归测试（1.4.0 引入）。
 *
 * 【它守的是什么】用户原话："公式或者符号识别不准确，老是会有残渣和正文其余字体混淆在一起"。
 * 这套测试把**真实 PDF 的真实 item**（含真实字体名与坐标）喂给 viewer.js 里的数学层，
 * 断言抽出来的 LaTeX 与页面上真正印的公式一致；同时守一批"踩过的坑"：
 *
 *   R1 纯函数：上下标、帽子、嵌套上下标、希腊字母、空白规范化
 *   R2 字体族判别：CMMI/CMSY/CMR/CMEX/MSBM/CambriaMath 是数学；正文字体绝不能误判
 *   R3 真实页面（cycle/AOT/STM 的原始页）：逐条断言 LaTeX 完全相等
 *   R4 跨行不粘连：同一条公式里所有字形的基线跨度必须 ≤0.9×字号
 *      （曾经把相邻两行的 `X^{t-1}` 与上一行的 `X` 粘成 `X_{Xtt-1}`）
 *   R5 全量：三篇论文每一页的每一条公式都能被 KaTeX 渲染、没有空式子
 *   R6 正文不被吞：正文行里没有数学字体时，数学层必须产出 0 条公式
 *
 * 用法：node scratch/math_layer_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const katex = require(path.join(__dirname, '..', 'media', 'katex', 'katex.min.js'));

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  ❌ ${label}${extra ? `   ${extra}` : ''}`);
  }
}
const eq = (label, actual, expected) => check(label, actual === expected, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);

// ---------------------------------------------------------------- 抽数学层
const start = code.indexOf('  const MATH_FONT_RE');
const end = code.indexOf('  // ====================== 核心：学术文献双栏高保真版面解析器');
if (start < 0 || end < 0) {
  console.error('❌ viewer.js 里找不到数学层（锚点失效）');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const ML = new Function(`${code.slice(start, end)}
  return { isMathFontName, mathCharToLatex, mathItemsToLatex, buildPageMathModel, findMathRegions, MATH_FONT_RE };`)();

/*
 * 公式裁图矩形（1.6.15 引入）：把 span 的 CSS px 盒子并成 PDF 点坐标的裁图框。
 * 单独按锚点抽出来跑——它守的是"卡片里显示的公式是不是**恰好那块**区域"：
 * 上标探出字形盒必须算进来，坏数据不能污染并集，越界必须裁到页面内。
 */
const cropStart = code.indexOf('  function formulaCropPdfRect(');
const cropEnd = code.indexOf('  /** 3× PDF 点', cropStart);
if (cropStart < 0 || cropEnd < 0 || cropEnd <= cropStart) {
  console.error('❌ viewer.js 里找不到 formulaCropPdfRect（锚点失效）');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const CROP = new Function(`${code.slice(cropStart, cropEnd)}
  return { formulaCropPdfRect, formulaCropRectFromMathRuns };`)();

/*
 * pdf.js 3.11 把 span 定位写成 `calc(var(--scale-factor)*48.00px)`，
 * 直接 parseFloat 会得到 NaN —— 实测这会让整条裁图功能**静默失效**（一条都裁不出来）。
 */
const lenStart = code.indexOf('  function cssLenToPx(');
const lenEnd = code.indexOf('  function spanBoxesOf(', lenStart);
if (lenStart < 0 || lenEnd < 0 || lenEnd <= lenStart) {
  console.error('❌ viewer.js 里找不到 cssLenToPx（锚点失效）');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const CSSLEN = new Function(`${code.slice(lenStart, lenEnd)}
  return { cssLenToPx };`)();

/*
 * 拆分切点保护：切点落在公式内部时必须挪到公式边界，不能把式子劈成两半。
 */
const snapStart = code.indexOf('  function snapCutOutsideMath(');
let snapEnd = -1;
{
  let depth = 0;
  for (let i = snapStart; i >= 0 && i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { snapEnd = i + 1; break; }
    }
  }
}
if (snapStart < 0 || snapEnd < 0) {
  console.error('❌ viewer.js 里找不到 snapCutOutsideMath（锚点失效）');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const SNAP = new Function(`${code.slice(snapStart, snapEnd)}
  return { snapCutOutsideMath };`)();

const mk = (str, x, y, size, width, font) => ({
  str, width, height: size, transform: [size, 0, 0, size, x, y], fontName: font
});
const latexOf = items => ML.mathItemsToLatex(items);

console.log('===== R1 纯函数：上下标 / 帽子 / 嵌套 =====');
{
  // `X` + 下标 `t−1`（cycle 第 4 页真实坐标）
  const x1 = [
    mk('X', 383.208, 538.364, 10, 7.106, 'CMSY10'),
    mk('t', 390.314, 536.870, 7, 3.055, 'CMMI7'),
    mk('−', 393.300, 536.870, 7, 6.209, 'CMSY7'),
    mk('1', 399.600, 536.870, 7, 3.969, 'CMR7')
  ];
  eq('X 带下标 t−1', latexOf(x1), 'X_{t-1}');

  // `Ŷ`（Y + 零宽组合抑扬符）+ 下标 t
  const y1 = [
    mk('Y', 172.989, 525.164, 10, 6.658, 'CMMI10'),
    mk('̂', 174.790, 527.682, 10, 0, 'CMEX10'),
    mk('t', 179.647, 523.669, 7, 3.010, 'CMMI7')
  ];
  eq('Ŷ 带下标 t', latexOf(y1), '\\hat{Y}_{t}');

  // 上标（`X^{N}`）
  const sup = [mk('X', 100, 500, 10, 7, 'CMMI10'), mk('N', 107, 503, 7, 5, 'CMMI7')];
  eq('X 带上标 N', latexOf(sup), 'X^{N}');

  // 希腊字母 + 下标
  eq('S_θ', latexOf([mk('S', 100, 500, 10, 6, 'CMSY10'), mk('θ', 106, 498, 7, 4, 'CMMI7')]), 'S_{\\theta}');
  eq('∈ 映射', latexOf([mk('∈', 100, 500, 10, 6, 'CMSY10')]), '\\in');
  eq('⋃ 映射', latexOf([mk('⋃', 100, 500, 10, 8, 'CMEX10')]), '\\bigcup');

  // 集合记号（`{X_1}`）：`{` 是 CMSY10、`1` 是 CMR7
  eq(
    '集合 {X_1}',
    latexOf([
      mk('{', 131.897, 525.164, 10, 4.981, 'CMSY10'),
      mk('X', 136.879, 525.164, 10, 8.253, 'CMMI10'),
      mk('1', 145.133, 523.669, 7, 3.972, 'CMR7'),
      mk('}', 148.640, 525.164, 10, 4.981, 'CMSY10')
    ]),
    '\\{X_{1}\\}'
  );

  // 空白规范化：`max (` 不留空格；`1.3 \times 480p` 不留空格
  eq('max( 前不留空格', latexOf([mk('max', 100, 500, 10, 18, 'CMR10'), mk('(', 118, 500, 10, 4, 'CMR10'), mk('Y', 122, 500, 10, 6, 'CMMI10')]), 'max(Y');
  eq('1.3×480p 不留空格', latexOf([
    mk('1', 100, 500, 10, 4, 'CMR10'),
    mk('.', 104, 500, 10, 2, 'CMR10'),
    mk('3', 106, 500, 10, 4, 'CMR10'),
    mk('×', 112, 500, 10, 7, 'CMSY10'),
    mk('480', 119, 500, 10, 14, 'CMR10'),
    mk('p', 133, 500, 10, 5, 'CMR10')
  ]), '1.3\\times 480p');

  /*
   * 编码不可信的片段必须整条丢掉。
   * 实测 STM.pdf 第 4 页：CambriaMath 的 ToUnicode 表坏了，`H×W×C` 被解成 `H×美元符×百分号`、
   * `v^Q` 被解成 `+^*`（PyMuPDF 读出来也是同样的乱码）。
   * 这种式子"看着像公式、内容全错"，渲染出来比不显示更危险 → 必须返回空串。
   */
  eq(
    '含美元符/百分号的乱码片段不成公式',
    latexOf([mk('H', 100, 500, 10, 7, 'CambriaMath'), mk('\u00d7', 107, 500, 10, 7, 'CMSY10'), mk('\u0024', 114, 500, 10, 7, 'CambriaMath')]),
    ''
  );
  eq(
    '含 +* 这种"算子紧跟上标符"的乱码片段不成公式',
    latexOf([mk('+', 100, 500, 10, 7, 'CambriaMath'), mk('*', 107, 500, 10, 7, 'CambriaMath')]),
    ''
  );

  /*
   * 主级字形混排时，主行基线必须按"字形最多的那一行"投票，不能取 max(y)。
   * 实测 AOT 第 5 页真实坐标：`D ∈ R^{M×C}` 的主体 `D∈R` 在 y=562.69，
   * 指数 `M×C` 也是主级字号（9.96pt）但基线更高（y=566.31）。
   * 早先取 max(y) 会把主行定到指数那一行，整条式子主语倒置成 `M_{D∈R}×C`。
   */
  eq(
    '两个主级基线时主行取"字形最多的一行"',
    latexOf([
      mk('D', 132.92, 562.69, 10, 8.25, 'CMMI10'),
      mk('∈', 144.42, 562.69, 10, 6.64, 'CMSY10'),
      mk('R', 154.03, 562.69, 10, 7.19, 'MSBM10'),
      mk('M', 161.22, 566.31, 10, 7.60, 'CMMI10'),
      mk('×', 169.57, 566.31, 10, 6.23, 'CMSY10'),
      mk('C', 175.80, 566.31, 10, 5.71, 'CMMI10')
    ]),
    'D\\in R^{M\\times C}'
  );

  /*
   * 相邻但**基线不同**的字形不能当"同主行相邻"拼上去，必须走上下标判定。
   * 这条与上一条是同一个 bug 的两面：`R`(y=562.69) 与 `M`(y=566.31) 的横向间隙是 0。
   */
  eq(
    '横向紧邻但基线更高的字形是上标（不是主行字形）',
    latexOf([mk('R', 100, 500, 10, 7.19, 'MSBM10'), mk('M', 107.19, 503.62, 10, 7.60, 'CMMI10')]),
    'R^{M}'
  );

  /*
   * 撇号 `′`（U+2032）：它是"上一层的撇"，**不是下标**。
   * 实测 AOT 第 5 页真实坐标（V 9.96pt / 撇是 CMSY7 的 6.97pt 小号、基线高 4.1pt）：
   * 早先版本把撇判成上下标候选，后面的 `_{V=AttID(...)}` 就挂到了撇身上，
   * 转出 `'_{V=AttID(...)}` 这种"KaTeX 能渲染、肉眼很难发现"的错式子。
   */
  eq(
    'V′ 的撇不是下标（真实 AOT 坐标）',
    latexOf([
      mk('V', 141.22, 425.35, 10, 5.81, 'CMMI10'),
      mk('′', 149.24, 429.46, 7, 2.30, 'CMSY7'),
      mk('=', 154.80, 425.35, 10, 7.75, 'CMR10'),
      mk('AttID', 165.32, 425.35, 10, 28.08, 'CMMI10'),
      mk('(', 193.67, 425.35, 10, 3.87, 'CMR10'),
      mk('Q', 197.55, 425.35, 10, 5.00, 'CMMI10')
    ]),
    "V'=AttID(Q"
  );

  // 质量闸门：只有标点/帽子 → 判成空，不给卡片留"孤零零的等号"
  eq('孤立 = 不成公式', latexOf([mk('=', 100, 500, 10, 7, 'CMR10')]), '');
  eq('孤立帽子不成公式', latexOf([mk('̂', 100, 500, 10, 0, 'CMEX10')]), '');
  check('孤立 ∑ 保留（它本身有实义）', latexOf([mk('∑', 100, 500, 10, 9, 'CMEX10')]) === '\\sum');
}

console.log('\n===== R2 字体族判别 =====');
{
  const mathFonts = ['CMMI10', 'CMSY7', 'CMR10', 'CMEX10', 'CMBX10', 'MSAM10', 'MSBM10', 'CambriaMath', 'LatinModernMath', 'STIXTwoMath', 'QZLXPR+CMSY10', 'KTXECX+CMMI7', 'GAWYEP+CMEX10'];
  const bodyFonts = ['CAQTEU+NimbusRomNo9L-Regu', 'NimbusRomNo9L-Medi', 'NimbusRomNo9L-ReguItal', 'Calibri', 'Times-Roman', 'DengXian-Regular', 'Arial', 'Helvetica', 'SFTT1000', 'g_d0_f1', ''];
  mathFonts.forEach(f => check(`数学字体 ${f}`, ML.isMathFontName(f) === true));
  bodyFonts.forEach(f => check(`正文字体 ${f} 不误判`, ML.isMathFontName(f) === false, `isMathFontName(${JSON.stringify(f)}) = ${ML.isMathFontName(f)}`));
}

console.log('\n===== R3/R4/R5/R6 真实 PDF（cycle / AOT / STM） =====');
/*
 * 论文先找仓库里的 test-papers/（随仓库走，换机器也能跑），
 * 找不到再退回作者本机原来的绝对路径（那些文件可能已被移走）。
 */
const LEGACY_DIR = 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验';
const PAPERS = {};
for (const name of ['cycle', 'AOT', 'STM']) {
  const local = path.join(ROOT, 'test-papers', `${name}.pdf`);
  PAPERS[name] = fs.existsSync(local) ? local : path.join(LEGACY_DIR, `${name}.pdf`);
}

/** 逐页跑数学层；返回 { runs: [{page, latex, items}], model } */
async function scan(paper, pages) {
  const data = new Uint8Array(fs.readFileSync(PAPERS[paper]));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
  const out = [];
  const list = pages || Array.from({ length: doc.numPages }, (_, i) => i + 1);
  for (const pg of list) {
    const page = await doc.getPage(pg);
    const tc = await page.getTextContent();
    await page.getOperatorList();
    const cache = new Map();
    const fontNameOf = k => {
      if (cache.has(k)) return cache.get(k);
      let n = String(k);
      try {
        const f = page.commonObjs.get(k);
        if (f && f.name) n = f.name;
      } catch { /* 保持 loadedName */ }
      cache.set(k, n);
      return n;
    };
    const model = ML.buildPageMathModel(tc.items, fontNameOf, 10);
    model.runs.forEach(r => out.push({ page: pg, latex: r.latex, items: r.items }));
  }
  return out;
}

(async () => {
  // R3：真实页面的逐条断言（用户反馈最集中的 cycle 第 4 页）
  const p4 = await scan('cycle', [4]);
  const latexes = p4.map(r => r.latex);
  const want = ['X_{t-1}=\\{X_{1}\\}', 'Y_{t-1}=\\{Y_{1}\\}'];
  want.forEach(w => check(`cycle p4 含 ${w}`, latexes.includes(w), latexes.slice(0, 12).join(' | ')));
  // `Ŷ_t` 常常与后面的 `={Y_t}` 连成一条，所以用前缀匹配而不是全等
  check('cycle p4 含 Ŷ_t 相关公式', latexes.some(t => t.startsWith('\\hat{Y}_{t}')), latexes.slice(0, 12).join(' | '));
  check('cycle p4 含 X̂_t 相关公式', latexes.some(t => t.startsWith('\\hat{X}_{t}')), latexes.slice(0, 12).join(' | '));

  // R4：跨行不粘连（同一条公式的基线跨度不能接近"两行"）
  const all = [];
  for (const paper of Object.keys(PAPERS)) {
    const runs = await scan(paper);
    runs.forEach(r => all.push({ paper, ...r }));
  }
  /*
   * 阈值取 1.5×字号：合法的上下标最大偏移约 1.2×字号
   * （`⋃` 的上下限离主体 7.5pt、字号 10pt），而"两行正文"的基线差 ≥12pt。
   * 早期取 0.9×字号会把合法的 `t_{1}`（下标比主体低 1.5pt）+ 帽子这类判成跨行。
   */
  let crossRow = 0;
  all.forEach(r => {
    const sizes = r.items.map(i => i.size);
    const size = Math.max(...sizes);
    const ys = r.items.map(i => i.y);
    const span = Math.max(...ys) - Math.min(...ys);
    if (span > size * 1.5) {
      crossRow++;
      console.log(`  ⚠️ 跨行可疑 ${r.paper} p${r.page}: ${r.latex}  (y 跨度 ${span.toFixed(1)} > ${(size * 1.5).toFixed(1)})  ${r.items.map(i => i.str).join(' ')}`);
    }
  });
  check('没有"跨行粘连"的公式（基线跨度 ≤1.5×字号）', crossRow === 0, `${crossRow} 条可疑`);

  // R5：全量 KaTeX 可渲染 + 无空式子
  let empty = 0;
  let katexErr = 0;
  const badSamples = [];
  all.forEach(r => {
    const tex = String(r.latex || '').trim();
    if (!tex) { empty++; return; }
    let html = '';
    try {
      html = katex.renderToString(tex, { displayMode: false, throwOnError: false, strict: false, output: 'html' });
    } catch (e) {
      katexErr++;
      if (badSamples.length < 5) badSamples.push(`${r.paper} p${r.page} ${tex} (throw)`);
      return;
    }
    if (/katex-error/.test(html)) {
      katexErr++;
      if (badSamples.length < 5) badSamples.push(`${r.paper} p${r.page} ${tex}`);
    }
  });
  check(`全库 ${all.length} 条公式没有空式子`, empty === 0, `${empty} 条空`);
  check('全库公式都能被 KaTeX 渲染', katexErr === 0, badSamples.join(' | '));
  check('公式数量级正常（>400 条，说明确实在抽而不是全丢）', all.length > 400, `实际 ${all.length}`);

  // R6：纯正文页（无公式的页/行）数学层不产出公式
  const p1 = await scan('cycle', [1]);
  const proseOnly = p1.filter(r => /^[A-Za-z ,.:;()\-]+$/.test(r.items.map(i => i.str).join('')) && r.items.every(i => /NimbusRom|Calibri|Times/.test(i.font)));
  check('正文（非数学字体）不会被吞成公式', proseOnly.length === 0, `${proseOnly.length} 条`);

  // R7：公式与正文分段的几何判据（findMathRegions 只认强数学信号）
  const seg1 = ML.findMathRegions('where Y ∈ {0,1} and the mask is used');
  check('findMathRegions 能在一句正文里圈出公式', seg1.length === 1 && seg1[0].latex.includes('\\in'), JSON.stringify(seg1));
  const seg2 = ML.findMathRegions('a 2-fold increase, 3 times faster');
  check('findMathRegions 不把普通数字当公式', seg2.length === 0, JSON.stringify(seg2));

  // R8：公式卡片裁图矩形（formulaCropPdfRect）
  // 真实几何：pdf.js 文本层把 span 写成相对页面左上角的 CSS px（已乘 currentScale），
  // 除以 scale 才是 PDF 点；下面的数字按 AOT 那类 612×792 页面取的量级。
  {
    const near = (a, b, tol = 0.01) => Number.isFinite(a) && Math.abs(a - b) <= tol;
    const r1 = CROP.formulaCropPdfRect(
      [
        { left: 100, top: 200, width: 40, height: 12 },
        { left: 142, top: 201, width: 30, height: 10 },
      ],
      1.25, 3, 2, 612, 792,
    );
    check(
      '裁图矩形：同排两个 span 并成一块（含左右留白）',
      r1 && near(r1.x0, 77) && near(r1.x1, 140.6) && near(r1.y0, 158) && near(r1.y1, 171.6),
      JSON.stringify(r1),
    );

    // 上标在字形盒**上方**：必须被并进来，否则裁出来的式子会缺上标
    const r2 = CROP.formulaCropPdfRect(
      [
        { left: 100, top: 200, width: 40, height: 12 },
        { left: 140, top: 195, width: 10, height: 6 },
      ],
      1.25, 3, 2, 612, 792,
    );
    check('裁图矩形：上标（探出上方）被算进来', r2 && near(r2.y0, 195 / 1.25 - 2), JSON.stringify(r2));

    // 坏数据（NaN / 零宽）不能污染并集
    const r3 = CROP.formulaCropPdfRect(
      [
        { left: NaN, top: 10, width: 5, height: 5 },
        { left: 10, top: 10, width: 0, height: 5 },
        { left: 20, top: 20, width: 10, height: 10 },
      ],
      1, 0, 0, 612, 792,
    );
    check('裁图矩形：坏 span 被跳过，只按有效 span 计算', r3 && near(r3.x0, 20) && near(r3.y0, 20), JSON.stringify(r3));

    check('裁图矩形：全是坏数据时返回 null', CROP.formulaCropPdfRect([{ left: NaN }], 1, 0, 0, 612, 792) === null);

    // 越界必须裁到页面内（否则 drawImage 会取到画布外，得到一块空白）
    const r4 = CROP.formulaCropPdfRect([{ left: 2, top: 2, width: 10, height: 10 }], 1, 3, 2, 612, 792);
    check('裁图矩形：左/上越界被夹到 0', r4 && r4.x0 === 0 && r4.y0 === 0, JSON.stringify(r4));

    // 太小的框没有意义（还不如让 KaTeX 兜底）
    check('裁图矩形：小于 2pt 的框返回 null', CROP.formulaCropPdfRect([{ left: 10, top: 10, width: 1, height: 1 }], 1, 0, 0, 612, 792) === null);

    // scale 非法（0 / NaN）时退回 1，绝不能除以 0 得到 Infinity
    const r5 = CROP.formulaCropPdfRect([{ left: 100, top: 100, width: 10, height: 10 }], 0, 0, 0, 612, 792);
    check('裁图矩形：scale=0 不产生 Infinity', r5 && near(r5.x0, 100) && near(r5.x1, 110), JSON.stringify(r5));

    // pdf.js 3.11 的 calc(var(--scale-factor)*Npx) 必须能读出来（否则裁图静默失效）
    check(
      'css 长度：calc(var(--scale-factor)*48px) 按 1.25 倍读出 60',
      CSSLEN.cssLenToPx('calc(var(--scale-factor)*48.00px)', 1.25) === 60,
      String(CSSLEN.cssLenToPx('calc(var(--scale-factor)*48.00px)', 1.25)),
    );
    check('css 长度：普通 48px 不乘 scale', CSSLEN.cssLenToPx('48.00px', 1.25) === 48);
    check('css 长度：空值/无 px 返回 NaN', Number.isNaN(CSSLEN.cssLenToPx('', 1)) && Number.isNaN(CSSLEN.cssLenToPx('12', 1)));
  }

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
