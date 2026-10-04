"""
只读检查 Zotero 数据目录：条目数、附件、有没有全文/批注数据。
【纪律】一律用 mode=ro 打开，绝不写你的库；Zotero 正在运行也没关系。
"""
import sqlite3, os, json, collections

HOME = os.path.expanduser('~')
DB = os.path.join(HOME, 'Zotero', 'zotero.sqlite')
STORAGE = os.path.join(HOME, 'Zotero', 'storage')

print('DB:', DB, os.path.getsize(DB), 'bytes')
con = sqlite3.connect(f'file:{DB}?immutable=1', uri=True)
cur = con.cursor()

cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
tables = [r[0] for r in cur.fetchall()]
print('表数量:', len(tables))
interesting = [t for t in tables if any(k in t.lower() for k in ('item', 'annotation', 'fulltext', 'attachment', 'collection', 'creator'))]
print('相关表:', ', '.join(interesting))

def count(sql):
    try:
        cur.execute(sql)
        return cur.fetchone()[0]
    except Exception as e:
        return f'ERR {e}'

print('\n--- 规模 ---')
for label, sql in [
    ('条目总数(items)', 'SELECT COUNT(*) FROM items'),
    ('顶层条目', "SELECT COUNT(*) FROM items i JOIN itemTypes t ON t.itemTypeID=i.itemTypeID WHERE t.typeName NOT IN ('attachment','annotation','note')"),
    ('附件(attachment)', "SELECT COUNT(*) FROM items i JOIN itemTypes t ON t.itemTypeID=i.itemTypeID WHERE t.typeName='attachment'"),
    ('批注(annotation)', "SELECT COUNT(*) FROM items i JOIN itemTypes t ON t.itemTypeID=i.itemTypeID WHERE t.typeName='annotation'"),
    ('笔记(note)', "SELECT COUNT(*) FROM items i JOIN itemTypes t ON t.itemTypeID=i.itemTypeID WHERE t.typeName='note'"),
    ('分类(collection)', 'SELECT COUNT(*) FROM collections'),
    ('全文内容表(fulltextItems)', 'SELECT COUNT(*) FROM fulltextItems'),
]:
    print(f'  {label}: {count(sql)}')

print('\n--- fulltext 相关表结构 ---')
for t in tables:
    if 'fulltext' in t.lower():
        cur.execute(f'PRAGMA table_info({t})')
        cols = [r[1] for r in cur.fetchall()]
        print(f'  {t}: {cols}  行数={count(f"SELECT COUNT(*) FROM {t}")}')

print('\n--- PDF 附件与全文索引情况 ---')
cur.execute("""
SELECT i.itemID,
       (SELECT value FROM itemData d JOIN itemDataValues v ON v.valueID=d.valueID
        WHERE d.itemID=i.itemID AND d.fieldID=(SELECT fieldID FROM fields WHERE fieldName='title')) AS title,
       (SELECT value FROM itemData d JOIN itemDataValues v ON v.valueID=d.valueID
        WHERE d.itemID=i.itemID AND d.fieldID=(SELECT fieldID FROM fields WHERE fieldName='path')) AS path,
       (SELECT value FROM itemData d JOIN itemDataValues v ON v.valueID=d.valueID
        WHERE d.itemID=i.itemID AND d.fieldID=(SELECT fieldID FROM fields WHERE fieldName='contentType')) AS ctype
FROM items i JOIN itemTypes t ON t.itemTypeID=i.itemTypeID
WHERE t.typeName='attachment'
""")
rows = cur.fetchall()
pdfs = [r for r in rows if (r[3] or '').lower() == 'application/pdf']
print(f'  附件 {len(rows)} 个，其中 PDF {len(pdfs)} 个')
for r in pdfs[:12]:
    print(f'    itemID={r[0]} path={r[2]!r} title={(r[1] or "")[:50]!r}')

print('\n--- fulltext 覆盖 ---')
cur.execute("""
SELECT COUNT(*) FROM fulltextItems f
JOIN itemAttachments a ON a.itemID = f.itemID
""")
print('  fulltextItems 挂在附件上的条数:', cur.fetchone()[0])
try:
    cur.execute('SELECT itemID, LENGTH(content) FROM fulltextItems LIMIT 8')
    for r in cur.fetchall():
        print('    itemID', r[0], 'content 长度', r[1])
except Exception as e:
    print('  读 content 失败:', e)

print('\n--- storage 目录 ---')
if os.path.isdir(STORAGE):
    subs = os.listdir(STORAGE)
    print('  子目录数:', len(subs))
    tot = 0
    shown = 0
    for s in subs[:400]:
        d = os.path.join(STORAGE, s)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            p = os.path.join(d, f)
            if f.lower().endswith('.pdf'):
                tot += 1
                if shown < 10:
                    print(f'    {s}/{f}  {os.path.getsize(p)} bytes')
                    shown += 1
    print('  storage 里的 PDF 总数（前 400 个子目录）:', tot)
con.close()

