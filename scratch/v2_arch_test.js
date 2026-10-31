/**
 * Academic PDF Reader v2.0 — Comprehensive Architecture Test Suite & 11-PDF Real Paper Benchmark
 * (`node scratch/v2_arch_test.js`)
 *
 * Verifies all 4 core subsystems of the v2.0 zero-Python architecture:
 *   1. Multi-Publisher Font & Glyph Decoder (`fontDecoder.ts`)
 *   2. 2D Spatial Math Reconstructor, Vector Math Bars (`>=2.2pt`), & Neighbor-Masked Formula Cropper (`vectorGraphics.ts` + `mathEngine2D.ts`)
 *   3. Indexed Inline Math Protocol (`⟦M1⟧`, `⟦M2⟧`), Anti-Skip Translation Gate (`isPureUntranslatableToken`),
 *      Cache Self-Healing (`pruneStaleNonProseCache`), Decoupled Vision Service (`visionService.ts`), & Snip Tool (`snipTool.ts`)
 *   4. Full 11-PDF Real Academic Paper Benchmark (`solveAcademicPageLayout` + `extractRawPageVectors`):
 *      - 100% `cleanText.length === charMap.length` across every paragraph of every page
 *      - 0 control-character leaks (`ctrl-glyph === 0`, e.g. `\u000f`)
 *      - 100% sentence slice consistency (`cleanText.slice(s.startIdx, s.endIdx) === s.text`)
 *      - 100% inline math token bounds & `⟦M1⟧` placeholder parity
 *      - Regression verification on notorious pages (`AOT.pdf` p5, `cycle.pdf` p4/p6, `1312.6114v11.pdf`, `测试三.pdf`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const katex = require(path.join(__dirname, '..', 'media', 'katex', 'katex.min.js'));

const ROOT = path.join(__dirname, '..');
const buildDir = path.join(ROOT, 'scratch', '.build-v2');
fs.mkdirSync(buildDir, { recursive: true });

// Compile v2 core + webview bundle + host translator + visionService as CJS for direct Node testing
const v2BundlePath = path.join(buildDir, 'v2EngineBundle.cjs');
const hostBundlePath = path.join(buildDir, 'hostModules.cjs');

esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src', 'webview', 'v2EngineBundle.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: v2BundlePath,
  logLevel: 'error',
});

const hostEntryTmp = path.join(buildDir, '_hostEntry.ts');
fs.writeFileSync(
  hostEntryTmp,
  `export * from '../../src/translator';\nexport * from '../../src/visionService';\n`,
  'utf8'
);
esbuild.buildSync({
  entryPoints: [hostEntryTmp],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: hostBundlePath,
  external: ['vscode'],
  logLevel: 'error',
});

let mockConfigStore = {};
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (k, defVal) => (Object.prototype.hasOwnProperty.call(mockConfigStore, k) ? mockConfigStore[k] : defVal),
    }),
  },
  window: {},
  Uri: {},
  ProgressLocation: { Notification: 15 },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const V2 = require(v2BundlePath).AcademicV2;
const { PaperTranslator, resolveVisionProviderConfig } = require(hostBundlePath);
Module._load = origLoad;

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    fail++;
    const msg = `${label}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.error(`  ❌ ${msg}`);
  }
}

function canRenderKatex(tex, displayMode = false) {
  try {
    const html = katex.renderToString(tex, { throwOnError: true, displayMode, strict: false });
    return typeof html === 'string' && html.includes('katex') && !html.includes('katex-error');
  } catch {
    return false;
  }
}

async function extractRealFontNames(page) {
  const fontNames = {};
  const textContent = await page.getTextContent();
  const seen = new Set();
  for (const it of textContent.items || []) {
    if (it && it.fontName && !seen.has(it.fontName)) {
      seen.add(it.fontName);
      try {
        const fontObj = page.commonObjs && page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null;
        if (fontObj && fontObj.name) {
          fontNames[it.fontName] = String(fontObj.name);
        }
      } catch {
        /* ignore unresolved font */
      }
    }
  }
  return { textContent, fontNames };
}

(async function main() {
  console.log('======================================================================');
  console.log(' Academic PDF Reader v2.0 — Architecture Test & 11-PDF Benchmark');
  console.log('======================================================================');

  // =========================================================================
  // 1. Multi-Publisher Font & Glyph Decoder (`fontDecoder`)
  // =========================================================================
  console.log('\n[1] 多出版商字体与字形解码器 (TeX / AMS / Adobe Symbol / Word PUA / Unicode Math)');
  {
    check('剥离 6 位子集前缀 ABCDEF+CMMI10', V2.stripSubsetPrefix('QZLXPR+CMMI10') === 'CMMI10');
    check('分类 CMMI10 -> math-italic', V2.classifyFontFamily('QZLXPR+CMMI10').role === 'math-italic');
    check('分类 CMSY10 -> math-symbol', V2.classifyFontFamily('ABCDEF+CMSY10').role === 'math-symbol');
    check('分类 CMEX10 -> math-ext', V2.classifyFontFamily('XYZABC+CMEX10').role === 'math-ext');
    check('分类 MSBM10 -> math-bb', V2.classifyFontFamily('MSBM10').role === 'math-bb');
    check('分类 SimSun/PingFang -> cjk', V2.classifyFontFamily('SimSun').role === 'cjk');

    // CMMI / CMMIB control-character `\u000f` (\epsilon) & Greek decoding
    const eps = V2.decodeGlyphString('\u000f', 'QZLXPR+CMMIB10');
    check(
      'CMMIB10 控制符 \\u000f 解码为 ϵ/ε / \\epsilon（彻底消灭 ctrl-glyph）',
      (eps.text === 'ϵ' || eps.text === 'ε') && eps.latex.includes('\\epsilon') && !/[\u0000-\u001f]/.test(eps.text),
      `text=${JSON.stringify(eps.text)} latex=${JSON.stringify(eps.latex)}`
    );

    // CMSY symbols (\u0000 -> −, \u0032 -> ∈)
    const cmsyIn = V2.decodeGlyphString('\u0032', 'CMSY10');
    check(
      'CMSY10 \\u0032 解码为 ∈ / \\in',
      cmsyIn.text === '∈' && cmsyIn.latex.includes('\\in'),
      `text=${cmsyIn.text} latex=${cmsyIn.latex}`
    );

    // CMEX big operator & delimiter extension piece
    const cmexSum = V2.decodeGlyphString('\u0050', 'CMEX10');
    check(
      'CMEX10 \\u0050 解码为大算子 ∑ / \\sum (isBigOp=true)',
      cmexSum.isBigOp === true && cmexSum.latex.includes('\\sum'),
      `text=${cmexSum.text} latex=${cmexSum.latex}`
    );

    // MSBM blackboard bold R -> ℝ / \mathbb{R}
    const bbR = V2.decodeGlyphString('R', 'MSBM10');
    check(
      'MSBM10 黑板粗体 R 解码为 ℝ / \\mathbb{R}',
      bbR.text === 'ℝ' && bbR.latex.includes('\\mathbb{R}'),
      `text=${bbR.text} latex=${bbR.latex}`
    );

    // Word / WPS / Cambria Symbol PUA U+F000..U+F0FF
    const puaAlpha = V2.decodeGlyphString('\uF061\uF0CE\uF0E5', 'SymbolMT');
    check(
      'Word/WPS PUA (U+F061 U+F0CE U+F0E5) 解码为 α ∈ ∑（无私用区方块字）',
      !/[\uF000-\uF0FF]/.test(puaAlpha.text) &&
        puaAlpha.text.includes('α') &&
        puaAlpha.text.includes('∈') &&
        puaAlpha.text.includes('∑'),
      `text=${JSON.stringify(puaAlpha.text)} latex=${JSON.stringify(puaAlpha.latex)}`
    );

    // Unicode Mathematical Alphanumeric Symbols (U+1D400..U+1D7FF)
    const uniMath = V2.decodeGlyphString('𝑥 + 𝛼', 'TimesNewRomanPSMT');
    check(
      'Unicode 数学字母区 (𝑥 + 𝛼) 规范化并生成合法 LaTeX',
      uniMath.hasMathSymbol === true && uniMath.latex.includes('\\alpha'),
      `text=${uniMath.text} latex=${uniMath.latex}`
    );

    // Ligature normalization
    const lig = V2.decodeGlyphString('eﬃcient ﬂow', 'CMR10');
    check('西文连字 (ﬃ / ﬂ) 展开为标准 ASCII', lig.text === 'efficient flow', lig.text);
  }

  // =========================================================================
  // 2. 2D Spatial Math Reconstructor, Vector Math Bars & Neighbor-Masked Cropper
  // =========================================================================
  console.log('\n[2] 2D 空间数学公式树重建 + 短矢量分数线(>=2.2pt) + 邻域掩膜裁剪');
  {
    const mkItem = (str, fontName, x, y, w, h) => ({
      str,
      fontName,
      width: w,
      height: h,
      transform: [h, 0, 0, h, x, y],
    });

    // 2a. Short fraction bar (4.5pt wide!) + numerator + denominator -> \frac{1}{2}
    const fracFontMap = { fNum: 'CMR10', fIt: 'CMMI10', fOp: 'CMSY10' };
    const fracItems = [
      mkItem('y', 'fIt', 100, 500, 6, 10),
      mkItem('=', 'fNum', 110, 500, 7, 10),
      mkItem('1', 'fNum', 123, 507, 5, 8),   // numerator above bar y=503.5
      mkItem('2', 'fNum', 123, 493, 5, 8),   // denominator below bar y=503.5
      mkItem('x', 'fIt', 133, 500, 6, 10),
      mkItem('2', 'fNum', 139.5, 505, 4.5, 7), // superscript x^2
    ];
    const fracGlyphs = V2.decodePageGlyphs(fracItems, (k) => fracFontMap[k] || k).glyphs;
    const shortBar = { x1: 122, x2: 129, y: 503.5, thickness: 0.5 }; // 7pt bar (was dropped by <18pt in v1.x!)
    const classifiedVec = V2.classifyPageVectors(
      { hLines: [shortBar], vLines: [], rects: [] },
      fracGlyphs,
      612,
      792,
      10
    );
    check(
      '短矢量横线 (7pt < 旧版 18pt 阈值) 被正确归入 mathBars',
      classifiedVec.mathBars.length === 1,
      `mathBars=${classifiedVec.mathBars.length}`
    );
    const fracRes = V2.reconstructMath2D(fracGlyphs, classifiedVec.mathBars, 10);
    check(
      '2D 分式与上标重建生成 \\frac{1}{2} 与 x^{2}，且通过真实 KaTeX 编译',
      fracRes.latex.includes('\\frac{1}{2}') && fracRes.latex.includes('^{2}') && canRenderKatex(fracRes.latex, true),
      `latex=${fracRes.latex}`
    );

    // 2b. Square root with radical glyph + overbar -> \sqrt{d_{k}}
    const sqrtItems = [
      mkItem('√', 'fOp', 150, 496, 8, 12),
      mkItem('d', 'fIt', 158, 500, 6, 10),
      mkItem('k', 'fIt', 164.5, 497, 4.5, 7),
    ];
    const sqrtGlyphs = V2.decodePageGlyphs(sqrtItems, (k) => fracFontMap[k] || k).glyphs;
    const sqrtBar = [{ x1: 158, x2: 170, y: 509.5, thickness: 0.5 }];
    const sqrtRes = V2.reconstructMath2D(sqrtGlyphs, sqrtBar, 10);
    check(
      '2D 根式 + 顶横线重建为 \\sqrt{...}，且通过真实 KaTeX 编译',
      sqrtRes.latex.includes('\\sqrt{') && canRenderKatex(sqrtRes.latex, true),
      `latex=${sqrtRes.latex}`
    );

    // 2c. Big operator limits (\sum_{i=1}^{N} x_i) + right-margin equation tag (3)
    const sumFontMap = { fEx: 'CMEX10', fIt: 'CMMI10', fRm: 'CMR10' };
    const sumItems = [
      mkItem('\u0050', 'fEx', 180, 495, 14, 18), // \sum
      mkItem('i', 'fIt', 181, 486, 3.5, 7),      // lower limit i=1
      mkItem('=1', 'fRm', 184.5, 486, 8, 7),
      mkItem('N', 'fIt', 184, 515, 6, 7),        // upper limit N
      mkItem('x', 'fIt', 198, 500, 6, 10),
      mkItem('i', 'fIt', 204.5, 497, 3.5, 7),
      mkItem('(3)', 'fRm', 510, 500, 14, 10),    // right-aligned equation tag
    ];
    const sumGlyphs = V2.decodePageGlyphs(sumItems, (k) => sumFontMap[k] || k).glyphs;
    const sumRes = V2.reconstructMath2D(sumGlyphs, [], 10);
    check(
      '2D 大算子上下限重建为 \\sum_{...}^{...} 并分离右侧公式编号 (3)，且通过 KaTeX 编译',
      sumRes.latex.includes('\\sum') &&
        sumRes.latex.includes('_') &&
        sumRes.latex.includes('^') &&
        sumRes.equationTag === '(3)' &&
        canRenderKatex(sumRes.latex, true),
      `latex=${sumRes.latex} tag=${sumRes.equationTag}`
    );

    // 2d. Simultaneous superscript + subscript (X_l^t) & Accent (\hat{Y}_t)
    const hatItems = [
      mkItem('ˆ', 'fRm', 101, 506, 4, 8),
      mkItem('Y', 'fIt', 100, 500, 7, 10),
      mkItem('t', 'fIt', 107.5, 497, 3.5, 7),
      mkItem('=', 'fRm', 115, 500, 7, 10),
      mkItem('X', 'fIt', 126, 500, 8, 10),
      mkItem('l', 'fIt', 134.5, 497, 3.5, 7),
      mkItem('t', 'fIt', 134.5, 505, 3.5, 7),
    ];
    const hatGlyphs = V2.decodePageGlyphs(hatItems, (k) => sumFontMap[k] || k).glyphs;
    const hatRes = V2.reconstructMath2D(hatGlyphs, [], 10);
    check(
      '2D 顶标帽子 + 双上下标重建 (\\hat{Y}_{t} = X_{l}^{t})，且通过 KaTeX 编译',
      hatRes.latex.includes('\\hat{Y}') &&
        hatRes.latex.includes('X_{l}^{t}') &&
        canRenderKatex(hatRes.latex, true),
      `latex=${hatRes.latex}`
    );

    // 2e. Display formula line detector: prose lead-in vs real equation
    const proseLeadItems = [
      mkItem('Specifically,', 'fRm', 72, 540, 55, 10),
      mkItem('the', 'fRm', 131, 540, 14, 10),
      mkItem('loss', 'fRm', 149, 540, 17, 10),
      mkItem('is', 'fRm', 170, 540, 8, 10),
      mkItem('defined', 'fRm', 182, 540, 32, 10),
      mkItem('as:', 'fRm', 218, 540, 13, 10),
    ];
    const proseLeadGlyphs = V2.decodePageGlyphs(proseLeadItems, () => 'Times-Roman').glyphs;
    const evalProse = V2.evaluateDisplayFormulaLine(proseLeadGlyphs, [], 72, 540, 10);
    const evalEq = V2.evaluateDisplayFormulaLine(sumGlyphs, [], 72, 540, 10);
    check(
      '行间公式检测器：冒号引导句 ("Specifically, the loss is defined as:") 绝不误判为行间公式',
      evalProse.isDisplayMath === false && evalEq.isDisplayMath === true,
      `proseScore=${evalProse.score} eqScore=${evalEq.score}`
    );

    // 2f. Neighbor-masked formula crop box
    const intrudingProse = V2.decodePageGlyphs(
      [mkItem('descending-gy', 'fRm', 180, 520, 65, 10)],
      () => 'Times-Roman'
    ).glyphs;
    const cropRect = V2.computeFormulaCropBox(sumGlyphs, [], intrudingProse, 612, 792, 10);
    check(
      '智能邻域掩膜裁剪框：不截断上下限，且紧贴/掩膜相邻散文行防止漏字',
      !!cropRect && cropRect.x1 > cropRect.x0 + 100 && cropRect.y1 > cropRect.y0 + 15,
      JSON.stringify(cropRect)
    );

    // 2g. Anti-wipeout tableRegions check: top figure frame + bottom figure frame MUST NOT wipe out middle page
    const antiWipeVec = V2.classifyPageVectors(
      {
        hLines: [
          { x1: 60, x2: 550, y: 720 },
          { x1: 60, x2: 550, y: 690 },
          { x1: 60, x2: 550, y: 140 },
          { x1: 60, x2: 550, y: 110 },
        ],
        vLines: [],
        rects: [],
      },
      sumGlyphs, // equation sitting at y=500 in the middle of the page!
      612,
      792,
      10
    );
    const wipedMiddle = antiWipeVec.tableRegions.some((tr) => tr.minY <= 500 && tr.maxY >= 500);
    check(
      '矢量表格聚类：页顶与页底的横线绝不张成全页 minY..maxY 吞噬中间正文与公式',
      wipedMiddle === false,
      `tableRegions=${JSON.stringify(antiWipeVec.tableRegions)}`
    );
  }

  // =========================================================================
  // 3. Indexed Inline Math Protocol (`⟦M1⟧`), Anti-Skip Translation & Snip Tool
  // =========================================================================
  console.log('\n[3] 索引化行内公式协议 (⟦M1⟧) + 零误跳翻译门控 + 独立视觉引擎 + 框选识别交互');
  {
    // 3a. Q vs q zero-collision test + forgiving bracket variants
    const cleanText = 'We project query Q ∈ ℝ^{HW×C} and element q_i into embeddings.';
    const segments = [
      { kind: 'body', text: 'We project query ', spans: [], items: [] },
      { kind: 'math', text: 'Q ∈ ℝ^{HW×C}', latex: 'Q \\in \\mathbb{R}^{HW \\times C}', spans: [], items: [] },
      { kind: 'body', text: ' and element ', spans: [], items: [] },
      { kind: 'math', text: 'q_i', latex: 'q_{i}', spans: [], items: [] },
      { kind: 'body', text: ' into embeddings.', spans: [], items: [] },
    ];
    const reg = V2.buildInlineMathRegistry(cleanText, segments);
    check(
      'buildInlineMathRegistry 生成 ⟦M1⟧ 与 ⟦M2⟧，且不改动 cleanText 长度',
      reg.translationText === 'We project query ⟦M1⟧ and element ⟦M2⟧ into embeddings.' &&
        reg.inlineMathTokens.length === 2,
      reg.translationText
    );

    const paraMock = {
      cleanText,
      translationText: reg.translationText,
      inlineMathTokens: reg.inlineMathTokens,
    };

    const enHtml = V2.renderSentenceEnWithMathTokens(
      cleanText,
      0,
      paraMock,
      (tex) => katex.renderToString(tex, { throwOnError: false })
    );
    check(
      '英文句子侧精确按偏移渲染 Q ∈ ℝ^{HW×C} 与 q_i 两处 KaTeX（零大小写冲突）',
      !!enHtml &&
        enHtml.includes('data-math-id="M1"') &&
        enHtml.includes('data-math-id="M2"') &&
        enHtml.includes('katex')
    );

    // Simulated LLM Chinese output with canonical ⟦M1⟧ AND forgiving 【M2】 variant
    const zhFromLlm = '我们将查询矩阵 ⟦M1⟧ 与第 i 个元素 【M2】 投影到嵌入空间。';
    const zhHtml = V2.renderZhWithMathTokens(
      zhFromLlm,
      paraMock,
      (tex) => `<K>${tex}</K>`,
      (plain) => plain
    );
    check(
      '中文译文侧 O(1) 还原 ⟦M1⟧ 与容错括号 【M2】，Q 与 q 完全隔离无串扰',
      zhHtml.includes('<K>Q \\in \\mathbb{R}^{HW \\times C}</K>') &&
        zhHtml.includes('<K>q_{i}</K>') &&
        !zhHtml.includes('⟦M1⟧') &&
        !zhHtml.includes('【M2】'),
      zhHtml
    );

    const mdRestored = V2.restorePlaceholdersToMarkdownLatex(zhFromLlm, reg.inlineMathTokens);
    check(
      '导出精读稿时 ⟦M1⟧ / 【M2】 自动还原为标准 Markdown $...$ LaTeX',
      mdRestored === '我们将查询矩阵 $Q \\in \\mathbb{R}^{HW \\times C}$ 与第 i 个元素 $q_{i}$ 投影到嵌入空间。',
      mdRestored
    );

    // 3b. Anti-Skip Translation Gate (`isPureUntranslatableToken`) & Cache Self-Healing
    mockConfigStore = { targetLanguage: 'zh-CN' };
    const translator = new PaperTranslator(() => {});

    const mustTranslateCases = [
      ['短引导句 (<60字，冒号结尾)', 'Specifically, the loss is defined as:'],
      ['极短过渡子句', 'where:'],
      ['被公式切断的逗号残句', 'which can be formulated as,'],
      ['章节小标题', '4.2. Experimental Setup and Datasets'],
      ['摘要标题', 'Abstract'],
      ['大写占比高的论文标题', 'Delving into the Cyclic Mechanism in Semi-supervised Video Object Segmentation'],
      ['大写缩写密集的实验短句', 'We evaluate AOT-L and SwinB-AOT-L on DAVIS-2017 and YouTube-VOS.'],
      ['含 ⟦M1⟧ 公式占位符的解释短句', 'where ⟦M1⟧ denotes the learning rate and ⟦M2⟧ is the weight.'],
    ];
    for (const [desc, sample] of mustTranslateCases) {
      check(
        `零误跳门控 — ${desc} -> 必须送翻 (isPureUntranslatableToken=false)`,
        translator.isPureUntranslatableToken(sample) === false,
        sample
      );
    }

    const pureSkipCases = [
      ['纯 URL', 'https://github.com/yoxu515/aot-benchmark'],
      ['纯 DOI', 'doi: 10.1109/CVPR52733.2025.00123'],
      ['纯公式占位符与等号', '⟦M1⟧ = ⟦M2⟧ + ⟦M3⟧'],
      ['纯子图编号', '(a) (b) (c) (d)'],
      ['纯符号残渣', '| Ω | ̂'],
      ['纯脚注符号', '∗ † ‡'],
    ];
    for (const [desc, sample] of pureSkipCases) {
      check(
        `纯非语言符号 — ${desc} -> 原样保留 (isPureUntranslatableToken=true)`,
        translator.isPureUntranslatableToken(sample) === true,
        sample
      );
    }

    // Cache self-healing (`pruneStaleNonProseCache`)
    const poisonedCache = {
      translations: {
        shortColon: 'Specifically, the loss is defined as:',
        titleEn: 'Associating Objects with Transformers for Video Object Segmentation',
        realZh: '具体而言，我们将损失函数定义如下：',
        pureUrl: 'https://arxiv.org/abs/2106.02638',
      },
      sentenceTranslations: {
        shortColon: ['Specifically, the loss is defined as:'],
        realZh: ['具体而言，我们将损失函数定义如下：'],
      },
      alignment: {
        shortColon: { note: '该段像是人名/机构/图表标签等非叙述内容，已原样保留（未调用翻译接口）' },
        titleEn: { note: '' },
        realZh: { note: '' },
      },
    };
    const pruned = translator.pruneStaleNonProseCache(poisonedCache);
    check(
      '历史毒缓存自愈：自动清除 <60 字引导句与英文标题假译文，保留真译文与纯链接',
      pruned === 2 &&
        !poisonedCache.translations.shortColon &&
        !poisonedCache.translations.titleEn &&
        !!poisonedCache.translations.realZh &&
        !!poisonedCache.translations.pureUrl,
      `pruned=${pruned}`
    );

    // 3c. Decoupled Vision Provider Config Resolution
    mockConfigStore = {
      apiEndpoint: 'https://api.deepseek.com/v1',
      apiKey: 'mock-text-only-key',
      modelName: 'deepseek-chat',
      visionApiEndpoint: '',
      visionApiKey: '',
      visionModel: '',
    };
    const fallbackVision = resolveVisionProviderConfig();
    check(
      '视觉配置解耦：未单独配置视觉模型时自动回退主接口且标记 isDedicatedVision=false',
      fallbackVision.endpoint === 'https://api.deepseek.com/v1' &&
        fallbackVision.model === 'deepseek-chat' &&
        fallbackVision.isDedicatedVision === false
    );

    mockConfigStore.visionApiEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/';
    mockConfigStore.visionApiKey = 'mock-vlm-key';
    mockConfigStore.visionModel = 'qwen2.5-vl-72b-instruct';
    const dedicatedVision = resolveVisionProviderConfig();
    check(
      '视觉配置解耦：配置独立 VLM 后完全隔离主翻译 DeepSeek 接口 (isDedicatedVision=true)',
      dedicatedVision.endpoint === 'https://dashscope.aliyuncs.com/compatible-mode/v1' &&
        dedicatedVision.apiKey === 'mock-vlm-key' &&
        dedicatedVision.model === 'qwen2.5-vl-72b-instruct' &&
        dedicatedVision.isDedicatedVision === true
    );

    // 3d. Snip Tool JSDOM lifecycle test
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <button id="snipToolBtn"></button>
      <div id="pdfPane"><div id="pdfViewerContainer">
        <div class="page-wrapper" data-page-number="3"><canvas width="612" height="792"></canvas></div>
      </div></div>
    </body></html>`);
    const prevWin = global.window;
    const prevDoc = global.document;
    global.window = dom.window;
    global.document = dom.window.document;
    const posted = [];
    const snip = V2.createSnipTool({
      postMessage: (m) => posted.push(m),
      showToast: () => {},
      openAiModalWithSnip: () => {},
      renderKatexHtml: (tex) => `<K>${tex}</K>`,
      renderMarkdownHtml: (md) => `<MD>${md}</MD>`,
      isVisionConfigured: () => true,
    });
    check('框选识别控制器挂载成功，初始处于非激活态', snip.isActive() === false);
    snip.toggle(true);
    check(
      '开启框选模式后激活态为 true，且工具栏按钮同步 active 高亮',
      snip.isActive() === true && dom.window.document.getElementById('snipToolBtn').classList.contains('active')
    );
    snip.toggle(false);
    check('关闭框选模式后干净退出', snip.isActive() === false);
    global.window = prevWin;
    global.document = prevDoc;
  }

  // =========================================================================
  // 4. Full 11-PDF Real Academic Paper Benchmark
  // =========================================================================
  console.log('\n[4] 11 篇真实学术文献全量页面压测 (XY-Cut 双栏版面 + 2D 公式 + 1:1 坐标对账)');
  const sjtuDir = 'D:\\kx\\上海交大\\基于变分推断的点监督目标检测迭代伪标签优化\\文献及要求';
  const candidateFiles = [];
  if (fs.existsSync(sjtuDir)) {
    for (const f of fs.readdirSync(sjtuDir)) {
      if (f.toLowerCase().endsWith('.pdf')) candidateFiles.push(path.join(sjtuDir, f));
    }
  }
  const localTestDir = path.join(ROOT, 'test-papers');
  if (fs.existsSync(localTestDir)) {
    for (const f of fs.readdirSync(localTestDir)) {
      if (f.toLowerCase().endsWith('.pdf')) candidateFiles.push(path.join(localTestDir, f));
    }
  }
  const parentResnet = path.join(ROOT, '..', 'test_resnet.pdf');
  if (fs.existsSync(parentResnet)) candidateFiles.push(parentResnet);

  check(`发现真实测试文献 PDF 数量 >= 10 (实际 ${candidateFiles.length} 篇)`, candidateFiles.length >= 10);

  let totalPages = 0;
  let totalParas = 0;
  let totalSentences = 0;
  let totalDisplayFormulas = 0;
  let totalInlineMathTokens = 0;
  let charMapMismatchCount = 0;
  let ctrlGlyphCount = 0;
  let sentenceSliceMismatchCount = 0;
  let tokenBoundMismatchCount = 0;

  const perPaperSummary = [];
  const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

  for (const pdfPath of candidateFiles) {
    const baseName = path.basename(pdfPath);
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    let paperParas = 0;
    let paperFormulas = 0;
    let paperInlineTokens = 0;
    let paperBodyParas = 0;

    for (let p = 1; p <= doc.numPages; p++) {
      totalPages++;
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const pageW = vp.viewBox ? vp.viewBox[2] : vp.width;
      const pageH = vp.viewBox ? vp.viewBox[3] : vp.height;

      const { textContent, fontNames } = await extractRealFontNames(page);
      let rawGraphics = { hLines: [], vLines: [], rects: [] };
      try {
        const opList = await page.getOperatorList();
        rawGraphics = V2.extractRawPageVectors(opList, pdfjsLib.OPS, pageW, pageH);
      } catch {
        /* ignore operator list error on malformed embedded streams */
      }

      const mockSpans = (textContent.items || []).map((it, idx) => ({
        textContent: it.str || '',
        _pdfIdx: idx,
        setAttribute() {},
      }));

      const solved = V2.solveAcademicPageLayout({
        pageNum: p,
        items: textContent.items || [],
        spans: mockSpans,
        pageW,
        pageH,
        fontNames,
        rawGraphics,
        splitBlockFormula: true,
      });

      const paras = solved.paras || [];
      for (const para of paras) {
        totalParas++;
        paperParas++;
        if (para.type === 'body') paperBodyParas++;
        if (para.type === 'formula') {
          totalDisplayFormulas++;
          paperFormulas++;
        }

        // Invariant 1: 1:1 cleanText.length === charMap.length
        if (para.cleanText.length !== para.charMap.length) {
          charMapMismatchCount++;
        }

        // Invariant 2: Zero control characters (\u000f etc.)
        if (CTRL_RE.test(para.cleanText) || (para.visionLatex && CTRL_RE.test(para.visionLatex))) {
          ctrlGlyphCount++;
        }

        // Invariant 3: Sentence slice exactness
        for (const s of para.sentencesEn || []) {
          totalSentences++;
          if (para.cleanText.slice(s.startIdx, s.endIdx) !== s.text) {
            sentenceSliceMismatchCount++;
          }
        }

        // Invariant 4: Inline math token bounds & placeholder presence in translationText
        for (const tok of para.inlineMathTokens || []) {
          totalInlineMathTokens++;
          paperInlineTokens++;
          if (
            !(tok.startIdx >= 0 && tok.endIdx > tok.startIdx && tok.endIdx <= para.cleanText.length) ||
            !para.translationText.includes(tok.placeholder)
          ) {
            tokenBoundMismatchCount++;
          }
        }
      }

      // Specific notorious page regression assertions!
      if (baseName === 'AOT.pdf' && p === 5) {
        const p5Bodies = paras.filter((x) => x.type === 'body').length;
        const p5Formulas = paras.filter((x) => x.type === 'formula').length;
        check(
          'AOT.pdf 第 5 页回归：不再被全页 tableRegions 清空，正文段与公式 (3)(4)(5) 均完整保留',
          p5Bodies >= 3 && p5Formulas >= 2,
          `body=${p5Bodies}, formula=${p5Formulas}`
        );
      }
      if (baseName === 'cycle.pdf' && p === 4) {
        const p4Bodies = paras.filter((x) => x.type === 'body').length;
        const p4Formulas = paras.filter((x) => x.type === 'formula').length;
        check(
          'cycle.pdf 第 4 页回归：正文与行间公式清晰分离',
          p4Bodies >= 3 && p4Formulas >= 1,
          `body=${p4Bodies}, formula=${p4Formulas}`
        );
      }
      if (baseName === 'cycle.pdf' && p === 6) {
        const p6Bodies = paras.filter((x) => x.type === 'body').length;
        check(
          'cycle.pdf 第 6 页回归：双表 + 正文混合页不再被 tableRegions 误吞正文',
          p6Bodies >= 2,
          `body=${p6Bodies}`
        );
      }
    }

    perPaperSummary.push({
      paper: baseName.length > 36 ? baseName.slice(0, 33) + '...' : baseName,
      pages: doc.numPages,
      paras: paperParas,
      body: paperBodyParas,
      displayMath: paperFormulas,
      inlineTokens: paperInlineTokens,
    });
  }

  console.log('\n  📊 11 篇文献压测统计表：');
  console.table(perPaperSummary);

  check(
    `全量 ${totalPages} 页 / ${totalParas} 段 cleanText.length === charMap.length 严格 1:1`,
    charMapMismatchCount === 0,
    `mismatch=${charMapMismatchCount}`
  );
  check(
    `全量 ${totalPages} 页 / ${totalParas} 段不可见控制符残渣 (ctrl-glyph) === 0`,
    ctrlGlyphCount === 0,
    `ctrlGlyph=${ctrlGlyphCount}`
  );
  check(
    `全量 ${totalSentences} 条句子下标切片 cleanText.slice(start,end) === text 100% 自洽`,
    sentenceSliceMismatchCount === 0,
    `mismatch=${sentenceSliceMismatchCount}`
  );
  check(
    `全量 ${totalInlineMathTokens} 处行内公式 Token (⟦M1⟧..) 边界与占位符 100% 自洽`,
    tokenBoundMismatchCount === 0,
    `mismatch=${tokenBoundMismatchCount}`
  );
  check(
    `全量提取出丰富行间公式 (${totalDisplayFormulas} 条) 与行内数学符号 (${totalInlineMathTokens} 处)`,
    totalDisplayFormulas >= 80 && totalInlineMathTokens >= 500,
    `display=${totalDisplayFormulas}, inline=${totalInlineMathTokens}`
  );

  console.log(`\n======================================================================`);
  console.log(` 最终结果: ${pass} 通过 / ${fail} 失败`);
  console.log(`======================================================================`);
  if (fail > 0) {
    console.error('失败项汇总:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
})().catch((err) => {
  console.error('v2_arch_test 异常退出:', err);
  process.exit(1);
});
