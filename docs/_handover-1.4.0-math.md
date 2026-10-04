# 1.6.0 公式层重做 · 交接（当前状态，务必先读这段）

## 1.6.0 修的是什么（用户第二次反馈"还是有问题"的真根因）

用户截图里的问题**不在提取层，在译文层**：译文里出现 `$X_{Tl}$`、`$tHW \times CEq$` 这种**写错的公式**。
根因是提示词 `FORMULA_LATEX_RULE` 让模型"把公式转写成 LaTeX 并用 `$...$` 包起来"——
模型看到的是残渣文本（`X l t`），转写出来的 LaTeX 经常是错的，而 **KaTeX 对错式子照样渲染**，
于是用户看到"漂亮但内容错误"的公式，比残渣还危险。

同时，本地数学层抽出来的 `localMath` 表**只用于显示层的一部分**：译文侧走的还是
`renderEnTextHtml(zh, para.visionInline)`，也就是**只吃视觉模型的替换表，完全没用上本地表**。

**改法（两处）**：
1. `src/translator.ts` 的 `FORMULA_LATEX_RULE`：不再要求转写，改成"**照抄原文那串残渣**，
   用 `⟦…⟧` 括起来，括号内逐字一致、不要改写、不要加 `$`"。
2. `media/viewer.js` 新增 `renderZhWithMath(text, para)`：把译文里的 `⟦…⟧` 配对成本地抽出的规范
   LaTeX（先按归一化残渣精确匹配，再按出现顺序兜底，表里没有就原样排版残渣），
   译文侧三处调用（逐句两处 + 连贯段落一处）全部切过去。

> ⚠️ **注意**：这条改动对**新翻译**生效；已经缓存的旧译文里仍是模型写错的 `$...$`，
> 需要重译那一页（译文栏的「⟳ 重译」按钮）才会走新规则。

## ⚠️ 用户报"还是识别不准"时，先做这一步

**先确认界面上跑的到底是哪一版。** 判据（任一即可，前两个最可靠）：

| 看哪里 | 新版（≥1.4.0） | 旧版（≤1.3.9） |
|---|---|---|
| 工具栏左上角版本徽章 | `v1.5.0` | `v1.3.9` 或 `v?` |
| 原文侧行内公式的 HTML | 带 `data-math-source="local"`、内层是 KaTeX（`class="katex"`） | 没有这两个特征 |
| 公式在界面上的长相 | 排版好的公式（上下标就位） | **残渣：每个字形之间都有一个空格**，如 `AttLT ( X l t , X l m , Y m )` |

**"每个字形之间一个空格"是旧版独有的指纹**——它是旧实现"把一行所有 span 用空格硬拼"的必然结果，
新版永远不会出现这种长相。用户 2026-10-04 发出的截图正是这个指纹（`(X l, X l, Y)`、`(X l W l, ...)`），
所以那张截图来自**旧构建**（VS Code / Antigravity 只在启动时扫描扩展目录，
装完必须**完全退出再打开**，Reload Window 不够）。

另外要检查是不是被**旧 id 扩展抢了界面**（本仓库历史遗留问题）：

```powershell
Get-ChildItem $env:USERPROFILE -Directory -Recurse -Depth 3 -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'academic-tools*' } | ForEach-Object { $_.FullName }
```

有输出就说明旧 id（`academic-tools.academic-pdf-reader`）还在抢同一个 PDF 编辑器 viewType，删掉它。

## 一句话结论

**目标要求的内容全部完成并验证通过**：公式/符号提取已用确定性方法（PDF 字体族 + 几何位置）
重做，正文与公式按片段精确分隔，批注/笔记支持 LaTeX（KaTeX）渲染，回归测试补齐（18 + 52 条新增），
全部门禁 0 失败，版本已升到 **1.5.0** 并打包安装到本机，安装产物与验证过的产物**字节相同**。

提取正确性由**三层证据**支撑：像素级视觉对照、语法全量校验、段落重建端到端校验。
唯一没做的是"在真实 IDE 里目视确认"——我无法启动 VS Code，这一步留给你（下面给了清单）。

## 三道验证工序（缺一不可，每一道都抓到过真 bug）

| 工序 | 命令 | 抓到了什么 |
|---|---|---|
| ① 像素级视觉对照 | `node scratch/math_render_compare.js <paper> <page>` | 撇号被判成下标、主语倒置、编码损坏片段——**门禁全绿时靠它发现** |
| ② LaTeX 全量语法校验 | `npm run test:math` + `node scratch/math_latex_verify.js` | 空式子 / KaTeX 拒绝的式子 |
| ③ 段落重建端到端 | `npm run test:para` | 编码校验漏了"正文内嵌公式"路径、charMap 比 cleanText 短导致**整段高亮错位** |


## 发版状态（已完成）

| 项 | 状态 |
|---|---|
| 版本 | `1.3.9` → `1.4.0` → `1.4.1` → `1.4.2` → `1.4.4` → **`1.5.0`**（1.4.3 在密钥扫描处中止、未产出，版本号跳过） |
| 商店包 | `academic-pdf-reader-1.5.0.vsix`（人工上传商店，别用 `-local.vsix`） |
| 本机安装 | 已装到 VS Code / Antigravity，三个 IDE 的安装产物冒烟全绿 |
| 安装产物一致性 | 工作区 `media/viewer.js` 与已安装目录里的 **SHA256 完全相同**——本机跑的就是要发布的代码 |
| git | 已 commit + tag `v1.4.0` / `v1.4.1` / `v1.4.2` / `v1.4.4` / `v1.5.0`；**未推送**，推送与商店上传由你决定 |
| 下一步 | **完全退出 IDE 再打开**（Reload Window 不换版本）→ 看工具栏版本徽章是不是 `v1.5.0` |

### 新增的第三道验证：段落重建（`npm run test:para`）

`scratch/para_rebuild_test.js`：用**真实 PDF 的 item** 喂给 viewer.js 里真正的 `commitParagraph`，
检查它产出的 `cleanText` / `segments` / 类型。数学层单测只验到"LaTeX 抽得对不对"，
**用户看到的残渣问题其实发生在段落拼接这一步**——以前这里没有任何自动化覆盖，只能靠肉眼看 IDE。
它一上线就抓到两个真 bug：

| 症状 | 根因 |
|---|---|
| `H×W×C` 的乱码混在**正文 span** 里照样被渲染成 `H\times \$\times \%` | 编码校验只加在 `mathItemsToLatex`（数学 item 路径），`findMathRegions`（正文内嵌路径）漏了 |
| charMap 比 cleanText 短 1（AOT）/ 短 16（STM）→ **整段高亮错位一位** | 连字符折行时切掉了"连字符 + 合成空格"两个字符，charMap 只弹了一次 |

第二条尤其要紧：高亮错位是"看起来没坏、其实全偏"的那类问题。现在除了修掉分支，
还加了兜底对齐（多则截断、少则用 `span:null` 补齐）并在补齐时打 warn。

### 各版本修了什么（**全部是"门禁全绿、只有看图才发现"的那类**）

| 版本 | 症状 | 根因 |
|---|---|---|
| 1.4.1 | `V′ = AttID(…)` → `'_{V=AttID(...)}` | 撇号（CMSY7 小号字形）被判成上下标候选，真正的下标挂到了撇上 |
| 1.4.2 | `D ∈ R^{M×C}` → `M_{D\in R}\times C`（主语倒置） | `buildPageMathModel` 给 `mathItemsToLatex` 传了**单位矩阵** transform，字号被抹成同一个值 |
| 1.4.2 | `R` 与指数 `M` 间隙为 0 时被当"同主行相邻" | "同基线相邻"缺了"基线必须相同"这一条 |
| 1.4.2 | 主行基线取 `max(y)` | 两个主级基线时主语会被判成上标（平手时应取**更低**那行） |
| 1.4.2 | `T HW` 与 `×` 之间出现假间隙导致拆条 | pdf.js 的 `item.width` 含前导空白，间隙算虚了 |
| 1.4.4 | `H×W×C` 被渲染成 `H×$×%`、`v^Q` 成 `+^*` | **PDF 自带的 ToUnicode 表是坏的**（PyMuPDF 读出同样乱码），提取层拿不到真字母 → 现在整条丢弃，不再渲染"看着像公式、内容全错"的东西 |

**这四个 bug 全部是被 `scratch/math_render_compare.js`（PDF 原图 vs KaTeX 渲染并排）看出来的**，
KaTeX 语法校验、单元测试、门禁当时全都是绿的——所以"看图"这一步不能省，交接时务必保留这个工序。

> 注：`scratch/vision/cmp_*.html` 是生成物、内嵌 KaTeX CSS，会被 `scan_secrets.js` 误报成
> "52 位访问令牌"，已加进 `.gitignore` 并不再跟踪。要重新生成对照页跑
> `node scratch/math_render_compare.js <paper> <page>`。


## 验证证据

| 门禁 | 结果 |
|---|---|
| `npm test`（viewer 单测） | 374 通过 / 0 失败 |
| `npm run test:gate`（译文质量闸门） | 49 通过 / 0 失败 |
| `npm run test:init`（jsdom 冒烟） | ✅ 无异常 |
| `npm run test:html`（真实宿主 HTML） | ✅ 通过 |
| `npm run test:pdf` | 50 通过 / 0 失败 |
| `npm run test:para`（**新增**段落重建回归） | **18 通过 / 0 失败** |
| `npm run test:math`（**新增**数学层回归） | **52 通过 / 0 失败** |
| `node scratch/math_latex_verify.js` | 468 条公式，空 0、KaTeX 语法错 0 |
| `node scratch/math_audit.js --all` | 468 条，无高危可疑模式 |
| `tsc --noEmit` / `lint` / `scan_secrets` / 安装产物冒烟 | 全绿 |

**像素级 / 视觉对照（用户明确要求的那一项）**：
用 PyMuPDF 把页面渲染成图（`scratch/vision/cycle_p4_render.png`、`cycle_p4_verify.png`、
`verify_AOT_p5.png` 等），再用视觉模型逐字转写，与本地数学层输出**逐条比对**：

| 页面上印的 | 本地抽取的 LaTeX | 判定 |
|---|---|---|
| `X` 下标 `t−1` = `{X_1}`，`Y` 下标 `t−1` = `{Y_1}` | `X_{t-1}=\{X_{1}\}`、`Y_{t-1}=\{Y_{1}\}` | ✅ 一致 |
| `L` 下标 `cycle,t` = `L(Ŷ_t, Y_t) + L(Ŷ_1, Y_1)` | `L_{cycle,t}=L(\hat{Y}_{t}, Y_{t})+L(\hat{Y}_{1}, Y_{1})` | ✅ 一致（视觉模型把下标读成 `cycle+`，而 PDF 文本层就是 `cycle,t`——以文本层为准） |
| `V′ = AttID(Q, K, V, Y|D) = …` | `V'=AttID(Q, K, V, Y|D)=…` | ✅ 一致（**这条是视觉对照抓出来的真 bug**：撇号曾被判成下标，转出 `'_{V=…}`） |
| `Ŷ`（帽子 + 下标 t） | `\hat{Y}_{t}` | ✅ 一致 |




## 必须先知道的失误（我犯的，已修复数据、但有一处后果）

我在用 PowerShell 一行流做"按行号替换"时，花括号计数被字符串/正则里的 `{}` 骗到，
**把 `media/viewer.js` 从 1400 行之后的内容整段删掉了**。之后我从本机已安装的 1.3.9 构建产物
`C:\Users\paroxetine\.vscode\extensions\paper-reader.academic-pdf-reader-1.3.9\media\viewer.js`
把尾部拼回来，文件语法正常、结构完整。

**后果**：那之前我做好的**集成改动**（`renderPage` 取字体名、`commitParagraph` 分段、
`renderParaEnHtml`、批注 LaTeX 渲染、导出改动）**一起被还原掉了，需要重做**。
数学层本身（`MATH_FONT_RE`…`mathItemsToLatex`、`chainToLatex`、`findMathRegions`、
`buildPageMathModel`）我逐个补回来了，并且跑通了 47 条回归断言。

（`media/viewer.js.broken` 是那次误删后的残片，可留作对照，也可删。）

## 已完成（可直接复核）

| 项目 | 证据 |
|---|---|
| 数学字体族判别 | `node -e` 快速断言；`math_layer_test.js` 的 R2 段 |
| 逐字符 → LaTeX 映射 | 74 个实测字符全覆盖（`scratch/_math_chars_agg.txt`） |
| 上下标 / 帽子 / 嵌套还原 | `math_layer_test.js` R1 段（合成数据） |
| 真实页面成组 | `math_layer_check.js`：cycle p4 得到 `X_{t-1}=\{X_{1}\}`、`Y_{t-1}=\{Y_{1}\}`、`\hat{X}_{t}=\{X_{t}\}` |
| 全量可渲染 | `node scratch/math_latex_verify.js` → 481 条，空 0、KaTeX 错 0 |
| 回归测试 | `node scratch/math_layer_test.js` → **47 通过 / 0 失败** |
| 质量审计 | `node scratch/math_audit.js --all` → S3（脚本层嵌套）1 条，其余为已知误报 |
| 视觉核对 | `scratch/vision/cycle_p4_render.png` + `cycle_p4_cropA/B.png`，用视觉模型逐字比对一致 |

## 已完成的界面接线（1.4.0）

- `renderPage`：`await page.getOperatorList()` 后从 `page.commonObjs` 取**真实字体名**，传给 `buildAcademicLayout`。
- `buildAcademicLayout(..., fontNames)`：算 `buildPageMathModel`，把逐 item 的数学归属挂到 textDiv。
- `commitParagraph`：按"正文/公式"交替重建 `cleanText` + `charMap`，片段之间按几何补词距；
  整段只有公式时 `type='formula'`，正文夹公式时记 `para.localMath`。
- `renderParaEnHtml(text, para)`：原文侧统一入口，**本地公式优先**；
  `sent-en` / `sent-zh` / `zh-paragraph-plain` / 句子级 `en-sentence` 的调用点已全部切过去。
- 批注/笔记：`note-quote` 与 `note-content` 改用 `renderEnTextHtml(...)`（支持 `$...$` / `$$...$$`），
  `media/viewer.css` 补了 `.note-content .md-math-rendered{white-space:normal}` 等覆盖。

## 还没做

1. **真实 IDE 目视验证**（我做不了）：装本机包 → 完全退出 IDE 再打开 →
   看工具栏版本徽章 → 打开 cycle.pdf 第 4 页，确认原文卡片里 `X_{t-1}=\{X_{1}\}` 是**排版好的公式**
   而不是 `X t − 1 = { X 1 }` 这种残渣；再写一条带 `$E=mc^2$` 的批注，确认批注里也渲染出公式。
2. **精读稿导出**：`buildReadingDocMarkdown` 里公式的说明文字仍是"视觉模型从页面图像转写"，
   应改成"由 PDF 字体与位置精确抽取"，并且行内公式优先用 `para.localMath` 而不是 `visionInline`。
3. **发版**：升版本 → CHANGELOG → `npm run vsix` → 装本机 → 提交打 tag 推送。

## 还没做（旧版计划，保留备查）

### 1. 恢复界面集成（`media/viewer.js`）

- `renderPage`：`await page.getOperatorList()` 之后，从 `page.commonObjs.get(it.fontName).name`
  取**真实字体名**（兜底：文本层 div 的 `style.fontFamily`），存成 `fontNames` 传给 `buildAcademicLayout`。
- `buildAcademicLayout(pageNum, textContent, textDivs, viewport, fontNames)`：
  调 `buildPageMathModel`，把 `byIndex` 挂到对应 textDiv。
- `commitParagraph`：按"正文/公式"交替重建 `cleanText` + `charMap`，片段之间按几何补词距
  （两侧都是字母数字且间隙 ≥0.28em 才加空格）；整段只有公式时 `type='formula'`。
- `renderParaEnHtml(text, para)`：原文侧统一入口，**本地公式优先**，视觉替换表只兜底；
  把 `sent-en` / `sent-zh` / `zh-paragraph-plain` 的调用点换过去。
  **注意**：`npm test` 里有一条断言在守这个（现在正是它红着）：
  `卡片里的英文原文走行内公式渲染（本地公式优先）`。
- 批注/笔记 LaTeX 渲染：`notesListContainer` 卡片里的 `note-quote` / `note-content`
  改用 `renderEnTextHtml(...)`；`media/viewer.css` 加
  `.note-content .md-math-rendered{white-space:normal}` 等（`pre-wrap` 会把 KaTeX 撑开）。
- 导出：公式标注改成"由 PDF 字体与位置精确抽取"，行内公式优先用 `para.localMath`；
  `archivePageParagraphs` 快照里带上 `localLatex` / `localMath`。

### 2. 跑全部门禁

```
npx tsc --noEmit
npm run lint
npm test
npm run test:gate
npm run test:init
npm run test:html
npm run test:pdf
node scratch/math_layer_test.js      # 新增的数学层回归
node scratch/scan_secrets.js
```

> `npm run test:gate` 会调 esbuild 起子进程，**受限沙箱下必然 EPERM**；
> 本会话已切到 danger-full-access，可以直接跑。

### 3. 发版

按 `release-academic-pdf-reader` 技能走：升版本 → CHANGELOG → 门禁 → `npm run vsix` →
装本机（**必须完全退出 IDE 再打开**）→ 看工具栏版本徽章确认生效 → 提交打 tag 推送。

## 踩过的坑（务必别再犯）

1. **注释里不能出现"星号 + 斜杠"**：会提前闭合块注释，后面的中文被当标识符，
   报 `Invalid or unexpected token`。在 `math_probe.js` 上实测挂过一次。
2. **绝不要用"按行号切片"的 PowerShell 一行流改大文件**：花括号计数会被字符串/正则里的 `{}` 骗到，
   这次就删掉了 7000+ 行。要替换就写**独立的 Node 脚本 + 先备份**。
3. **pdf.js 的 `item.height` 对数学 item 不可靠**（帽子与下标实测是 0.0），
   字号只能用 `|transform[3]|`；上下标判定要靠"基线差 + 字号比"，不要用高度盒。
4. **`page.commonObjs` 里的字体对象必须等 `getOperatorList()` 之后才在**，
   否则只能拿到 `g_d0_f1` 这种 loadedName，数学字体就认不出来。
5. **成组的两条铁律**（都在 `buildPageMathModel` 的注释里写明了）：
   - 判据一律以**锚点字形**为准，不能混用"组的边界"（组一旦合并，边界会把上下标算进去）；
   - 分"行池"要用**主行基线**（`floor(主体 y / 8)`），用下标基线会把 `−1` 与主体分到不同池。
