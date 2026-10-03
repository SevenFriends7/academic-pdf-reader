# 待发布：1.3.9（本机已装，未提交 / 未打 tag / 未上传）

> 交接时间：2026-10-03　交接人：上一轮会话
> 用户原话："先留着吧，等到下次改 bug 再交，留个说明。"
> 也就是：**这批改动攒着，下次改 bug 时和新的改动一起交**。这份文件就是那份"说明"。

## 一、一句话现状

`media/viewer.js` 的两处修复已经写好、门禁全绿、**已经打包并装到本机两个 IDE**，
但**没有 git commit、没有打 tag、没有推送、没有上传商店**。
仓库版本号已被改成 **1.3.9**（`package.json` + `CHANGELOG.md` 的 `## [1.3.9]` 章节都已在工作区里）。

| 项 | 值 |
|---|---|
| 仓库版本 | 1.3.9（已改，**未提交**） |
| 最新 tag | `v1.3.8`（`v1.3.9` 不存在 → 版本号 1.3.9 **仍可复用**） |
| 最新提交 | `5f1c27c docs: 交接笔记 —— 双栏阅读顺序…` |
| 工作区 | 13 个文件改动（含 `src/translator.ts` 提示词、`src/pdfExport.ts`、`src/pageArchive.ts`、`media/viewer.css`）+ 8 个新增文件（7 个工具 + 本说明），全部未提交 |
| 本机包 | `academic-pdf-reader-1.3.9.vsix`（**2026-10-04 01:2x 重打**，含五批修复；宿主 `dist/extension.js` 里的公式聚焦提示词已核对） |
| 已装 IDE | VS Code ✅ `@1.3.9`、Antigravity IDE ✅ `@1.3.9`（都是这一版构建） |
| 商店 | 仍是 1.3.8（未上传） |
| 单测 | 265 → **352 通过 / 0 失败**；闸门 40 → **49**；PDF 导出 48 → **50**（同一套测试跑修复前的产物是 276 / **12 失败**） |
| 已清理 | Antigravity 侧两个残留的 `…-1.3.8` 目录（已删；盘上现在只有 1.3.9，也没有 `academic-tools*` 旧 id 目录） |

## 二、这批改动做了什么

1. **双栏阅读顺序**（用户："有时候这个段的顺序是乱的"）
   8.6 `reorderFigureBlocks` 从"全局 top/rest 二分"改成"**图表单元 + 栏内混排**"。
   旧实现三处错：整页唯一阈值 `colTop`、拿块的底边比正文的顶边、块不分栏。
   实测 STM 第 6 页由 `表1 → 表3图注 → 标题 → 正文 → 表2 → 表2图注`
   变成 `表1 → 表2 → 左栏正文 → 表3 → 右栏正文`。
   顺带修了**跨栏续句被图表块切断**（9.5 允许跳过纯图表段落找续句）。
2. **段落内公式渲染失败**（用户："段落内的公式提取不完整导致 latex 渲染失败"）
   拿本机真实回包复现出四类，逐条修：
   - F1 模型把整句连同 `$` 写进 latex → KaTeX 渲染成红色报错；
     新增 `renderVisionMathHtml`，带定界符的走 `renderTextWithMath`；
   - F2 拆分锚点不在本段里（三种形态：落在紧邻下一段 / 连 index 都标错 / `parts[0]` 没锚点）
     → 模型给的公式 latex 被静默丢掉、公式整条不渲染；
     现在按**锚点**解析拆分真正跨越的段落，且**片子等循环走到它真正所在的位置再输出**（顺序不乱）；
   - F3 没有基字母的"孤儿"组合符（`(̂)`、`| Ω | ̂`）留在界面上 → 在三条残渣规则之后统一清掉；
   - F4 **译文里的公式被替换表切坏**（用户第二次反馈："这个地方翻译我感觉乱套了"）：
     替换区间按 `find.length` 取，而归一化匹配的命中片段常常更短 → 多吃字符、留下悬空 `}` 与重复公式；
     现在用 `locateAnchorRange()` 取**真实命中区间**，裸上标按"latex 里有没有 `^`"决定吃掉还是并进，
     并且**模型自己写了 `$...$` 的新式译文的数学区间一律不碰**。
3. **AI 回答里的公式渲染失败**（用户第二次追加："问 AI，AI 输出的回答 latex 也渲染失败"）
   AI 回答走的是另一条路径（Markdown 渲染）。拿存档里 42 条真实回答复现，三处都修了：
   - `escapeHtml` 先跑，于是 `$N(N<M)$` 到 KaTeX 手里成了 `N(N&lt;M)` → 报错红字；
     新增 `decodeMathEntities()` 在 `renderMathSpan` 里还原实体；
   - 行内 `$...\tag{3}$` 里 `\tag` 只能用于 display → 行内改写成 `\quad\text{(3)}`；
   - **落单的 `$`** 会与远处的 `$` 配对、把整段散文吞成公式 → 新增 `looksLikeInlineMath()`
     （同时保证 `$t+1$`、`$N < M$` 这类短式子不被误拒）。
4. **AI 回答里的变量/公式全变成灰底代码块**（用户第三次追加："我现在读人工智能的文章最重要的就是
   理解公式，你公式都搞不好我怎么读的好？"）。真相是**模型全用反引号包符号**：4 条真实回答里
   `$...$` 是 0 个、反引号片段 33~129 个（65~100 个是数学）。两头一起改：
   - **提示词（正路）**：问答侧三个档位原来**一个字都没提数学写法**，现在统一加 `ANSWER_MATH_RULE`
     （变量/公式一律 `$...$`，不要用反引号包变量或公式）；
   - **渲染兜底（管历史回答）**：`looksLikeMathCodeSpan()` 把"像数学"的反引号片段按行内公式渲染，
     判据方向是"默认是数学、像代码才排除"，最后用 `canRenderMath()`（真 KaTeX）当硬闸门，
     渲染不出来就退回代码块。实测 **500 个 → 0 个**。
5. **公式与符号专项**（用户第三次追加："尤其关注公式和符号，通篇做特别的优化，包括问 AI 公式
   相关的东西，就要聚焦公式本身"）。核心发现：**规范公式一直在手边，却从没交给模型**。
   - `collectFocusMath()`：提问时把 `visionLatex`（整式）+ 相关行内公式一路送到提示词，
     并明示"以规范写法为准、残渣不可照抄"（实测视觉回包公式片 **15/15** 都带 latex）；
   - 公式类提问追加**固定顺序**：规范式 `$$...$$` → **逐符号表** → 这条式子做什么 →
     **代小例子走一遍** → 与相邻公式关系 → 指出残渣差异；
   - **AI 回答补上 GFM 表格渲染**（逐符号表以前退化成一堆竖线）+ 专用样式；
   - 公式卡片加「讲透这条公式」「复制 LaTeX」；弹窗里**把规范式排版出来** + "已附上规范 LaTeX"徽标；
     快捷提问加公式专用芯片；所有提问补「数学写法」要求（一律 `$...$`、别用反引号包公式）；
   - **精读稿导出规范公式**（根因：段落快照没带 `visionLatex`/`visionInline`）、
     **批注 PDF 写出规范 LaTeX**。
6. **测试与工具**：单测 265 → 352、gate 40 → 49、pdf 48 → 50（新增的在修复前全红）；
   新增 7 个离线核对工具（见第七节）。

细节看 `CHANGELOG.md` 的 `## [1.3.9]` 与 `docs/design-notes.md` 的两节"未发布"。

## 三、⚠️ 下次改完 bug 必须重做的一件事

**现在装在两个 IDE 里的 1.3.9 是 20:36 那一刻的构建。**
下次再改 `media/viewer.js`（或任何进包的文件），**IDE 里看到的仍是这一版**——
必须重新打包 + 重装，否则验证的是旧代码（这个坑本仓库踩过多次）。

## 四、下次交接时的操作清单

本机**没有 PowerShell 7**（`pwsh` 不存在，只有 Windows PowerShell 5.1），
且 **`code` 不在 PATH**、`D:\Antigravity IDE\bin\antigravity-ide.cmd` 在。实测可用的命令：

```powershell
cd 'D:\kx\上海交大\academic-pdf-reader'

# 1) 门禁（全绿再往下）
npx tsc --noEmit
npm run lint
npm test                    # 297
npm run test:gate           # 40
npm run test:init
npm run test:html
npm run test:pdf            # 48
node scratch/scan_secrets.js
node scratch/check_version.js

# 2) 打包（版本号已在工作区里；如果又改了代码，先想清楚要不要再升一版）
npm run vsix                # → academic-pdf-reader-1.3.9.vsix（prevsix 会校验 CHANGELOG 章节）

# 3) 装到两个 IDE（顺序必须是"先卸载登记、再装"，否则注册表可能还指向旧的）
& 'E:\VScode\Microsoft VS Code\bin\code.cmd' --uninstall-extension paper-reader.academic-pdf-reader --force
& 'E:\VScode\Microsoft VS Code\bin\code.cmd' --install-extension 'D:\kx\上海交大\academic-pdf-reader\academic-pdf-reader-1.3.9.vsix' --force
& 'D:\Antigravity IDE\bin\antigravity-ide.cmd' -n --uninstall-extension paper-reader.academic-pdf-reader --force
& 'D:\Antigravity IDE\bin\antigravity-ide.cmd' -n --install-extension 'D:\kx\上海交大\academic-pdf-reader\academic-pdf-reader-1.3.9.vsix' --force

# 4) 用**装进 IDE 的产物**跑冒烟 + 审计（最强的一层离线验证）
$env:VIEWER_PATH = "$env:USERPROFILE\.vscode\extensions\paper-reader.academic-pdf-reader-1.3.9\media\viewer.js"
node scratch/smoke_init.js
$env:VIEWER_SRC = $env:VIEWER_PATH
node scratch/formula_audit.js                              # PDF 侧：期望 F1/F2/F3/F4 全 0
node scratch/ai_math_audit.js                              # AI 回答侧：期望 A1/A2 全 0
$env:PAPERS_DIR='D:\kx\上海交大\梯度校正测验\梯度校正测验'
node scratch/order_audit.js                                # 期望 违规页 7 / V1=0 V2=0
node scratch/vision_replay.js AOT 5                        # 某页"为什么这样"的第一站
Remove-Item Env:VIEWER_PATH,Env:VIEWER_SRC,Env:PAPERS_DIR

# 5) 提交打 tag 推送（发版脚本；-Bump none 表示沿用工作区里已经改好的 1.3.9）
powershell -NoProfile -File "$env:USERPROFILE\.dsh\skills\release-academic-pdf-reader\scripts\release.ps1" `
  -Bump none -Note "（写清这次又修了什么）"
```

**`-Bump none` 还是 `-Bump patch`？**
- 沿用 1.3.9（本次这批改动就算 1.3.9）→ `-Bump none`，脚本会跳过版本写入、直接跑门禁/打包/装本机/提交/tag/推送。
- 想把这批算 1.3.10 → 用 `-Bump patch`，脚本会自己插 `## [1.3.10]` 章节。
- 两种都行；**只要 1.3.9 没上传商店、没打 tag，它就还能复用**。

## 五、用户侧要做的（每次装完都要说一遍）

- **完全退出 IDE 再打开**（`Reload Window` 不切换扩展版本；VS Code 只在启动时扫描扩展目录）。
- 确认版本：**工具栏左上角的版本徽章** 与 AI 弹窗标题旁的版本号，应是 `v1.3.9`。
- 已经缓存的视觉判断**不用重跑**：手术与渲染都是每次渲染时按缓存的回包重放的。

## 六、已知的"不是 bug"，下次别当成新问题查

- **界面上出现带美元符的原文（`$Y \in \{0,1\}$`）**：那是 `renderMathSpan` 的兜底，
  说明 **KaTeX 没加载**（Webview DevTools 里看 `katex.min.js` 是不是 404），不是公式坏了。
  已实测两个 IDE 的 1.3.9 里 `media/katex/katex.min.js` 与 `.css` 都在、哈希与仓库一致。
  **排查顺序：先确认 IDE 完全重启、再看这个请求。**
- **同一段可能有两份译文缓存**（旧式抄残渣 / 新式模型自己写 `$...$`）：界面上显示哪一份由段落里的
  `cacheKey` 决定。用关键词搜存档时会看到两份，别以为是重复数据。
- **AI 回答里落单的 `$`**：模型有时少写/多写定界符。渲染器现在会把"配对出来的散文片段"判为散文、
  原样显示（不会再变成一整块红字），但那两个 `$` 仍会显示出来 —— 这是模型输出的问题，
  不是渲染 bug（`ai_math_audit.js` 的 A3 指标就是给它数的）。
- **AI 回答里"变量全变灰底代码块"**：那是模型用反引号包符号（渲染侧已按公式渲染兜底，
  提示词也已要求它改用 `$...$`）。下次遇到请先跑 `node scratch/_probe_ai_style.js <关键词>`
  看是 `$...$` 还是反引号 —— 两者对应的修法完全不同。
- **A5 显示"页存档里 0/11 公式段落带规范 LaTeX"**：不是 bug。页存档是**导出用的持久化快照**，
  用户机器上的历史数据是旧代码写的（快照里根本没有 `visionLatex` 字段）。
  **重新翻一遍那些页面**（触发重新归档）就会补上；看"提问时手里有没有规范式"应该看 A5b（当前 15/15）。
- **`order_audit.js` 剩余的 V3（9 条）**：都是"表格数据行/公式行被误判成正文"这类**分类**问题
  （段落以数字收尾、又被图表段落打断），与阅读顺序无关。AOT p1 的作者邮箱行同理。
- **AOT 第 4 页 segment #0 那处拆分仍会被跳过**：模型把"图内文字"和正文（相隔 3 段）
  当成一段来拆，按"只接没单独判过 split/drop 的段、最多 3 段"的保守规则接不起来 → 记 note 跳过。
  本地本来就已经把图和正文分成两段，跳过**不丢内容**，无需处理。
- **单栏页 / 无图表的页**：8.6 直接原样返回，不受本次改动影响。
- **`package-lock.json` 里的 version 是 1.1.0**：发版脚本从来不更新它，属既有状态，别顺手改。

## 七、这批改动的文件清单

```
 M CHANGELOG.md                     # 新增 ## [1.3.9] 章节（症状 + 修法 + 测试）
 M docs/design-notes.md             # 两节"未发布"：阅读顺序复盘、公式渲染 F1/F2/F3/F4
 M media/viewer.js                  # 两处修复（8.6 图表单元、9.5 跨栏续句、渲染入口、残渣清理、
                                    #   手术锚点解析 + 挪位、替换区间取真实长度）
 M package.json                     # 1.3.8 → 1.3.9
 M scratch/llm-test/viewer-unit.js  # +44 条真实数据回归（现 309 条）
 M scratch/paragraph_truth.js       # 支持 VIEWER_SRC（做 before/after 对照）
 M scratch/reading-order-fix-note.md# 标注"已完成"
?? scratch/formula_audit.js         # PDF 侧公式审计：F1 katex-error / F2 缺 latex / F3 孤儿组合符 / F4 译文被切坏
?? scratch/ai_math_audit.js         # AI 回答侧公式审计：A1 katex-error / A2 裸露数学 / A3 可见的字面 $
?? scratch/order_audit.js           # 阅读顺序审计（V1 栏序 / V2 图表单元 / V3 半句断裂）
?? scratch/order_summary.js         # 逐页对比 before/after 违规增减
?? scratch/order_diff.js            # 逐页对比段落序列差异
?? scratch/order_probe.js           # 打印某页每行 section/坐标/文本
?? scratch/vision_replay.js         # 某页"模型想怎么改 / 代码实际做了什么 / 哪些判断被跳过"
?? scratch/pending-release-1.3.9.md # 本说明
```

> 提醒：`scratch/` 也在 `git ls-files` 的密钥扫描范围内，提交前照例跑 `node scratch/scan_secrets.js`（已跑，0 命中）。
