"""第二轮探针的"素材体检"（不发 API、不造分段）。

因为全局存储里 STM.pdf 没有任何归档页（pageArchive={}），探针没有合法输入可跑。
本脚本只从 PDF 文本层读出**事实**，供人判断这页值不值得当第二轮素材：
  - 逐页有多少文本行、有几个 Table/Figure 题注
  - 第 PAGE 页的全文行（左右栏顺序如实输出，不重排）
  - 标出"像被切开/像续句"的行：行首小写字母/数字/左括号、行尾无句末标点

用法：python scratch/vision/stm_page_facts.py [页码] [输出json]
"""
import json
import re
import sys

import pypdfium2 as pdfium

PDF = r'D:\kx\上海交大\梯度校正测验\梯度校正测验\STM.pdf'
PAGE = int(sys.argv[1]) if len(sys.argv) > 1 else 6
OUT = sys.argv[2] if len(sys.argv) > 2 else r'scratch/vision/stm_page_facts.json'

pdf = pdfium.PdfDocument(PDF)
pages = []
for n in range(1, len(pdf) + 1):
    text = pdf[n - 1].get_textpage().get_text_range()
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    caps = [l for l in lines if re.match(r'^(Table|Figure)\s*\d', l, re.I)]
    pages.append({'page': n, 'lines': len(lines), 'captions': caps})

target = next(p for p in pages if p['page'] == PAGE)
raw = pdf[PAGE - 1].get_textpage().get_text_range()
# U+FFFE 之类是 pdfium 抽出来的坏字符，只做可见化，不改内容
lines = [l.strip() for l in raw.splitlines() if l.strip()]

def visible(s):
    return ''.join(c if c.isprintable() and c != '\ufffe' else '?' for c in s)

detail = []
for idx, l in enumerate(lines):
    head = visible(l)
    detail.append({
        'line': idx,
        'text': head,
        'startsWithLowercaseOrDigitOrParen': bool(re.match(r'^[a-z(\d]', l)),
        'endsWithoutTerminalPunct': not bool(re.search(r'[.!?]["\')\]]?$', l)),
        'isCaption': bool(re.match(r'^(Table|Figure)\s*\d', l, re.I)),
    })

out = {
    'pdf': PDF,
    'pageCount': len(pdf),
    'pagesSummary': [{'page': p['page'], 'lines': p['lines'], 'captionCount': len(p['captions']),
                      'captions': [visible(c)[:110] for c in p['captions']]} for p in pages],
    'targetPage': PAGE,
    'targetLineCount': len(lines),
    'targetCaptions': [visible(c) for c in target['captions']],
    'targetLines': detail,
    'candidateContinuationLines': [d for d in detail if d['startsWithLowercaseOrDigitOrParen'] and not d['isCaption']],
    'note': '这些是 PDF 文本层的原始行，不是产品生成的本地分段；产品会按自己的规则合并/分类后再交给视觉模型。',
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print(f'PDF: {PDF}')
print(f'总页数 {len(pdf)}')
for p in out['pagesSummary']:
    print(f"  p{p['page']}: 文本行 {p['lines']}　题注 {p['captionCount']}　{[c[:60] for c in p['captions']]}")
print(f"\n目标页 p{PAGE}：{len(lines)} 行，题注 {len(out['targetCaptions'])} 个")
for c in out['targetCaptions']:
    print('   题注:', c[:110])
print(f"\n像续句/被切开的行（行首小写/数字/括号）共 {len(out['candidateContinuationLines'])} 行：")
for d in out['candidateContinuationLines'][:40]:
    print(f"   L{d['line']:>3} {'[尾无句末标点]' if d['endsWithoutTerminalPunct'] else '                 '} {d['text'][:95]}")
print(f'\n明细已存：{OUT}')
