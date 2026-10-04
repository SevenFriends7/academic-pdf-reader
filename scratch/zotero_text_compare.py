"""
关键对比：Zotero 的 .zotero-ft-cache 全文 vs 本机 pdf.js 文本层抽取
重点看 AOT（Yang et al.）第 6 页那条 AttLT 公式，两边分别抽成什么样。
"""
import os, json, re, unicodedata

HOME = os.path.expanduser('~')
STORAGE = os.path.join(HOME, 'Zotero', 'storage')

targets = {
    'AOT': 'GUT7U72G',
    'cycle': 'DE6KQMVB',
    'STM': 'NQI6N4AP'
}
for name, sid in targets.items():
    p = os.path.join(STORAGE, sid, '.zotero-ft-cache')
    if not os.path.exists(p):
        print(f'{name}: 没有 .zotero-ft-cache')
        continue
    raw = open(p, 'rb').read()
    print(f'\n===== {name}  ({sid}) =====')
    print(f'  文件大小 {len(raw)} bytes')
    for enc in ('utf-8', 'utf-16', 'gbk', 'latin-1'):
        try:
            txt = raw.decode(enc)
            print(f'  解码成功: {enc}，字符数 {len(txt)}')
            break
        except Exception:
            continue
    else:
        continue
    # 公式痕迹
    for probe in ('AttLT', 'AttID', 'Concat', 'LSTT', 'hat', '∈', '×', '′'):
        n = txt.count(probe)
        if n:
            print(f'    含 {probe!r}: {n} 次')
    # 找公式那一行
    for line in txt.split('\n'):
        if 'AttLT' in line or 'Concat' in line:
            print(f'    >>> {line[:200]!r}')
            break
    # 控制字符 / 乱码统计（能反映提取质量）
    odd = collections = {}
    for ch in txt:
        if ord(ch) < 32 and ch not in '\n\r\t':
            odd[hex(ord(ch))] = odd.get(hex(ord(ch)), 0) + 1
    print(f'    控制字符: {odd if odd else "无"}')
    print(f'    前 300 字: {txt[:300]!r}')
