"""
看 Zotero 在 fulltext 里到底存了什么（表结构 + 附件信息 + 与 we 本地 PDF 的对应关系）。
【结论要用数据说话，不能猜】Zotero 0 条批注的可能原因也要查清楚。
"""
import sqlite3, os, json

HOME = os.path.expanduser('~')
DB = os.path.join(HOME, 'Zotero', 'zotero.sqlite')
STORAGE = os.path.join(HOME, 'Zotero', 'storage')
con = sqlite3.connect(f'file:{DB}?immutable=1', uri=True)
cur = con.cursor()

def cols(t):
    cur.execute(f'PRAGMA table_info({t})')
    return [r[1] for r in cur.fetchall()]

print('=== fulltextItems 结构 ===')
print(' ', cols('fulltextItems'))
cur.execute('SELECT * FROM fulltextItems')
for r in cur.fetchall():
    print('  ', r)

print('\n=== itemAttachments 结构 ===')
print(' ', cols('itemAttachments'))
cur.execute('SELECT * FROM itemAttachments')
for r in cur.fetchall():
    print('  ', r)

print('\n=== itemAnnotations 结构 ===')
print(' ', cols('itemAnnotations'))
cur.execute('SELECT COUNT(*) FROM itemAnnotations')
print('  行数:', cur.fetchone()[0])
cur.execute('SELECT * FROM itemAnnotations LIMIT 5')
for r in cur.fetchall():
    print('  ', r)

print('\n=== 附件路径字段（path 值） ===')
cur.execute("""
SELECT a.itemID, v.value, a.contentType, a.linkMode
FROM itemAttachments a
LEFT JOIN itemDataValues v ON v.valueID = (
  SELECT d.valueID FROM itemData d WHERE d.itemID=a.itemID AND d.fieldID=(SELECT fieldID FROM fields WHERE fieldName='path') LIMIT 1)
""")
for r in cur.fetchall():
    print('  ', r)

print('\n=== 每个附件的全文索引统计 ===')
cur.execute("""
SELECT f.itemID, f.indexedPages, f.totalPages, f.indexedChars, f.totalChars,
       (SELECT value FROM itemData d JOIN itemDataValues v ON v.valueID=d.valueID
        WHERE d.itemID=(SELECT parentItemID FROM itemAttachments WHERE itemID=f.itemID)
          AND d.fieldID=(SELECT fieldID FROM fields WHERE fieldName='title')) AS parentTitle
FROM fulltextItems f
""")
for r in cur.fetchall():
    print(f'   attach={r[0]} pages={r[1]}/{r[2]} chars={r[3]}/{r[4]}  parent={(r[5] or "")[:60]}')

print('\n=== fulltextWords 里的高频词（能看出提取质量） ===')
cur.execute("""
SELECT w.word, COUNT(*) c FROM fulltextItemWords iw
JOIN fulltextWords w ON w.wordID = iw.wordID
GROUP BY w.wordID ORDER BY c DESC LIMIT 30
""")
print('  ', ', '.join(f'{w}({c})' for w, c in cur.fetchall()))

print('\n=== 库里有没有那条 AttLT 公式的痕迹（全词表搜索） ===')
for probe in ('attlt', 'attid', 'concat', 'w_t', 'hw'):
    cur.execute("SELECT COUNT(*) FROM fulltextWords WHERE word LIKE ?", (probe,))
    print(f'  {probe}: {cur.fetchone()[0]}')

print('\n=== storage 目录与 DB 的对应 ===')
for d in os.listdir(STORAGE):
    p = os.path.join(STORAGE, d)
    if os.path.isdir(p):
        for f in os.listdir(p):
            print(f'  {d}/{f}')
con.close()
