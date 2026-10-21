/**
 * 把任意 PDF 的某一页渲染成 PNG（排查版式用）。
 * 用法: node scratch/render_any_page.js <pdf> <页码> <缩放> <输出路径>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pdf = process.argv[2];
const page = Number(process.argv[3] || 1);
const zoom = Number(process.argv[4] || 2.0);
const out = process.argv[5] || path.join(__dirname, 'vision', `page_${page}.png`);

const py = `
import pymupdf
doc = pymupdf.open(r"${pdf}")
p = doc[${page - 1}]
pix = p.get_pixmap(matrix=pymupdf.Matrix(${zoom}, ${zoom}), alpha=False)
pix.save(r"${out}")
print(f"{pix.width}x{pix.height}")
`;
const script = path.join(__dirname, '_render_any_tmp.py');
fs.writeFileSync(script, py, 'utf8');
try {
  const size = execFileSync('python', [script], { encoding: 'utf8' }).trim();
  console.log(`已渲染：${out}  (${size})`);
} finally {
  try { fs.unlinkSync(script); } catch { /* 清理失败不影响结果 */ }
}
