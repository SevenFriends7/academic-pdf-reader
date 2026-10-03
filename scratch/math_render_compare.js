/**
 * 公式渲染对照图：把本地数学层抽出的 LaTeX 用**真 KaTeX** 排出来，输出成 HTML/PNG，
 * 与 PyMuPDF 从 PDF 上裁下来的同一批公式并排放，供人/视觉模型逐条比对。
 *
 * 【为什么必须做这一步】"抽出来的 LaTeX 对不对"分两层：
 *   ① 语法层：KaTeX 收不收（math_latex_verify.js 已自动跑全量）；
 *   ② 语义层：它与页面上真正印的是不是同一条式子——这一层只能"看"。
 * 本脚本把②变成可重复的工序：同一批公式，左边是 PDF 原文裁图，右边是本机 LaTeX 渲染图。
 *
 * 用法：
 *   node scratch/math_render_compare.js <paper> <page> [--crop x y w h]
 * 产出：
 *   scratch/vision/cmp_<paper>_p<page>.html   （并排对照页）
 *   scratch/vision/cmp_<paper>_p<page>.png    （Edge 无头截图；没有 Edge 就只出 HTML）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pdfjsLib = require(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

const PAPERS = {
  cycle: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf',
  AOT: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf',
  STM: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf'
};
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const paper = process.argv[2] || 'cycle';
const pageNum = Number(process.argv[3] || 4);
const pdfPath = PAPERS[paper];
if (!pdfPath) { console.error('未知论文', paper); process.exit(2); }

const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');
const s = code.indexOf('  const MATH_FONT_RE');
const e = code.indexOf('  function buildPageMathModel');
const fnEnd = code.indexOf('\n  /**', e);
const ML = new Function(`${code.slice(s, e)}${code.slice(e, fnEnd)}
  return { buildPageMathModel };`)();

const visionDir = path.join(__dirname, 'vision');
if (!fs.existsSync(visionDir)) fs.mkdirSync(visionDir, { recursive: true });

(async () => {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false }).promise;
  const page = await doc.getPage(pageNum);
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
  const runs = model.runs.filter(r => String(r.latex || '').trim());
  if (!runs.length) { console.log(`第 ${pageNum} 页没有公式`); return; }

  /*
   * 【坐标系必须换算】数学层里的 y 是 **PDF 原始坐标（原点在左下，向上为正）**，
   * 而 PyMuPDF 的 Rect 用的是**页面坐标（原点在左上，向下为正）**。
   * 第一版忘了换算，裁出来的图整体上下翻转——左边显示的根本不是右边那条式子（实测踩过）。
   *   pageY = pageHeight - pdfY
   * 裁图范围用**字形边界**算（item 的 x/width/字号），不要用公式 box 的高度：
   * box 里的 absTop/高度对跨行大符号没有意义。
   */
  const pageH = (page.view && page.view[3]) || 792;
  const jobs = runs.map((r, i) => {
    const xs = r.items.flatMap(it => [it.x, it.x + (it.width || 0)]);
    const ys = r.items.map(it => pageH - it.y);
    const maxSize = Math.max(...r.items.map(it => it.size));
    const padX = 4;
    const padY = Math.max(4, maxSize * 0.5);
    return {
      i,
      x0: Math.min(...xs) - padX,
      y0: Math.min(...ys) - padY,
      x1: Math.max(...xs) + padX,
      y1: Math.max(...ys) + padY
    };
  });
  const py = `
import pymupdf, json
doc = pymupdf.open(r"${pdfPath}")
page = doc[${pageNum - 1}]
jobs = json.loads(r'''${JSON.stringify(jobs)}''')
out = []
for j in jobs:
    rect = pymupdf.Rect(j['x0'], j['y0'], j['x1'], j['y1'])
    pix = page.get_pixmap(matrix=pymupdf.Matrix(4,4), clip=rect, alpha=False)
    p = rf"${visionDir.replace(/\\/g, '\\\\')}\\crop_{j['i']}.png"
    pix.save(p)
    out.append({'i': j['i'], 'file': p, 'w': pix.width, 'h': pix.height})
print(json.dumps(out))
`;
  const pyFile = path.join(__dirname, '_cmp_crop.py');
  fs.writeFileSync(pyFile, py, 'utf8');
  let crops = [];
  try {
    crops = JSON.parse(execFileSync('python', [pyFile], { encoding: 'utf8' }).trim());
  } finally {
    try { fs.unlinkSync(pyFile); } catch { /* 清理失败不影响 */ }
  }

  const katexJs = fs.readFileSync(path.join(__dirname, '..', 'media', 'katex', 'katex.min.js'), 'utf8');
  const katexCss = fs.readFileSync(path.join(__dirname, '..', 'media', 'katex', 'katex.min.css'), 'utf8');

  const rows = runs.map((r, i) => {
    const crop = crops.find(c => c.i === i);
    const img = crop ? `<img src="${path.basename(crop.file)}" style="max-width:100%">` : '';
    const tex = String(r.latex).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const residue = r.items.map(x => x.str).join(' ').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<tr><td class="n">${i + 1}</td>
      <td class="pdf">${img}</td>
      <td class="tex"><div class="render" data-tex="${tex}"></div>
        <div class="src">${tex}</div>
        <div class="res">残渣：${residue}</div></td></tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<style>${katexCss}</style>
<style>
 body{font:13px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:12px;background:#fff;color:#111}
 h1{font-size:15px;margin:0 0 10px}
 table{border-collapse:collapse;width:100%}
 td{border-bottom:1px solid #e5e5e5;padding:8px 6px;vertical-align:middle}
 td.n{width:28px;color:#888;text-align:right}
 td.pdf{width:46%;background:#fafafa;text-align:center}
 td.tex{width:46%}
 .render{font-size:17px;margin-bottom:4px}
 .src{font:11px/1.4 Consolas,monospace;color:#0a6;word-break:break-all}
 .res{font:11px/1.4 Consolas,monospace;color:#a60;word-break:break-all}
</style>
<script>${katexJs}</script>
</head><body>
<h1>${paper}.pdf 第 ${pageNum} 页 · 公式抽取对照（左：PDF 原图 4× 裁图　右：本机 LaTeX 经 KaTeX 排版）</h1>
<table>${rows}</table>
<script>
document.querySelectorAll('.render').forEach(function(el){
  try { el.innerHTML = katex.renderToString(el.getAttribute('data-tex'), {displayMode:false, throwOnError:false, strict:false}); }
  catch(e){ el.textContent = 'RENDER FAIL: ' + e.message; }
});
</script>
</body></html>`;
  const htmlPath = path.join(visionDir, `cmp_${paper}_p${pageNum}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('已生成对照页：', htmlPath, `（${runs.length} 条公式）`);

  if (fs.existsSync(EDGE)) {
    const png = path.join(visionDir, `cmp_${paper}_p${pageNum}.png`);
    try {
      execFileSync(EDGE, [
        '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
        `--window-size=1500,${Math.min(20000, 120 + runs.length * 110)}`,
        `--screenshot=${png}`, `file:///${htmlPath.replace(/\\/g, '/')}`
      ], { stdio: 'ignore', timeout: 90000 });
      console.log('已生成截图：', png);
    } catch (err) {
      console.log('Edge 截图失败（不影响 HTML 对照页）：', err.message);
    }
  } else {
    console.log('未找到 Edge，跳过截图（HTML 对照页可直接用浏览器打开）');
  }
})().catch(e => { console.error(e); process.exit(1); });
