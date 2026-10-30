# Bilingual Paper Reader (文献对照翻译阅读器)

专为学术论文研读设计的 **VS Code 双语阅读扩展**：**左侧原版 PDF、右侧对照翻译、公式按版面原图显示、双向高光联动、划线便签批注、一键导出双语精读稿**。

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/paper-reader.academic-pdf-reader.svg)](https://marketplace.visualstudio.com/items?itemName=paper-reader.academic-pdf-reader)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/SevenFriends7/academic-pdf-reader/blob/main/LICENSE)

**VS Code 插件市场一键安装**：[Bilingual Paper Reader](https://marketplace.visualstudio.com/items?itemName=paper-reader.academic-pdf-reader)

---

<!-- 截图必须用绝对 HTTPS 地址：VS Code 扩展详情页的 sanitizer 不允许相对图片路径
     （allowRelativeMediaPaths=false，CSP 也只放行 https: / data:），
     图片即使放在扩展目录里也不会显示。 -->

## 🖼️ 界面预览

| 左右对照与高光联动 | 划线与便签批注 | AI 论文问答 |
| :---: | :---: | :---: |
| ![双栏阅读](https://fastly.jsdelivr.net/gh/SevenFriends7/academic-pdf-reader@main/media/screenshots/01-reading-highlights.jpg) | ![批注笔记](https://fastly.jsdelivr.net/gh/SevenFriends7/academic-pdf-reader@main/media/screenshots/02-annotations.jpg) | ![AI 问答](https://fastly.jsdelivr.net/gh/SevenFriends7/academic-pdf-reader@main/media/screenshots/03-ai-qa.jpg) |

---

## ✨ 核心功能

1. **📖 双栏阅读与阅读顺序修复**
   - **左栏原版渲染**：基于 PDF.js 完整渲染原版 PDF，保留矢量清晰度与原始排版。
   - **智能分段**：自动识别单/双栏、修复跨栏续句与折行断词；图注/标题不再误吞正文。
   - **公式碎片合并**：同一视觉行里的公式上下标与正文合并成一条段落，不再把一段解释拆成十几张顺序错乱的卡片。

2. **🧮 智能公式展示（矢量 KaTeX + 版面原图按需结合）**
   - **单行独立公式矢量化**：单行独立公式若能完整重建为规范 LaTeX 且通过 KaTeX 校验，直接以高清矢量 KaTeX 渲染（免截图裁切、无模糊底噪、自动适配护眼/深色主题，支持复制 LaTeX 与「讲透这条公式」一键问 AI）。
   - **复杂多行结构版面裁图**：包含矩阵、多行优化方程、长求和积分等二维复杂结构的公式，自动走版面原图裁切，保证排版 100% 不走样。
   - **编号公式精准识别**：行尾带独立编号（如 `(1)`、`(2)`、`(3)`）的行间公式自动识别为公式卡并剥离编号，绝不误入翻译队列被当成正文糊成中文。
   - **行内公式与符号**：KaTeX 渲染，可选中、可复制；译文中行内符号（如 `(i, j)`、`Eq. 5`）按原文真实记号显示，不再被粗暴折叠为占位标记。
   - **符号表 / 术语表**（NOMENCLATURE、NOTATION、SYMBOLS…）：整块按版面原图显示，避免逐行硬拆导致符号被劈开。

3. **⚡ 鼠标划词双向高光联动**
   - **左选右亮**：在左侧 PDF 选中任意英文字句，右侧译文卡片立即高亮并自动滚动对齐。
   - **右点左闪**：点击右侧卡片或句对，左侧 PDF 精确定位到原文坐标，逐字符贴合。

4. **✍️ 划线高亮与便签批注**
   - **浮动工具条**：划选文字即弹出工具栏，提供 4 色荧光高亮（🟨核心要点 / 🟩实验数据 / 🟦方法公式 / 🟥疑难待查）、便签与即时翻译。
   - **批注管理**：按页汇总、修改、删除，永久保存在本地。

5. **📝 一键导出双语精读稿**
   - **Markdown**：按页生成「原文 → 双语对照 → 我的批注 → AI 答疑」，带 YAML 头部，可直接导入 Obsidian / Notion。
   - **高光批注 PDF**：按原文坐标绘制高光，附页边序号与译文批注附录，适合打印与分享。

6. **🤖 论文级 AI 导师问答**
   - 结合当前段落、公式和实验上下文提问，支持标准 / 简洁 / 专家等回答风格；聚焦公式时会带上规范 LaTeX 逐符号讲解。

---

## 🆕 最近更新

- **1.8.7**：无规则线表格也能认出来——"列网格 + 纯数字列"两条信号（评分表/消融表没有框线也不再被当正文翻译），参考文献按 `[n]` 一条一段；跨栏续接可以跳过页底脚注与行间公式，`super-` / `vised` 这种被栏边界折开的词能拼回去。
- **1.8.5**：跨页续接——一页排不下、被页边界切成两半的句子现在合成一张卡（本页首段小写开头 + 上一页末段未收句才合并，卡片标「⟵ 承接第 N 页」）；上一页的机构块、本页的表格行、`where …` 公式解释子句都不会被误粘。53 页基准 `lower-start` 63→43。
- **1.8.4**：CMMIB 的 ε 在文本层就归一化，`cleanText` 不再残留 U+000F 控制符（基准里 ctrl-glyph 33→14）。
- **1.8.3**：版式判断改为文档自适应 + 矢量结构（不依赖单篇论文常量）——脚注认页底分隔线、Algorithm 认上下框线、表格按通栏横线整块剔除；正文字号/页边距/公式基线全部按页面统计走，纯文本层 + 矢量图元，不用本地模型。
- **1.8.2**：修复 VAE 论文暴露的版面问题——算法伪代码不再被当正文翻译；页底脚注不再并进正文；`∫`/`∏`/`∑` 基线漂移的行内公式并回原行；∫/∏ 等短公式进 `⟦…⟧` 占位；裸 LaTeX 命令渲染前转 Unicode。
- **1.8.1**：从阅读器切到其他文件再切回来不再重新加载——保留页码、滚动位置与已加载的 PDF/译文；同时修多篇 PDF 切标签时导出用错论文数据的问题。
- **1.8.0**：纸张主题联动 VS Code——选「暗夜」纸张自动切到深色主题，切回白纸/羊皮/竹青或关闭阅读器恢复原主题；本来就是深色主题则不改。
- **1.7.4**：修复逐句对齐反复失败——`i.i.d.` / `w.r.t.` 等学术缩写与列表编号不再被当句末；整段译文句数与英文句数严格相等时自动按句对齐；「重新尝试逐句对齐 / 重译」现在会真正绕过宿主缓存重新请求。
- **1.7.3**：修复整页大表被误判为双栏导致的正文碎片（`7.05%.` 单独成段、列表项被拆开），表格注不再吞掉整张表；`Table 1 compares…` 这类正文引用不再把章节标题标成图表标签；编号列表项不再被当标题；公式段不再因单个符号片段被降级成正文。
- **1.7.2**：纯 LaTeX（Computer Modern）论文不再整篇被识别成公式——按整页字体统计区分 CMR/CMSS 正文与公式字体；连续编号式子不再拼成错误 LaTeX；作者栏人名与折行 URL/DOI 不再被公式吞掉。
- **1.7.1**：修复扩展详情页三张界面预览图不显示的问题（README 图片改为绝对 HTTPS CDN 地址）。
- **1.7.0**：智能公式展示模式——单行独立公式直接走高清矢量 KaTeX 渲染（跳过截图裁切，支持直接复制与 AI 答疑），复杂多行与矩阵保持原图裁切；修复编号式子（如 `(2)`、`(3)`）被误判为散文而漏卡/翻译胡乱糊词的问题；优化译文公式符号清洗与 PDF 句子划线高亮二次凝聚。
- **1.6.32**：文档重构与各模块说明完善。
- **1.6.31**：修复段落顺序（图注误判、公式碎片乱序）、公式裁图上下留白、符号表按版面原图显示；翻译回包后补裁图；混排段落送翻前清洗公式。
- **1.6.20**：新增**本地公式识别**（可选，默认关闭）：用本机 PP-FormulaNet 把公式裁图转成 LaTeX，供精读稿导出、问 AI 与公式索引使用。详见 [docs/formula-local-model.md](https://github.com/SevenFriends7/academic-pdf-reader/blob/main/docs/formula-local-model.md)。
- 完整版本记录见 [CHANGELOG.md](https://github.com/SevenFriends7/academic-pdf-reader/blob/main/CHANGELOG.md)。

---

## 🔑 翻译引擎与 API Key 配置

插件支持三种翻译引擎，**选模型、填 Key 即可使用**：

### 1. 内置免费翻译（开箱即用）
无需 API Key。打开 PDF 后点击右上角 **「设置」→「切换为内置免费翻译引擎」**。

### 2. DeepSeek / OpenAI 兼容大模型（推荐）
支持 DeepSeek (`deepseek-chat` / `deepseek-reasoner`)、Kimi、通义千问、智谱 GLM、OpenAI (GPT-4o) 等。

1. 打开任意 PDF，点击右上角 **「设置」**；
2. 选择 **「配置模型 API (DeepSeek / Kimi / 通义 / OpenAI …)」**；
3. 从列表选择模型（会自动带出 API 端点 URL）；
4. 粘贴 API Key 保存。

DeepSeek Key 可在 [platform.deepseek.com](https://platform.deepseek.com/) 创建。

### 3. Google Gemini 官方 API（学术理解强，有免费额度）
1. 点击 **「设置」→「配置 Google Gemini API Key」**；
2. 粘贴 [Google AI Studio](https://aistudio.google.com/app/apikey) 创建的 Key，插件会自动校验。

> 💡 也可通过 `Ctrl+Shift+P` → `配置学术翻译引擎`，或在 VS Code 设置中搜索 `academicReader` 调整并发、目标语言、问答风格等。

---

## 🧠 本地公式识别（可选）

默认关闭，不影响正常阅读。开启后，插件会把**已经裁好的公式图**交给本机 PP-FormulaNet 识别成 LaTeX：

- 需要本机安装 Python + `paddleocr`（CPU 即可）；
- 命令面板搜索 **「启用本地公式识别」** 可自动探测并写入 `formulaModel.pythonPath`；
- 识别结果要过字符守恒校验（覆盖率、多余字符、结构合法性），不通过就保留原图；
- **不参与找框**：框仍由 PDF 文本层决定，模型只负责"框里是什么"。

安装与排错见 [py/README.md](https://github.com/SevenFriends7/academic-pdf-reader/blob/main/py/README.md) 与 [docs/formula-local-model.md](https://github.com/SevenFriends7/academic-pdf-reader/blob/main/docs/formula-local-model.md)。

---

## ⚙️ 常用设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `academicReader.formulaAsImage` | `true` | 独立公式按版面原图裁切；关闭则用 KaTeX 重建 |
| `academicReader.followPaperTheme` | `true` | 选「暗夜」纸张时把 VS Code 切到深色主题；切回浅色纸张/关闭阅读器时恢复原主题 |
| `academicReader.retainPdfContext` | `true` | 切到其他文件再回来不重新加载 PDF（保留页码/滚动/译文）；关闭可省内存，需 Reload Window |
| `academicReader.paperThemeDark` | `Default Dark Modern` | 「暗夜」纸张对应的 VS Code 颜色主题名 |
| `academicReader.segmentationEngine` | `local` | `local` 纯本地；`auto` 可疑页请视觉模型；`vision` 每页都请视觉模型 |
| `academicReader.visionModel` | 空 | 视觉分割使用的多模态模型（如 `deepseek-flash`、`qwen-vl-max`） |
| `academicReader.visionSurgery` | `true` | 允许视觉模型合并/拆分段落（只改分段，不动坐标） |
| `academicReader.formulaModel.enabled` | `false` | 启用本地公式识别 |
| `academicReader.formulaModel.pythonPath` | 空 | 装了 paddleocr 的 Python 解释器路径 |
| `academicReader.translateConcurrency` | `3` | 同时翻译请求数（1~8），遇到限流可调低 |
| `academicReader.targetLanguage` | `zh-CN` | 目标语言 |
| `academicReader.autoTranslate` | `true` | 翻页时自动翻译当前页 |

---

## 📦 安装方式

### 方式 1：VS Code 插件市场（推荐）
在扩展面板（`Ctrl+Shift+X`）搜索 **`Bilingual Paper Reader`**，点击安装。

### 方式 2：VSIX 离线安装
下载 `academic-pdf-reader-<version>.vsix`：
1. 打开 VS Code，按 `Ctrl+Shift+X`；
2. 点击右上角 **`...` → “从 VSIX 安装...”**；
3. 选择 `.vsix` 文件。

命令行安装：

```bash
code --install-extension academic-pdf-reader-<version>.vsix --force
```

---

## 🔒 数据与隐私

- 译文、批注、精读稿缓存保存在本机扩展存储目录，不上传服务器。
- API Key 保存在 VS Code 设置中；只有翻译 / AI 问答请求会发送到你所配置的模型端点。
- 视觉分割开启时，会把**当前页截图**发送给你配置的视觉模型；不需要时可将 `segmentationEngine` 设为 `local`。

---

## 📄 许可证与开源声明

- 遵循 [MIT License](https://github.com/SevenFriends7/academic-pdf-reader/blob/main/LICENSE)。
- 内嵌 [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) 与 [KaTeX](https://github.com/KaTeX/KaTeX) (MIT)，第三方声明详见 [THIRD-PARTY-NOTICES.md](https://github.com/SevenFriends7/academic-pdf-reader/blob/main/THIRD-PARTY-NOTICES.md)。
- 欢迎提交 [Issues](https://github.com/SevenFriends7/academic-pdf-reader/issues) 或 Pull Request。
