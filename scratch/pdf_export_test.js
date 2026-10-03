/**
 * 「高光批注 PDF」导出测试。
 *
 * 不是"跑完没报错"就算过——它会**把生成的 PDF 再解析回来**核对三件事：
 *   1. 原文页原样在（页数对得上）；
 *   2. 高亮真的按坐标画上去了（用 pdf.js 的算子列表找矩形与填充色，核对位置尺寸）；
 *   3. 附录里的中文真的能被提取出来（证明字体嵌入 + ToUnicode + 子集化都对）。
 *
 * 第 3 条依赖本机有一份可嵌入的中文字体；CI（ubuntu）默认没有，
 * 那种情况下会明确打印"跳过中文断言"，而不是假装通过。
 *
 * 用法：node scratch/pdf_export_test.js
 *      DUMP_PDF=<路径> 可把生成的样例 PDF 存下来人工查看
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

function requireOrFail(mod, hint) {
  try {
    return require(mod);
  } catch (e) {
    console.error(`需要 ${mod}：${hint || 'npm install'}`);
    process.exit(2);
  }
}

const esbuild = requireOrFail('esbuild', 'npm install');
const { PDFDocument, rgb, StandardFonts } = requireOrFail('pdf-lib', 'npm install --save-dev pdf-lib');

// 把 TS 源码现编成 CJS 再 require：测的必须是仓库里那份实现，不是复制品
const buildDir = path.join(ROOT, 'scratch', '.build');
fs.mkdirSync(buildDir, { recursive: true });
const bundlePath = path.join(buildDir, 'pdfExport.cjs');
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src', 'pdfExport.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: bundlePath,
  logLevel: 'error'
});
const pageArchiveBundlePath = path.join(buildDir, 'pageArchive.cjs');
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src', 'pageArchive.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: pageArchiveBundlePath,
  logLevel: 'error'
});
const { buildAnnotatedPdf, findCjkFontPath } = require(bundlePath);
const { mergeArchivedParagraphs, hashParagraphText } = require(pageArchiveBundlePath);

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) pass++;
  else fail++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;

// ---------------------------------------------------------------- 造一份"原始论文"
async function makeSourcePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const texts = [
    ['Page 1 body text about semi-supervised video object segmentation.', 100],
    ['Page 2 body text about the cyclic mechanism.', 140],
    ['Page 3 body text about gradient correction modules.', 180]
  ];
  texts.forEach(([line, top]) => {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText(line, { x: 72, y: PAGE_H - top, size: 11, font, color: rgb(0, 0, 0) });
  });
  return await doc.save();
}

// ---------------------------------------------------------------- 造论文数据
const EN1 = 'In this paper, we address several inadequacies of current video object segmentation pipelines.';
const ZH1 = '在本文中，我们解决了当前视频目标分割流程的若干不足。';
const EN3 = 'Next, we introduce a simple gradient correction module, which extends the offline pipeline to an online method.';
const ZH3 = '接下来，我们引入一个简单的梯度校正模块，它把离线流程扩展为在线方法。';
const EN1B = 'By relying on the accurate reference mask in the starting frame, we show that the error propagation problem can be mitigated.';
const ZH1B = '通过依赖起始帧中的准确参考掩码，我们证明可以缓解误差传播问题。';

function makePaperData() {
  const now = Date.now();
  return {
    pdfPath: 'C:/papers/cycle.pdf',
    pdfName: 'cycle.pdf',
    lastOpened: now,
    annotations: [
      {
        id: 'a1',
        page: 1,
        text: EN1,
        color: 'yellow',
        note: '这是全文动机，值得记一笔。',
        paraIndex: 0,
        timestamp: now,
        rects: [{ left: 72, top: 96, width: 300, height: 12 }]
      },
      {
        id: 'a2',
        page: 1,
        text: EN1B,
        color: 'blue',
        note: '',
        paraIndex: 2,
        timestamp: now,
        rects: [{ left: 72, top: 300, width: 180, height: 11 }]
      },
      {
        // 这一页根本没被解析过（没有段落快照）→ 译文页上必须如实写"这一条还没有译文"
        id: 'a4',
        page: 2,
        text: 'a highlight on page 2 that has no translation yet',
        color: 'green',
        note: '',
        paraIndex: undefined,
        timestamp: now,
        rects: [{ left: 60, top: 200, width: 220, height: 12 }]
      },
      {
        id: 'a3',
        page: 3,
        text: EN3,
        color: 'pink',
        note: '这里的推导我还没看懂。',
        paraIndex: 0,
        timestamp: now,
        rects: [{ left: 88, top: 176, width: 260, height: 12 }]
      }
    ],
    translations: {},
    sentenceTranslations: {},
    aiQa: [
      {
        id: 'qa1',
        page: 3,
        selectedText: EN3.slice(0, 40),
        question: '这个模块为什么能扩展到在线？',
        answer: '因为它只依赖当前帧与参考掩码，不需要未来帧。',
        model: 'deepseek-chat',
        at: now
      }
    ],
    pageArchive: {
      '1': [
        {
          id: 0,
          type: 'body',
          cleanText: EN1,
          sentencesEn: [{ text: EN1 }],
          translation: ZH1,
          sentenceTranslations: [ZH1]
        },
        {
          id: 1,
          type: 'figure-label',
          cleanText: 'IoU mIoU J&F',
          sentencesEn: [{ text: 'IoU mIoU J&F' }],
          translation: '',
          sentenceTranslations: []
        },
        {
          id: 2,
          type: 'body',
          cleanText: EN1B,
          sentencesEn: [{ text: EN1B }],
          translation: ZH1B,
          sentenceTranslations: [ZH1B]
        }
      ],
      '3': [
        {
          id: 0,
          type: 'body',
          cleanText: EN3,
          sentencesEn: [{ text: EN3 }],
          translation: ZH3,
          sentenceTranslations: [ZH3]
        }
      ]
    }
  };
}

(async () => {
  console.log('===== 高光批注 PDF 导出测试 =====');

  const originalBytes = await makeSourcePdf();
  const paperData = makePaperData();
  const result = await buildAnnotatedPdf({
    originalBytes,
    paperData,
    paperName: 'cycle.pdf',
    includeAllPages: true
  });

  console.log('\n[1] 结构');
  check('导出了全部原文页（用户要求"所有页"）', result.sourcePages === 3, `实际 ${result.sourcePages} 页`);
  check('生成了附录页（译文与笔记）', result.appendixPages >= 1, `附录 ${result.appendixPages} 页`);
  check('四条高亮（共 4 个矩形）都画上去了', result.drawnAnnotations === 4, `实际 ${result.drawnAnnotations}`);
  check('输出是合法 PDF', result.bytes.length > 2000 && String.fromCharCode(...result.bytes.slice(0, 5)) === '%PDF-');

  if (process.env.DUMP_PDF) {
    fs.writeFileSync(process.env.DUMP_PDF, result.bytes);
    console.log(`\n（样例 PDF 已写入 ${process.env.DUMP_PDF}）`);
  }

  // ---------------------------------------------------------------- 用 pdf.js 复核
  const pdfjs = require(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.js');
  const standardFontsDir = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(result.bytes),
    isEvalSupported: false,
    standardFontDataUrl: fs.existsSync(standardFontsDir) ? standardFontsDir : undefined
  }).promise;

  console.log('\n[2] 页数与原文页内容');
  check('总页数 = 原文页 + 附录页', doc.numPages === 3 + result.appendixPages, `实际 ${doc.numPages} 页`);

  // pdf.js 的算子列表才是"PDF 里到底画了什么"的直接证据。
  // 注意 OPS 里同一个数值有多个别名，必须用官方常量比较，不能自己反查名字。
  const ops1 = await (await doc.getPage(1)).getOperatorList();
  const translates = [];
  const rects = [];
  const curves = [];
  const fills = [];
  const gstates = [];
  for (let i = 0; i < ops1.fnArray.length; i++) {
    const fn = ops1.fnArray[i];
    const args = ops1.argsArray[i];
    if (fn === pdfjs.OPS.transform && Array.isArray(args) && args.length === 6 && args[0] === 1 && args[3] === 1) {
      translates.push([args[4], args[5]]);
    } else if (fn === pdfjs.OPS.constructPath) {
      const pathOps = Array.isArray(args && args[0]) ? args[0] : [];
      const coords = Array.isArray(args && args[1]) ? args[1] : [];
      if (pathOps.includes(pdfjs.OPS.curveTo)) {
        // 曲线路径 = 编号标记的圆圈
        curves.push(pathOps.length);
      } else if (coords.length === 8) {
        // 矩形路径固定是 4 个点（8 个坐标）
        const xs = coords.filter((_, k) => k % 2 === 0);
        const ys = coords.filter((_, k) => k % 2 === 1);
        rects.push([Math.max(...xs), Math.max(...ys)]);
      }
    } else if (fn === pdfjs.OPS.setFillRGBColor) {
      fills.push([args[0], args[1], args[2]]);
    } else if (fn === pdfjs.OPS.setGState) {
      gstates.push(JSON.stringify(args[0]));
    }
  }

  check('第 1 页有两个矩形（就是那两条高亮）', rects.length === 2, `实际 ${rects.length} 个`);
  const hasRect = (w, h) => rects.some(([rw, rh]) => Math.abs(rw - w) < 0.6 && Math.abs(rh - h) < 0.6);
  check('高亮尺寸与批注记录一致（300×12 / 180×11）', hasRect(300, 12) && hasRect(180, 11), JSON.stringify(rects));
  const hasTranslate = (x, y) =>
    translates.some(([tx, ty]) => Math.abs(tx - x) < 0.6 && Math.abs(ty - y) < 0.6);
  check(
    '高亮位置换算正确（左上角原点 → PDF 左下角原点）',
    hasTranslate(72, PAGE_H - 96 - 12) && hasTranslate(72, PAGE_H - 300 - 11),
    `translate=${JSON.stringify(translates)}`
  );
  check(
    '高亮用的是阅读器同款黄色 #ffeb3b 与蓝色 #00b0ff',
    fills.some(c => c[0] === 255 && c[1] === 235 && c[2] === 59) && fills.some(c => c[0] === 0 && c[1] === 176 && c[2] === 255),
    JSON.stringify(fills)
  );
  check(
    '透明度与混合模式与阅读器一致（ca 0.6 + BM multiply，文字不会被盖住）',
    gstates.some(g => g.includes('0.6')) && gstates.some(g => g.includes('multiply')),
    gstates.join(' ')
  );
  // 高光旁的编号标记（圆圈 + 数字）：译文页靠这个序号一一对应
  if (result.fontPath) {
    check('原文页上每条高光都画了编号圆圈（2 条 → 2 个圆）', curves.length === 2, `实际 ${curves.length} 个`);
  }

  console.log('\n[3] 高光译文页（字体嵌入 + 可提取）');
  const squeeze = s => String(s).replace(/\s+/g, '');
  /** 把整份 PDF 的文字抓出来（译文页紧跟原文页，说明页在最后，所以不能只看最后一页） */
  const readAllText = async d => {
    let t = '';
    for (let n = 1; n <= d.numPages; n++) {
      t += (await (await d.getPage(n)).getTextContent()).items.map(it => it.str).join('');
    }
    return squeeze(t);
  };
  /** 逐页文字（1-based 页码 → 文本），用于精确定位"第 N 页的译文页" */
  const readPageTexts = async bytes => {
    const d = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      standardFontDataUrl: fs.existsSync(standardFontsDir) ? standardFontsDir : undefined
    }).promise;
    const out = [];
    for (let n = 1; n <= d.numPages; n++) {
      out.push(squeeze((await (await d.getPage(n)).getTextContent()).items.map(it => it.str).join('')));
    }
    return out;
  };
  const allText = await readAllText(doc);
  if (!result.fontPath) {
    console.log('   ⚠️  本机没找到可嵌入的中文字体，跳过中文断言（CI 环境属正常）');
    console.log(`      警告原文：${result.warnings.join(' / ')}`);
  } else {
    check(
      '每条高光的译文都在（第 1 页两条、第 3 页一条）',
      allText.includes(squeeze(ZH1)) && allText.includes(squeeze(ZH3)),
      `用字体：${path.basename(result.fontPath)}`
    );
    // 折行处不画空格是 PDF 的常态，所以比对前先把空白压掉
    check('原文摘录也在（对照用）', allText.includes(squeeze('In this paper, we address')));
    check('我的批注也在', allText.includes('这是全文动机'));
    check('AI 答疑也在', allText.includes('这个模块为什么能扩展到在线') && allText.includes('不需要未来帧'));
    check('图表标签不进译文页', !allText.includes(squeeze('IoU mIoU J&F')));
    check('译文页用序号与原文页的圆点对应', allText.includes('1.核心要点') && allText.includes('2.方法/公式'));
    check('末尾有导出说明页', allText.includes('导出说明') && allText.includes('有高光的页')); 

    // 排版不能溢出页面（长 URL/长英文词在硬切逻辑上有 bug 时这里会先红）
    let overflow = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n);
      const viewport = pg.getViewport({ scale: 1 });
      const items = (await pg.getTextContent()).items;
      overflow += items.filter(it => {
        const x = it.transform[4];
        const w = typeof it.width === 'number' ? it.width : 0;
        return x + w > viewport.width - 20;
      }).length;
    }
    check('译文页文字没有溢出页面右边界', overflow === 0, overflow ? `溢出的行：${overflow}` : '');
  }

  console.log('\n[5] 译文解析（用户反馈："译文没有同步到导出的 pdf"）');
  // 真实场景：重开插件后，段落快照里的 translation 是空的（生成快照时缓存还没回填），
  // 译文只存在于 paperData.translations 里，键形如 `${page}_${引擎标识}_${内容指纹}`。
  const taggedKey = `1_engtag_${hashParagraphText(EN1)}`;
  const paperDataNoSnapshotTrans = makePaperData();
  paperDataNoSnapshotTrans.pageArchive['1'][0].translation = '';
  paperDataNoSnapshotTrans.pageArchive['1'][0].sentenceTranslations = [];
  paperDataNoSnapshotTrans.translations = { [taggedKey]: ZH1 };
  paperDataNoSnapshotTrans.sentenceTranslations = { [taggedKey]: [ZH1] };

  const rNoSnap = await buildAnnotatedPdf({
    originalBytes,
    paperData: paperDataNoSnapshotTrans,
    paperName: 'cycle.pdf',
    engineTag: 'engtag',
    includeAllPages: true
  });
  const readWholeDoc = async bytes => {
    const d = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      standardFontDataUrl: fs.existsSync(standardFontsDir) ? standardFontsDir : undefined
    }).promise;
    return await readAllText(d);
  };

  if (!result.fontPath) {
    console.log('   ⚠️  无中文字体，跳过（与上一节同样的原因）');
  } else {
    const tNoSnap = await readWholeDoc(rNoSnap.bytes);
    check('快照里没译文、译文只在缓存里 → 译文页仍出现中文', tNoSnap.includes(squeeze(ZH1)));
    // 第 1 页的译文页就是全份第 2 页（原文 1 → 译文 1）
    const pagesNoSnap = await readPageTexts(rNoSnap.bytes);
    check(
      '第 1 页那两条高光都没被标成"还没有译文"',
      !pagesNoSnap[1].includes('这一条还没有译文'),
      pagesNoSnap[1].slice(0, 60)
    );

    // cacheKey 优先：宿主不必重算指纹
    const paperDataByKey = makePaperData();
    paperDataByKey.pageArchive['1'][0].translation = '';
    paperDataByKey.pageArchive['1'][0].sentenceTranslations = [];
    paperDataByKey.pageArchive['1'][0].cacheKey = 'weird_key_from_webview';
    paperDataByKey.translations = { weird_key_from_webview: '按 cacheKey 精确回查到的译文' };
    const rByKey = await buildAnnotatedPdf({
      originalBytes,
      paperData: paperDataByKey,
      paperName: 'cycle.pdf',
      includeAllPages: true
    });
    check('快照带 cacheKey 时按它精确回查', (await readWholeDoc(rByKey.bytes)).includes('按cacheKey精确回查到的译文'));

    // 无引擎标识的旧键兜底
    const paperDataLegacy = makePaperData();
    paperDataLegacy.pageArchive['1'][0].translation = '';
    // 也清掉段落自带的句级译文：否则逐句版本会正确地胜出，测不到"无标识键"这条路
    paperDataLegacy.pageArchive['1'][0].sentenceTranslations = [];
    paperDataLegacy.translations = { [`1_${hashParagraphText(EN1)}`]: '旧版无标识键里的译文' };
    const rLegacy = await buildAnnotatedPdf({
      originalBytes,
      paperData: paperDataLegacy,
      paperName: 'cycle.pdf',
      includeAllPages: true
    });
    check('兼容 0.5.1 之前的无标识缓存键', (await readWholeDoc(rLegacy.bytes)).includes('旧版无标识键里的译文'));
  }

  // 合并策略：空译文不许覆盖已有译文（重开插件重读同一页时会发生）
  const merged = mergeArchivedParagraphs(
    [{ id: 0, type: 'body', cleanText: EN1, translation: '已经存好的译文' }],
    [{ id: 0, type: 'body', cleanText: EN1, translation: '', sentenceTranslations: [] }]
  );
  check('合并段落快照时，空译文不会覆盖已存译文', merged[0].translation === '已经存好的译文', JSON.stringify(merged[0].translation));

  console.log('\n[6] 译文覆盖范围（用户反馈："译文加上没有"）');
  // 提前读源码：后面两节都要用（放在 [4] 里会触发 const 的暂时性死区）
  const viewerSrc = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');
  const providerSrc = fs.readFileSync(path.join(ROOT, 'src', 'pdfEditorProvider.ts'), 'utf8');
  const extensionSrc = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check(
    '返回结果里带"译文覆盖了哪几页"',
    Array.isArray(result.translatedPages) && result.translatedPages.includes(1) && result.translatedPages.includes(3),
    JSON.stringify(result.translatedPages)
  );
  check(
    '返回结果里带"哪些高光页还没有译文"（第 2 页那条高光没译过）',
    Array.isArray(result.pagesWithoutTranslation) && result.pagesWithoutTranslation.includes(2),
    JSON.stringify(result.pagesWithoutTranslation)
  );
  if (result.fontPath) {
    const summary = (await (await doc.getPage(doc.numPages)).getTextContent()).items.map(it => it.str).join('').replace(/\s+/g, '');
    check(
      '说明页列出"这些页的高光还没有译文"并给出补齐办法',
      summary.includes('这些页的高光还没有译文') && summary.includes('重新导出即可补齐'),
      summary.slice(-140)
    );
  }
  if (result.fontPath) {
    // 每张译文页都紧跟它对应的原文页：第 1 页的译文页就是第 2 页
    const sheet1 = (await (await doc.getPage(2)).getTextContent()).items.map(it => it.str).join('').replace(/\s+/g, '');
    check('第 1 页的译文页紧跟在第 1 页后面（页序：原文1 → 译文1）', sheet1.includes('第1页·高光译文'), sheet1.slice(0, 60));
    const summary = (await (await doc.getPage(doc.numPages)).getTextContent()).items.map(it => it.str).join('').replace(/\s+/g, '');
    check(
      '末尾说明页写明"有高光的页"与"已带译文的页"',
      summary.includes('有高光的页') && summary.includes('已带译文的页'),
      summary.slice(0, 120)
    );
  }

  // 自动用系统程序打开是踩过的坑：用户机器上 .pdf 没有关联程序时，
  // openExternal 会让 VS Code 弹"打开外部程序时出错"，我们的 try/catch 拦不住。
  const openBlock = providerSrc.slice(providerSrc.indexOf('const action = await vscode.window.showInformationMessage'));
  check(
    '导出后不再自动调用系统程序打开，改为给按钮',
    openBlock.includes("'在文件夹中显示'") && openBlock.includes("'打开 PDF'") && !/writeFile\(target[\s\S]{0,600}await vscode\.env\.openExternal\(target\);\s*\} catch/.test(providerSrc)
  );

  console.log('\n[7] 自行选择要不要高光译文');
  // 本机若有纯拉丁字体就故意把它当"中文字体"传进去：这一档压根不该用它
  const latinFontForTest =
    ['C:\\Windows\\Fonts\\arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(p => fs.existsSync(p)) || null;
  // 用户要"只要高光后的原文"时：不出译文页、不画编号、也不需要中文字体
  const rPlain = await buildAnnotatedPdf({
    originalBytes,
    paperData,
    paperName: 'cycle.pdf',
    includeAllPages: true,
    includeTranslation: false,
    // 故意给一个没有汉字的字体路径：不该被用上，也不该产生任何字体相关警告
    fontPathOverride: latinFontForTest || undefined
  });
  check('只要原文时不生成译文页', rPlain.appendixPages === 0, `实际 ${rPlain.appendixPages}`);
  check('只要原文时总页数就是原文页数', (await pdfjs.getDocument({ data: new Uint8Array(rPlain.bytes), isEvalSupported: false }).promise).numPages === 3);
  check('只要原文时不返回任何"已覆盖译文"的页', Array.isArray(rPlain.translatedPages) && rPlain.translatedPages.length === 0);
  check('只要原文时高亮照样画回原位', rPlain.drawnAnnotations === 4, `实际 ${rPlain.drawnAnnotations}`);
  check(
    '只要原文时不报任何字体问题（这一档本来就不需要中文字体）',
    !rPlain.warnings.some(w => w.includes('字体') || w.includes('中文字形')),
    JSON.stringify(rPlain.warnings)
  );
  const opsPlain = await (await (await pdfjs.getDocument({ data: new Uint8Array(rPlain.bytes), isEvalSupported: false }).promise).getPage(1)).getOperatorList();
  let plainCurves = 0;
  for (let i = 0; i < opsPlain.fnArray.length; i++) {
    if (opsPlain.fnArray[i] === pdfjs.OPS.constructPath) {
      const pathOps = Array.isArray(opsPlain.argsArray[i] && opsPlain.argsArray[i][0]) ? opsPlain.argsArray[i][0] : [];
      if (pathOps.includes(pdfjs.OPS.curveTo)) plainCurves++;
    }
  }
  check('只要原文时不画编号圆点（没有译文页就没有对应关系）', plainCurves === 0, `实际 ${plainCurves} 个圆`);

  console.log('\n[4] 退化路径与接线');
  // 4a：给一个"没有汉字"的字体 → 必须如实降级（只出原文页 + 警告），不能画出豆腐块骗人
  const latinCandidates = ['C:\\Windows\\Fonts\\arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
  const latinFont = latinCandidates.find(p => fs.existsSync(p));
  if (latinFont) {
    const latinResult = await buildAnnotatedPdf({
      originalBytes,
      paperData,
      paperName: 'cycle.pdf',
      fontPathOverride: latinFont,
      includeAllPages: true
    });
    check(
      '指定了不含汉字的字体时如实降级（不出译文页，并给出警告）',
      latinResult.appendixPages === 0 &&
        latinResult.sourcePages === 3 &&
        latinResult.drawnAnnotations === 4 &&
        latinResult.warnings.some(w => w.includes('中文字形')),
      `字体=${path.basename(latinFont)}，译文页=${latinResult.appendixPages}，警告=${latinResult.warnings.length} 条`
    );
  } else {
    console.log('   ⚠️  本机没有可用的拉丁字体，跳过降级路径断言');
  }

  // 4b：接线检查——按钮、命令、消息类型、设置项必须都在（防止"功能写了但点不到"）
  check(
    '「导出笔记」按钮会打开导出菜单',
    /exportNotesBtn\.addEventListener\('click'[\s\S]{0,220}type: 'exportNotes'/.test(viewerSrc)
  );
  check(
    '宿主处理 exportNotes（菜单）与 exportPdf',
    providerSrc.includes("case 'exportNotes'") && providerSrc.includes("case 'exportPdf'")
  );
  const menuStart = providerSrc.indexOf('private async showExportMenu');
  const menuBody = menuStart >= 0 ? providerSrc.slice(menuStart, menuStart + 1600) : '';
  check(
    '菜单两项都能到达实现（Markdown 精读稿 / PDF）',
    menuBody.includes('exportAnnotatedPdf()') && menuBody.includes('requestReadingDoc(webview)')
  );
  check(
    '命令面板注册了 PDF 导出命令',
    extensionSrc.includes('academicReader.exportAnnotatedPdf') &&
      pkg.contributes.commands.some(c => c.command === 'academicReader.exportAnnotatedPdf')
  );
  check('提供了中文字体路径设置项', !!pkg.contributes.configuration.properties['academicReader.pdfExportFontPath']);
  check(
    '导出前会问"要不要高光译文"，并把选择记住',
    providerSrc.includes('askPdfTranslationMode') &&
      providerSrc.includes('pdfExportIncludeTranslation') &&
      !!pkg.contributes.configuration.properties['academicReader.pdfExportIncludeTranslation']
  );
  check(
    '命令面板与按钮两条入口都会先问（不会绕过选择）',
    /exportAnnotatedPdf\(\)[\s\S]{0,400}askPdfTranslationMode\(\)/.test(providerSrc)
  );
  check('pdf-lib 已进入依赖清单', !!(pkg.devDependencies['pdf-lib'] && pkg.devDependencies['@pdf-lib/fontkit']));

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('\n❌ 测试自身抛异常：', e);
  process.exit(1);
});

