# Bilingual Paper Reader (文献对照翻译阅读器)

专为学术论文研读设计的 **VS Code 双语阅读扩展插件**：**左栏原版 PDF、右栏智能对照翻译、双向高光联动、划线便签批注、公式 KaTeX 渲染、一键导出双语精读笔记**。

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/paper-reader.academic-pdf-reader.svg)](https://marketplace.visualstudio.com/items?itemName=paper-reader.academic-pdf-reader)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**VS Code 插件市场一键安装**：[Bilingual Paper Reader](https://marketplace.visualstudio.com/items?itemName=paper-reader.academic-pdf-reader)

---

## 🖼️ 界面预览

| 左右对照与高光联动 | 划线与便签批注 | AI 论文问答 |
| :---: | :---: | :---: |
| ![双栏阅读](media/screenshots/01-reading-highlights.jpg) | ![批注笔记](media/screenshots/02-annotations.jpg) | ![AI 问答](media/screenshots/03-ai-qa.jpg) |

---

## ✨ 核心功能

1. **📖 双栏排版与智能版面重构**
   - **左栏原版渲染**：基于 PDF.js 完整渲染原版 PDF，保留矢量清晰度与原始排版。
   - **智能分段与去噪**：自动识别单双栏排版、修复折行断词与连字符，图表内部碎片标签自动过滤，表格数据行整洁归纳，告别碎片式机翻。
   - **公式原生渲染**：正文行内与独立公式统一采用 KaTeX 规范渲染，公式编号 `(1)`、`(2)` 自动吸附，不污染正文翻译。

2. **⚡ 鼠标划词双向高光联动**
   - **左选右亮**：在左侧 PDF 选中任意英文字句，右侧译文卡片立即触发呼吸灯微光高亮，并自动平滑滚动对齐。
   - **右点左闪**：点击右侧卡片或句对，左侧 PDF 瞬间定位到原文所在页面与物理坐标，逐字符级精准贴合。

3. **✍️ 划线高亮与便签批注**
   - **浮动工具条**：划选文字即弹出工具栏，提供 4 色荧光高亮笔（🟨核心要点 / 🟩实验数据 / 🟦方法公式 / 🟥疑难待查）、添加个人便签、即时单词翻译。
   - **批注管理**：右上角一键切换批注库，支持按页汇总、修改、删除并永久保存在本地。

4. **📝 一键导出双语精读稿**
   - **Markdown 精读稿**：按页交织生成「原文段落 → 双语对照 → 我的批注 → AI 答疑」，带标准 YAML 头部，无缝导入 Obsidian、Notion。
   - **高光批注 PDF**：按原文绝对坐标绘制高光，附带页边距序号与译文批注附录，适合打印和分享。

5. **🤖 论文级 AI 导师问答**
   - 针对论文当前上下文、公式和实验提问，结合规范 LaTeX 深入解析原理，支持学术审稿人与速览等回答风格。

---

## 🔑 翻译引擎与 API Key 配置指南

插件支持三种翻译引擎，**无需复杂配置 Base URL，选模型填 Key 即可使用**：

### 1. 内置免费翻译（开箱即用，0 门槛）
- **特点**：无需申请或配置任何 API Key，安装后即可直接阅读翻译。
- **配置方法**：打开 PDF 后，点击阅读器右上角 **「设置」图标 → 选择「切换为内置免费翻译引擎」** 即可。

### 2. DeepSeek / OpenAI 兼容大模型（国内直连推荐，性价比极高）
- **支持模型**：DeepSeek (`deepseek-chat` / `deepseek-reasoner`)、Kimi、通义千问、智谱 GLM、OpenAI (GPT-4o) 等。
- **获取 API Key**：
  - 前往 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册并创建 API Key。
- **快速配置**：
  1. 打开任意 PDF，点击右上角 **「设置」图标**；
  2. 选择 **「配置模型 API (DeepSeek / Kimi / 通义 / OpenAI …)」**；
  3. 从列表中选择您使用的模型（如 `deepseek-chat`，系统会**自动带出 API 端点 URL**）；
  4. 粘贴您的 API Key 保存即生效。

### 3. Google Gemini 官方 API（学术理解强，有免费额度）
- **获取 API Key**：
  - 访问 [Google AI Studio](https://aistudio.google.com/app/apikey) 免费创建 API Key。
- **快速配置**：
  1. 点击右上角 **「设置」图标**；
  2. 选择 **「配置 Google Gemini API Key」**；
  3. 粘贴 API Key，插件会自动检测并校验可用性。

> 💡 **高级配置**：可通过 `Ctrl+Shift+P` 打开命令面板输入 `配置学术翻译引擎`，或在 VS Code 设置 (`Ctrl+,`) 中搜索 `academicReader` 调整并发数、目标语言与问答风格。

---

## 📦 安装方式

### 方式 1：VS Code 插件市场安装（推荐）
在 VS Code 扩展面板（`Ctrl+Shift+X`）搜索 **`Bilingual Paper Reader`**（或搜索「文献翻译」），点击 **安装** 即可。

### 方式 2：VSIX 离线安装
下载发包提供的 `academic-pdf-reader-x.y.z.vsix` 文件：
1. 打开 VS Code，按 `Ctrl+Shift+X` 打开扩展面板；
2. 点击扩展面板右上角 **`...`（更多操作）** → 选择 **“从 VSIX 安装... (Install from VSIX...)”**；
3. 选择下载的 `.vsix` 文件完成安装。
*(命令行安装：`code --install-extension academic-pdf-reader-x.y.z.vsix --force`)*

---

## 📄 许可证与开源声明

- 遵循 [MIT License](LICENSE)。
- 内嵌 [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) 与 [KaTeX](https://github.com/KaTeX/KaTeX) (MIT)，第三方开源声明详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
- 欢迎提交 [Issues](https://github.com/SevenFriends7/academic-pdf-reader/issues) 或 Pull Requests 共同改进！
