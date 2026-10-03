# 交接笔记：修复双栏页面的阅读顺序（图表块被放错位置）

> ## ✅ 已完成（不要重做）
> **发布状态见 `scratch/pending-release-1.3.9.md`**：改动已进工作区、1.3.9 已打包并装到本机两个 IDE，
> 但**用户要求先不提交**，留到下次改 bug 时一起交。
> 本笔记提出的方案已落地并验证，见 `CHANGELOG.md` 的 `[1.3.9]` 与 `docs/design-notes.md`。
> - **8.6 改成"图表单元 + 栏内混排"**（比原方案多了一层"单元"：一张跨栏大图的标签 + 通栏图注
>   必须先聚成一个整体，否则左标签/右标签/图注会被分别归栏、正文插进图中间）。
> - **连带修了跨栏续句被图表切断**（原方案没提到；顺序修对后必然出现，STM 第 6 页的
>   `…each for a single` → `target object.` 会被切成两张残句卡片）。
> - 审计工具：`scratch/order_audit.js`（+ `order_summary.js` / `order_diff.js`），支持 `VIEWER_SRC` 做 before/after。
> - 真实第 6 页整页 97 行已写进单测（`scratch/llm-test/viewer-unit.js` 的 T13 场景三）。
> - 结果：违规页 11 → 7、V2 3 → 0、V3 12 → 9；单测 265 → 291（新增的 10 条在修复前全红）。
>
> 下面保留原始排查记录，供追溯"当初为什么这么改"。
>
> ---

> 给下一个（上下文较短的）会话用。**结论已经查清，不需要重新排查**，直接按方案改 + 验证即可。
> 仓库：`D:\kx\上海交大\academic-pdf-reader`（版本 1.3.8，工作区干净，门禁基线全绿）

## 现象

用户反馈："有时候这个段的顺序是乱的"。

**已复现**（STM.pdf 第 6 页，`node scratch/paragraph_truth.js 6`）：

```
[0] 表1数据行   [1] 表1图注   [2] 表3图注 ✗（表3在右栏，却排到了表2之前）
[3] 标题 4.2 DAVIS   [4-6] 正文三段
[7] 表2数据行 ✗（表2在左栏，却排到了正文之后）   [8] 表2图注
```

自然阅读顺序应当是：**左栏从上到下（表1+图注 → 表2+图注 → 左栏正文）→ 右栏从上到下（表3+图注 → 右栏正文）**。

## 根因（`media/viewer.js` 第 8.6 步 `reorderFigureBlocks`，约 1582–1640 行）

```js
const colTop = Math.max(...colLines.map(l => l.y));            // ★错误1
const topBlocks = blocks.filter(b => b.bottomY > colTop - 8);  // ★错误2
const restBlocks = blocks.filter(b => b.bottomY <= colTop - 8);
orderedLines = [...heads, ...flat(topBlocks), ...colLines, ...flat(restBlocks), ...feet];
```

1. **`colTop` 是全局单一阈值** ✗。双栏页面的两栏正文起点往往不同：
   STM 第 6 页左栏正文从 y≈93 开始（上方被两张表占满），右栏正文从 y≈422 开始。
   用一个阈值比较两栏，必然误判其中一栏。
2. **拿"块的底边"与"正文的顶边"比** ✗。块越高（Table 2 从 y=460 一直延伸到 y=247），
   底边越低 → 被判成"不在正文之上" → 整块被搬到正文**之后**。
3. **图表块不区分栏** ✗。右栏的 Table 3 因底边高而被判为 topBlock，
   被整体提到正文**之前**，破坏了"先左栏、后右栏"的顺序。

## 修复方案（利用视觉/版面信息，符合用户"注意双栏区别"的要求）

把 8.6 从"全局 top/rest 二分"改成**按栏内联**：

1. **给每个块判定所属栏**：用块的横向范围与该页分栏线 `gutterX`（第 2 步已算出）比较：
   - 跨栏（`minX < gutterX - 容差 && maxX > gutterX + 容差`）→ 通栏块 `cross`；
   - 否则按块中心/多数像素落在 `gutterX` 左侧还是右侧 → `col1` / `col2`。
2. **栏内合并排序**：对 `col1`，把属于 col1 的正文行与该栏的图表块**按 y 混排**（块用它的
   顶行参与排序，块内行保持自上而下）；col2 同理。
3. **通栏块**：若其 `bottomY` 高于两栏正文的最高 y（真正位于正文之上）→ 放在最前；
   否则放在两栏之后、脚注之前。
4. 保留现有 `heads` / `feet` 位置不变，保留 8.4、8.5 两步不动。
5. 把 `colTop` 这类"全局阈值"全部换成**每栏各自**的正文顶/底，避免同类误判再次出现。

## 必须补的验证（按 SKILL.md 的验证层级，不能只跑单测就说修好了）

1. **先建一个"顺序审计"工具**（`scratch/order_audit.js`）：
   复用 `paragraph_truth.js` 的抽取方式，对三篇样例 PDF（`PAPERS_DIR` 指向
   `D:\kx\上海交大\梯度校正测验\梯度校正测验`：AOT / cycle / STM）**逐页**输出段落序列，
   并自动标记以下违规：
   - 同页里第一个 `col2` 正文段落之后又出现 `col1` 正文段落；
   - 图表块的图注与其数据行不相邻（中间隔了正文）；
   - 一段以非句末标点结尾、而紧随其后的段落不是它的续接。
   先跑一遍记录**修复前的违规页清单**（这就是 before 基线）。
2. 改完再跑同一工具，逐页对比 before/after。
3. 跑全部门禁：`npx tsc --noEmit`、`npm run lint`、`npm test`、`npm run test:gate`、
   `npm run test:init`、`npm run test:html`、`npm run test:pdf`、`node scratch/scan_secrets.js`。
4. 把 STM 第 6 页的真实行数据写进单元测试（照本仓库惯例：把 bug 的具体数据固化进测试），
   断言顺序为"表1 → 表2 → 左栏正文 → 表3 → 右栏正文"。
5. 更新 `CHANGELOG.md` 与 `docs/design-notes.md`（根因 + 三处错误 + 为什么用栏内混排）。

## 已知的可复用工具

- `scratch/paragraph_truth.js <页码> [文件]`：打印某页最终段落序列（能直接看出乱序）——
  本次复现就是用它。注意它会打印 pdfjs 的 canvas 警告，属正常。
- `scratch/layout_truth.js`、`scratch/audit_papers.js`、`scratch/column_matrix.js`：版面相关诊断。
- 抽代码的方式（在 `paragraph_truth.js` 里）：按字符串锚点从 `media/viewer.js` 里
  `slice` 出 `detectColumnStructure` 到 step 9 之间的布局代码，再用 `new Function` 执行。
  改布局代码时若锚点文字变了，需要同步更新工具里的锚点。
