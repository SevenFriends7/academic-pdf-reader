# Zotero 作为第二数据源的可行性调研（实测结论）

> 状态：**调研完成，实现待定**（用户 2026-10-04 说"等我再想想"）。
> 结论已用本机真实库验证过，不需要重新挖。

## 一、本机 Zotero 库现状（2026-10-04 实测）

| 项 | 值 |
|---|---|
| 数据目录 | `C:\Users\paroxetine\Zotero` |
| 数据库 | `zotero.sqlite`（约 1.38 MB，61 张表） |
| 条目 | 5 条顶层 + **3 个 PDF 附件**，1 个分类 |
| 全文文本 | **3 篇都有**：`storage\<KEY>\.zotero-ft-cache`（UTF-8，无 U+FFFD、无双向控制字符） |
| 批注 | 仅 1 条（AOT，`#ffd400`，第 1 页，text="gy, Zhejian"）；`itemAnnotations` 表有 `position`(JSON 坐标) |
| 本地 API | Zotero 运行中，`/connector/ping` → 200；`/api/` → **403（需 API key）** |

三篇附件：

| KEY | 论文 |
|---|---|
| `GUT7U72G` | Yang et al. - Associating Objects with Transformers (AOT) |
| `DE6KQMVB` | Li et al. - Delving into the Cyclic Mechanism (cycle) |
| `NQI6N4AP` | Oh et al. 2019 - STM |

### ⚠️ 读取时必踩的坑

**Zotero 运行中时 `mode=ro` 也会 `database is locked`**。必须用：

```python
sqlite3.connect(f'file:{db}?immutable=1', uri=True)
```

`immutable=1` 不走锁、不写任何东西，对正在运行的 Zotero 安全（本仓库一律只读，绝不改动用户库）。

`itemAttachments.path` 实测读出来是 `None`（值在 `itemData` 里，字段名 `path`），
**不能靠它拿文件名**；要拿文件名得走 `itemData`/`itemDataValues`，或者直接用 storage 目录里的 PDF。

## 二、核心对比：Zotero 全文 vs 本机几何抽取

同一份 PDF、同一处公式，两边分别抽成什么：

| 位置 | 本机几何层 | Zotero 全文 | 谁对 |
|---|---|---|---|
| STM p4 `k^Q ∈ R^{H×W×C/8}` | **`H×$×%`**（W→`$`、C→`%`）；我上一轮只能**整条丢弃** | `kQ ∈ RH×W ×C/8` | **Zotero 对** |
| AOT p5 `D ∈ R^{M×C}` | `D\in R^{M\times C}` | `D ∈ RM×C`（丢基线，`M` 分不出上标/正文） | **本机对** |
| AOT p6 `X_l^t ∈ R^{HW×C}` | `X_{l}^{t}` + `\in R^{HW\times C}` | `l ∈ RHW ×C`（**`X` 与真下标 `l` 丢失**） | **本机对** |
| AOT p6 最长的 AttLT 公式 | 完整一条 | 截断成 `AttLT (Xt` | **本机对** |
| AOT 普通正文 | `t HW × C`（字形间塞空格） | `RT HW ×C`（更干净） | Zotero 略优 |

### 结论

- **Zotero 存的是扁平纯文本，没有基线/字号**。而公式语义**恰恰全在几何里**——
  `X_l^t` 与 `Xlt` 在纯文本里无法区分。所以 Zotero **不能替代**本机数学层。
- 但 Zotero 用**自己的提取器**，能拿到 pdf.js 拿不到的字母（STM 那份 PDF 的 ToUnicode 是坏的）。
  这正是本机唯一"救不了"的那类问题。

### ⚠️ 必须纠正的一个说法

交接文档里曾写"STM 那些公式的 ToUnicode 坏了，**任何提取器**都拿不到真字母"——
**这句话是错的，Zotero 就拿到了**。当时只验了 pdf.js 与 PyMuPDF 两个提取器就下了"任何"的结论，
是过度概括。见 CHANGELOG 1.6.1 的说明。

## 三、若要实现：建议的分工

1. **正文/译文文本质量** → 优先用 Zotero 全文（更干净）
2. **坏字形恢复** → `$` / `%` 这类坏字符，用 Zotero 对应位置的文本替换，
   **恢复本机现在只能丢弃的公式**
3. **上下标 / 帽子 / 几何分层** → 仍由本机几何层负责（Zotero 给不了）

### 风险（实现时必须处理）

- **页码映射会漂**：`itemAttachments.path` 读不出文件名，全文索引**按页**存；
  页数与本地 PDF 不一致就会错位 → **必须先校验页数，不一致就放弃 Zotero、退回本地**，绝不错位使用。
- **不是刚需**：用户截图里的公式长相问题，根因是**译文层**（模型转写 LaTeX 写错，见 1.6.0），
  与数据源无关。

## 四、可复用的探针（全部只读）

| 脚本 | 用途 |
|---|---|
| `scratch/zotero_probe.py` | 库规模、表结构、附件、storage 目录总览 |
| `scratch/zotero_fulltext_probe.py` | `fulltextItems` / `itemAnnotations` / `itemAttachments` 结构与内容 |
| `scratch/zotero_text_compare.py` | `.zotero-ft-cache` 解码 + 公式痕迹统计 |

三个脚本都不含 `INSERT/UPDATE/DELETE/CREATE`（已用 grep 确认）。
