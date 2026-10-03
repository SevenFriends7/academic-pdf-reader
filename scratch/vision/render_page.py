"""把指定页渲染成 PNG（探针用）。

用法：python scratch/vision/render_page.py <pdf> <页码从1开始> <输出png> [scale]
"""
import sys
import pypdfium2 as pdfium

pdf_path, page_no, out_path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
scale = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0

pdf = pdfium.PdfDocument(pdf_path)
page = pdf[page_no - 1]
bitmap = page.render(scale=scale)
image = bitmap.to_pil()
image.save(out_path)
print(f"已渲染第 {page_no} 页 → {out_path}")
print(f"像素尺寸 {image.size[0]}x{image.size[1]}（scale={scale}）")
pdf.close()
