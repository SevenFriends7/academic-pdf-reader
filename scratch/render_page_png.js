/**
 * 把 PDF 页面渲染成图片，供**肉眼/视觉模型**核对公式提取是否与版面一致。
 *
 * 【为什么要它】本地数学层的正确性有两层证据：
 *   ① 自动：LaTeX 能被 KaTeX 渲染、没有空式子（scratch/math_latex_verify.js）；
 *   ② 视觉：抽出来的公式与页面上真正印的公式是否**是同一条**（本脚本产出对照图）。
 * 用户明确要求"验证的时候请你也要直接通过视觉来看看提取是否正确"，所以这一步不能省。
 *
 * 用法：node scratch/render_page_png.js [paper] [page] [zoom]
 *      paper ∈ cycle | AOT | STM
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PAPERS = {
  cycle: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf',
  AOT: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\AOT.pdf',
  STM: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf'
};

const paper = process.argv[2] || 'cycle';
const page = Number(process.argv[3] || 1);
const zoom = Number(process.argv[4] || 2.5);
const pdf = PAPERS[paper];
if (!pdf) {
  console.error(`未知论文：${paper}（可选 ${Object.keys(PAPERS).join(' / ')}）`);
  process.exit(2);
}

const outDir = path.join(__dirname, 'vision');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${paper}_p${page}_render.png`);

// PyMuPDF 已在开发机上验证可用（比装 canvas 依赖轻得多，且不碰网络）
const py = `
import pymupdf, sys
doc = pymupdf.open(r"${pdf}")
page = doc[${page - 1}]
mat = pymupdf.Matrix(${zoom}, ${zoom})
pix = page.get_pixmap(matrix=mat, alpha=False)
pix.save(r"${out}")
print(f"{pix.width}x{pix.height}")
`;
const script = path.join(__dirname, '_render_tmp.py');
fs.writeFileSync(script, py, 'utf8');
try {
  const size = execFileSync('python', [script], { encoding: 'utf8' }).trim();
  console.log(`已渲染：${out}  (${size})`);
} finally {
  try { fs.unlinkSync(script); } catch { /* 清理失败不影响结果 */ }
}
