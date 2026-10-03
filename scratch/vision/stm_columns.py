"""按坐标把 STM 某一页的行拆成"左栏 / 右栏"，用于精确找出跨栏续句对。

不是分段器：只把 PDF 文本层的字符按 x 坐标分左右两半、按 y 重排行，输出两栏文本。
用于人工核对"左栏末尾半句 + 右栏开头续句"到底是不是真的被切开。

用法：python scratch/vision/stm_columns.py [页码] [输出json]
"""
import json
import sys

import pypdfium2 as pdfium

PDF = r'D:\kx\上海交大\梯度校正测验\梯度校正测验\STM.pdf'
PAGE = int(sys.argv[1]) if len(sys.argv) > 1 else 6
OUT = sys.argv[2] if len(sys.argv) > 2 else r'scratch/vision/stm_columns.json'

pdf = pdfium.PdfDocument(PDF)
page = pdf[PAGE - 1]
textpage = page.get_textpage()
n = textpage.count_chars()
width, height = page.get_size()

chars = []
for i in range(n):
    ch = textpage.get_text_range(i, 1)
    if not ch or ch in '\r\n':
        continue
    try:
        l, b, r, t = textpage.get_charbox(i)
    except Exception:
        continue
    if not ch.strip():
        # 空格也保留用于还原词距
        pass
    chars.append({'ch': ch, 'x': (l + r) / 2, 'y': (b + t) / 2, 'top': t})

mid = width / 2


def visible(s):
    return ''.join(c if c.isprintable() and c != '\ufffe' else '?' for c in s)


def build(side):
    sel = [c for c in chars if (c['x'] < mid if side == 'left' else c['x'] >= mid)]
    if not sel:
        return []
    sel.sort(key=lambda c: (-c['top'], c['x']))
    lines, cur, cur_top = [], [], None
    for c in sel:
        if cur_top is None or abs(c['top'] - cur_top) <= 3.5:
            cur.append(c)
            cur_top = c['top'] if cur_top is None else cur_top
        else:
            lines.append(cur)
            cur, cur_top = [c], c['top']
    if cur:
        lines.append(cur)
    out = []
    for ln in lines:
        ln.sort(key=lambda c: c['x'])
        out.append(visible(''.join(c['ch'] for c in ln)).strip())
    return [l for l in out if l]


left, right = build('left'), build('right')
out = {
    'pdf': PDF, 'page': PAGE, 'pageSize': [width, height],
    'leftColumn': left, 'rightColumn': right,
    'crossColumnPairs': [
        {'leftLast': left[-1] if left else None, 'rightFirst': right[0] if right else None}
    ],
    'note': '按 x 坐标一分为二得到的左右栏文本；用于核对跨栏续句，未做任何分段判定。',
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print(f'p{PAGE} 页面尺寸 {width:.0f}x{height:.0f}　左栏 {len(left)} 行 / 右栏 {len(right)} 行')
print('\n--- 左栏末尾 6 行 ---')
for l in left[-6:]:
    print('   ', l[:100])
print('\n--- 右栏开头 6 行 ---')
for l in right[:6]:
    print('   ', l[:100])
print('\n跨栏处：左栏末行 =', repr((left[-1] if left else '')[:110]))
print('          右栏首行 =', repr((right[0] if right else '')[:110]))
print(f'\n明细已存：{OUT}')
