# Bilingual Paper Reader

> 学术论文双语对照阅读器（文献对照翻译阅读器）

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/paper-reader.academic-pdf-reader?label=Marketplace&color=0b578a)](https://marketplace.visualstudio.com/items?itemName=paper-reader.academic-pdf-reader)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/paper-reader.academic-pdf-reader?label=安装量)](https://marketplace.visualstudio.com/items?itemName=paper-reader.academic-pdf-reader)
[![CI](https://github.com/SevenFriends7/academic-pdf-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/SevenFriends7/academic-pdf-reader/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

专为学术论文研读设计的 VS Code / 反重力 IDE (Antigravity IDE) 扩展插件：**左栏文献原文、右栏译文对照、鼠标划词实时双向高光联动、划线高亮与便签批注、一键导出 Markdown 笔记**。

**在扩展市场安装**：[paper-reader.academic-pdf-reader](https://marketplace.visualstudio.com/items?itemName=paper-reader.academic-pdf-reader)

---

## ✨ 核心特性

### 1. 📖 双栏文献对照阅读
- **左栏**：基于 PDF.js 完整渲染原版 PDF 文献，支持缩放（放大、缩小、适合宽度）、跳转翻页、高保真文字层（Text Layer）。
- **右栏**：支持【逐句精读】与【连贯段落】双模式自由切换，智能段落重组器（自动修复跨行断词与连字符，如 `differ- \n ent` 拼合），告别机械机翻的碎片感。
- **自由分栏**：中间配备可拖拽的 Splitter 分割条，随心调整左右视窗比例。

### 2. ⚡ 鼠标划词双向高光联动
- **左选右亮**：在左侧 PDF 中使用鼠标选中任意单词或句子，右侧对应的段落翻译卡片立即触发**发光呼吸灯高亮（Glow Highlight）**，并自动平滑滚动至视野正中，快速定位理解。
- **右点左闪**：点击右侧翻译卡片的“定位”按钮或段落本身，左侧 PDF 自动平滑滚动到该段落所在页面与位置，并以动态微光高亮闪烁，实现完美的双向视觉对齐。

### 3. ✍️ 划线高亮与便签批注
- **划词悬浮菜单 (Floating Action Bar)**：选中文字瞬间浮出 Notion 风格的工具条：
  - **4 色荧光笔高亮**：🟨 核心要点 / 🟩 论据数据 / 🟦 公式方法 / 🟥 疑难待查。
  - **添加批注便签**：记录个人理解、推导公式、文献对比心得。
  - **即时查词/译句**：无需切换页面，悬浮气泡即时展现当前短语的精准译文。
- **批注库管理**：右上角切换【批注笔记】视图，所有批注按页码聚合，支持点击一键跳转原文、修改、删除。
- **自动持久化**：所有批注与翻译缓存均自动保存在本地，下次打开同一篇文献无需重复翻译，所有标记与批注永久保留。

### 4. 📝 一键导出 Markdown 研读笔记
- 点击顶部【导出笔记】，自动生成结构化、美观的 Markdown 笔记文件（含原文字句、对照翻译、页码、高亮分类、个人批注与思考），无缝导入 **Obsidian**、**Notion** 或个人知识库。

### 5. 🌐 灵活强大的翻译引擎
- **Google Gemini 官方 API**：专为学术论文研读调优的学术 Prompt，术语地道严谨，公式与引用规范完整保留，Google AI Studio 提供免费额度。
- **自定义大模型 (DeepSeek / Kimi / 通义 / 智谱 / OpenAI / 本地模型)**：兼容 OpenAI 标准接口，国内直连、性价比高。设置里直接选常用模型，端点自动带出，只需填 API Key。
- **开箱即用 (内置免费翻译)**：无需申请任何 API Key，安装即可直接使用基础翻译。

> 翻译与 AI 问答共用所选引擎；问答会在提问界面标明"论文内容"与"通用背景知识"的来源区别。

---

## 📦 安装

### 方式一：扩展市场安装（推荐）

在扩展面板（`Ctrl+Shift+X`）搜索 **`文献对照翻译阅读器`** 或 **`academic-pdf-reader`**，点击安装即可；后续版本会自动更新。

或直接打开商店页面：[paper-reader.academic-pdf-reader](https://marketplace.visualstudio.com/items?itemName=paper-reader.academic-pdf-reader)

### 方式二：从 VSIX 安装（离线 / 内网环境）

先取得 `academic-pdf-reader-x.y.z.vsix`，然后：

**在反重力 IDE (Antigravity IDE) 中安装**

1. 打开反重力 IDE。
2. 点击左侧活动栏的 **扩展市场** 图标（或按快捷键 `Ctrl+Shift+X`）。
3. 点击扩展视图右上角的 **`...` (更多操作)** 菜单。
4. 选择 **“从 VSIX 安装... (Install from VSIX...)”**。
5. 选中 `.vsix` 文件即可安装完成。

> 命令行等价写法：
> ```bash
> antigravity-ide.cmd --install-extension academic-pdf-reader-x.y.z.vsix --force
> ```

**在 VS Code 中安装**

1. 按 `Ctrl+Shift+X` 打开扩展面板。
2. 点击右上角 `...` 菜单 → 选择 **“从 VSIX 安装... (Install from VSIX...)”**。
3. 选中 `.vsix` 文件完成安装。

> 命令行等价写法：
> ```bash
> code --install-extension academic-pdf-reader-x.y.z.vsix --force
> ```

安装后**需要重启 IDE（或执行 `Developer: Reload Window`）**才会生效。

---

## 🔑 如何配置自己的 API Key

安装完成后，打开任意 PDF 文献，有以下 3 种方式配置个人 API Key：

### 方式一：在文献阅读界面点击【⚙️ 设置】（最推荐、最直观）
1. 在双栏阅读器右上角顶部工具栏，直接点击 **`⚙️ 设置`** 按钮。
2. 屏幕上方会弹出交互式快捷菜单：
   - **`🔑 配置 Google Gemini API Key (推荐)`**：点击后直接粘贴你的 Gemini Key，保存即生效；
   - **`🤖 配置自定义大模型 (DeepSeek / OpenAI / Kimi)`**：逐步输入 API Key、Base URL 与模型名称；
   - **`🌐 切换为内置免费翻译引擎`**：无需任何 Key，直接联网翻译；
   - **`⚙️ 打开完整插件设置页面`**：进入可视化图形设置面板。

### 方式二：通过快捷指令配置 (Command Palette)
1. 按下快捷键 `Ctrl+Shift+P`（或 `F1`）。
2. 输入 **`文献阅读`**，选择：
   - **`文献阅读：配置翻译引擎与 API Key`**（打开设置向导）；
   - 或 **`文献阅读：设置 Google Gemini API Key`**（直接填入 Key）。

### 方式三：在 IDE 设置中心自定义 (Settings GUI)
按下 `Ctrl+,` 打开设置，搜索 **`academicReader`**，即可按需修改全部配置项：

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `academicReader.translationService` | `gemini` | 翻译引擎选择：`gemini` (官方 API，推荐) / `openai-compatible` (自定义大模型) / `built-in` (免费免 Key) |
| `academicReader.geminiApiKey` | `""` | 你的 Google Gemini API Key |
| `academicReader.geminiModel` | `gemini-2.0-flash` | Gemini 模型选择 (`gemini-2.0-flash`, `gemini-1.5-flash`, `gemini-1.5-pro`) |
| `academicReader.apiEndpoint` | `https://api.deepseek.com/v1` | 自定义大模型 Base URL（如 DeepSeek、Kimi、OpenAI 端点） |
| `academicReader.apiKey` | `""` | 自定义大模型 API 密钥 |
| `academicReader.modelName` | `deepseek-chat` | 自定义大模型名称（如 `deepseek-chat`, `gpt-4o-mini`） |
| `academicReader.targetLanguage` | `zh-CN` | 目标翻译语言（简体中文、繁体中文、英文、日语等） |
| `academicReader.autoTranslate` | `true` | 翻页时是否自动预解析并翻译当前页段落 |

---

## 💡 常用 API Key 获取与推荐

### 1. 免费申请 Google Gemini API Key（30 秒获取）
1. 访问 [Google AI Studio](https://aistudio.google.com/app/apikey)；
2. 登录 Google 账号，点击 **"Create API key"**；
3. 复制生成的以 `AIzaSy...` 开头的密钥；
4. 在阅读器顶部点击【设置】->【配置 Google Gemini API Key】粘贴即可！
> Google AI Studio 拥有充裕的免费并发额度，学术论文翻译质量极高，推荐作为第一选择。

### 2. 国内用户推荐配置 DeepSeek
1. 访问 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册并获取 API Key；
2. 在阅读器顶部点击【设置】->【配置自定义大模型】：
   - API Key: `sk-xxxxxxxxxxxxxxxx`
   - API 端点: `https://api.deepseek.com/v1`
   - 模型名称: `deepseek-chat`
> DeepSeek 的学术翻译自然通顺，计费极低，非常适合国内科研人员。

---

## 🛠️ 开发者本地构建

```bash
# 1. 安装依赖
npm install

# 2. 编译代码
npm run compile

# 3. 一键打包并安装为 .vsix（会同时装到本机的 VS Code 与反重力 IDE）
npm run package
```

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run compile` | 编译 `src/*.ts` → `dist/extension.js` |
| `npm run watch` | 监听改动自动重编译（改 `src/` 时用） |
| `npm run package` | **仅供本机安装**：打包 `*-local.vsix` 并装到本机两个 IDE |
| `npm run vsix` | **用于上传商店**：用官方 `vsce` 打包标准 `.vsix` |
| `npm run ls:pack` | 列出 `vsce` 实际会打包的文件（上传前自查） |

> ⚠️ **两个产物不要混用。** `npm run package` 的 `*-local.vsix` 是本脚本手写 manifest 打出来的，
> 本机 IDE 安装没问题，但**上传扩展市场会报 `Error occurred while parsing the manifest file`**
> （市场的 manifest 校验更严格，要求 `<Properties>` 引擎声明、图标/许可证 `<Asset>` 等字段）。
> 上传商店、Open VSX、以及 CI 产物，一律用 `npm run vsix`（即官方 `vsce package`）。

修改 `media/viewer.js` / `media/viewer.css` 不需要编译，但**需要重启 IDE（或 `Developer: Reload Window`）**才生效。

### 测试

```bash
node scratch/llm-test/viewer-unit.js   # webview 侧单元测试（无需 API Key）
node scratch/scan_secrets.js           # 提交前密钥扫描
```

版面诊断工具（需要论文 PDF）：

```bash
PAPERS_DIR=/path/to/papers node scratch/audit_papers.js        # 全论文逐页审计
PAPERS_DIR=/path/to/papers node scratch/layout_truth.js 3      # 打印某页真实行分类
```

---

## 🚀 维护者：发布新版本

发布自动化已经配好，日常只需要三步。

### 1. 首次准备（只做一次）

**第 1 步：注册发布者**（必做）

1. 用 Microsoft 账号登录 <https://marketplace.visualstudio.com/manage>
2. 点 **Create publisher**：
   - **ID** 填 `paper-reader`（必须与 `package.json` 的 `publisher` 完全一致，创建后不可改）
   - **Name** 任意（商店页显示的名字）

**第 2 步：上架第一个版本**

有两条路，**优先走 A**——它不需要 PAT，也不需要 Azure 订阅：

| 路线 | 需要什么 | 适合 |
| --- | --- | --- |
| **A. 手动上传（推荐先走这条）** | 只要 Microsoft 账号 | 首次上架、偶尔发版 |
| **B. `vsce publish` 自动发布** | Azure DevOps 的 PAT | 频繁发版、想用 CI 全自动 |

**路线 A**：从 [GitHub Releases](https://github.com/SevenFriends7/academic-pdf-reader/releases) 或本机 `npm run vsix` 拿到 `.vsix`，
在 publisher 页面点 **New extension → Visual Studio Code** 上传即可。商店几分钟后可见。

**路线 B**：需要一个 PAT（见下方"关于 PAT"），然后：

```bash
npm run login          # 粘贴 PAT
npm run publish:patch  # 或 minor / major
```

**第 3 步（可选）：让 CI 全自动发布**

在仓库 **Settings → Secrets and variables → Actions** 添加 `VSCE_PAT`（路线 B 的 PAT）。
配好之后，`git push --follow-tags` 推 tag 就会自动发版；**没配也不会失败**，CI 只打包并上传 vsix 产物。

（可选）如果用户群体里有 VS Code 的**分支发行版**（VSCodium、各类国产 IDE 等），它们用的是 Open VSX，
需要另外在 <https://open-vsx.org> 注册并配置 `OVSX_PAT`。

#### 关于 PAT（路线 B 的前提，务必先读）

- **新建 Azure DevOps 组织现在要求「有效的 Azure 订阅」**
  （见 [Create an organization](https://learn.microsoft.com/azure/devops/organizations/accounts/create-organization)），
  没有订阅时这一步会卡住；可行替代是被加入一个已有的 Azure DevOps 组织再建 PAT。
- **全局 PAT 将于 2026-12-01 退役**，微软官方建议改用 Entra ID 方式发布。
- PAT 的 Scope 只需勾 **Marketplace → Manage**（Organization 选 "All accessible organizations"）。
- 生成入口有两处，哪个有就用哪个：
  1. Azure DevOps → User settings → Personal access tokens；
  2. Visual Studio Marketplace 的 publisher 页面 → **Security / PAT** 分区（部分账号直接提供）。
- 备选方案（都不成熟/有前提，暂时不推荐踩）：
  `vsce publish --oidc`（Trusted Publishing，无需任何 Azure 资源，但社区尚无成功验证）与
  `vsce publish --azure-credential`（需 Azure 托管标识，有成功先例但要 Azure 资源）。

### 2. 发布（二选一）

**本机发布**

```bash
# 先在 CHANGELOG.md 顶部写好本次改动，然后：
npm run publish:patch    # 修 bug / 改文案
npm run publish:minor    # 新增功能（兼容）
npm run publish:major    # 破坏性变更（改配置项名、改扩展 ID 等）
```

`publish:*` 会自动改 `package.json` 里的 version、触发编译、打包并上传。

**CI 发布（推荐）**

```bash
npm version patch        # 或 minor / major：改版本号并打 tag
git push --follow-tags
```

推 tag 后 GitHub Actions（`.github/workflows/release.yml`）会自动：
类型检查 → 单元测试 → 密钥扫描 → 校验 tag 与 package.json 版本一致 → 打包 →
发布到 Marketplace / Open VSX → 挂到 GitHub Release。

需要在仓库 **Settings → Secrets and variables → Actions** 里配置 `VSCE_PAT`（和可选的 `OVSX_PAT`）。

### 3. 注意事项

- **扩展 ID 一旦上架就不能改**（`paper-reader.academic-pdf-reader`）。改了就是另一个扩展，
  用户的设置与批注不会跟过去。
- 配置项名（`academicReader.*`）属于兼容性契约，重命名要按 major 走并在 CHANGELOG 里写迁移说明。
- 发布前建议先 `npm run package` 装到本机点一遍，再 `npm run ls:pack` 确认打包清单没有多余文件。
- 撤回用 `vsce unpublish`，但商店政策限制很严，会影响已有安装，尽量靠"发新版本修复"。

---

## 📌 v0.2.8 四个问题的修复

### 一、图注被双栏设定劈成左右两截（已修）

**根因**：分栏判定是按**单个 span** 做的（`sw > 320` 只看这一个 span 的宽度，列归属只看这一个
span 的中心）。而 PDF 常把一条图注拆成多个窄 span：

```
"Figure 3." + "Overview of the proposed" + "framework." + "for segmentation."
   └─ 被判左栏 ┘└──────── 被判左栏 ────────┘└─ 被判右栏 ─┘└──── 被判右栏 ────┘
```

于是同一行文字被劈进左右两栏。**改成先聚"物理行"，再用整行跨度判定**，同一行的所有片段
必然进同一栏。

**过程中踩到的陷阱**（值得记下来）：第一版"按 y 聚行"是错的——真实双栏论文里
**左右两栏的文字共享同一个 y 坐标**，按 y 聚行会把左右栏并成"整页宽的一行"，
于是每行都变成"通栏"、整页正文被判成图表注并合成一个巨大段落。修正为：
聚行除了 y 相近，还要求**横向间隙 ≤25pt 且该间隙不能是那条分栏沟槽**。

同时**单双栏判定也换了判据**：不再靠"行是否横跨中线"推断，而是直接看
"分栏线两侧是否都各自存在大量完全位于一侧的正文片段"。证据不足时偏向按单栏处理——
单栏页被误判成双栏会把整页并成一个巨大段落（严重），反过来只是改成按 y 排序，通常仍正确。

### 二、中文译文直接照搬原文（已修）

**根因**：我只校验了"句数是否对得上"，**从没校验过译文到底是不是中文**。
模型把英文原样吐回来时句数完全正确，于是被当成"翻译成功"直接显示。

**改法**：新增译文质量校验——中文字符占比 <25%，或与原文相似度 >0.9（疑似照搬），
即判定不合格。不合格会**带着原因重试一次**；仍不合格则如实报错（卡片显示"翻译未通过校验"），
绝不把英文当中文译文展示。校验同时接在逐句、整段、划词三条路径上。
纯短内容（公式、编号、缩写，拉丁字母 <8 个）跳过校验，避免误报。

### 三、第二页开始翻译很慢（已修）

**根因不只是并发数**，而是**免费档 Key 的每分钟请求数（RPM）限制**：逐段翻译时一页 20 段
就是 20 次请求，必然 429，而重试退避又把每次拖慢几秒——越翻越慢。

**改法**：扩展侧新增**请求合并队列**——把 120ms 内到达的多个段落合并成**一次** API 调用
（一批 4 段），请求数直接降到 1/4。协议完全不变，仍按原样逐段回包，所以前端渲染逻辑一行没动。
批量里个别段落不合格的，再单独重试那几段（部分成功不会整批作废）。
同时把前端翻译队列的并发从 2 提到 6，让请求能更快到达以凑批。

### 四、DeepSeek 现在是可以真正替代的选项

原来 `translationService: openai-compatible` 走的是"整段一次 + 每句各一次"的 N+1 次请求，
既慢又丢上下文——切过去只会更差。现在**升级成与 Gemini 同一套流程**：
一次请求拿「整段 + 严格逐句」，同样做句数与语言校验、不合格带原因重试，
并自动处理不支持 `response_format: json_object` 的兼容接口。

切换方式：命令面板 →「配置学术翻译引擎与 API Key」→ 选「配置自定义大模型」，
端点 `https://api.deepseek.com/v1`、模型 `deepseek-chat`、填入 DeepSeek Key 即可。
（该路径我**没有可用 Key 实测**，逻辑与校验已就位；若你有 Key 我可以跑一遍端到端验证。）

### 五、文案精简（去掉不必要的 emoji 与"高大上"说法）

- `双栏学术对照` → **对照翻译**；副标题 `支持划选即译与沉浸阅读` → **划选即译**
- 主题胶囊：`☀️ 白纸 / 📜 羊皮 / 🌿 竹青 / 🌙 暗夜` → `白纸 / 羊皮 / 竹青 / 暗夜`，
  提示语也从"羊皮暖阳(经典护眼暖色)"这类改成"护眼暖色"
- 段落类型标签：`👑 论文大标题` → `论文标题`、`📝 正文` → `正文` 等 10 项
- 卡片/逐句按钮：`🎯 定位 / 🤖 问AI / ✍️ 笔记 / 📋 译文 / 📋 原文` → 去掉 emoji
  （顺带也减轻了窄栏下的宽度压力）
- 右键菜单、批注气泡、筛选条、提示消息全部去 emoji；`⚙️ 翻译设置` → `翻译设置`、
  `⚡ 整页大模型精译` → `整页翻译`、`🔍 适合页面宽度` → `适合页面宽度`
- **保留**：`⚠️`（表示错误/警告）与 `✅ 已复制`（操作成功反馈）——有语义价值，不是装饰

---

## 📌 v0.2.7 自动适应窗口宽度

### 需求
左侧 PDF 自动适应窗口大小，同时**手动缩放仍然可用**。

### 实现要点
- **默认进入自动模式**：打开文档时先算出贴合比例再渲染（不会先用旧比例渲染一帧再跳变）。
- **贴合逻辑放在渲染入口**，不只挂在 resize 上 —— 这样翻到横向大图页、切换纸张主题、
  窗口变化后的重渲染都会自动贴合，不会横向溢出。
- **手动缩放优先**：点 `+`/`-`、Ctrl+滚轮、Ctrl+0 都会把自动模式关掉
  （否则用户刚放大，容器一变就被自动比例冲掉）。点顶栏「适合宽度」可重新回到自动模式，
  该按钮在自动模式下会高亮，鼠标悬停有状态说明。
- **用 `ResizeObserver` 而不是 `window.resize` 监听左栏**：拖动中间分割线并**不改变窗口尺寸**，
  但会改变左栏宽度，`window.resize` 完全收不到这个事件。
- **拖动过程用 CSS transform 给即时反馈**，停稳 220ms 后再按最终宽度重渲染
  （重渲染开销大，逐帧做会卡）。
- **可用宽度实测而非写死**：旧代码是 `pdfPane.clientWidth - 48`，实际容器左右内边距为 0，
  等于白白浪费三十多像素、页面贴不满。现在用容器的 `clientWidth`（已排除滚动条）
  减去实测内边距，再留 8px 呼吸空间。
- 比例夹在 `0.3 ~ 3.5`；可用宽度低于 120px 时放弃缩放（极端窄栏下不做无意义的强行缩放）。

### 手动缩放入口（都会自动切到手动模式）
| 操作 | 说明 |
|---|---|
| 顶栏 `+` / `-` | 每次 ±0.2 |
| `Ctrl` + 鼠标滚轮 / 触控板捏合 | 以鼠标位置为锚点缩放 |
| `Ctrl` + `+` / `-` | 每次 ±0.15 |
| `Ctrl` + `0` | 回到 100% |
| 顶栏「适合宽度」 | **恢复自动适应模式**（按钮高亮表示处于自动模式） |

---

## 📌 v0.2.6 界面修复说明

### 三、逐句行的「问AI / 笔记」把正文挤成细长条（已修）

**根因**：`.sent-row-actions` 是 `flex-shrink: 0` 的**常驻**子项，无论看不看得清，
都固定占掉约 **150px**（`🤖 问AI` + `✍️ 笔记` + `🎯` + 两个间距）。
侧边栏一窄，`flex: 1` 的 `.sent-content` 就只剩一百多像素，中英文双双被压成细长条。

**改法**：把这一组按钮改成**悬停浮现的浮层**——`position: absolute`（脱离文档流，
不再吃宽度）+ 默认 `opacity: 0; pointer-events: none`，在
`:hover` / `.active-sentence-row` / `:focus-within` 时才浮现。
`:focus-within` 保证纯键盘 Tab 也能唤出，不会变成"鼠标专属功能"。
浮层底色跟随行的悬停/选中底色，避免出现补丁块。

顺带把占宽的地方再收一点：行间距 12px → 10px、序号圆点 22px → 20px。
未对齐的段落现在也带上了这组按钮（浮层不占宽，所以是"白送"的）。

正文列在窄栏下大约**多出 150px**（近乎翻倍）。

### 四、卡片操作栏在窄侧边栏下溢出（已修）

**根因**：`.card-actions` 用的是 `flex-wrap: nowrap`，而 flex 子项默认 `min-width: auto`
（不会收缩到内容宽度以下）。侧边栏一拉窄，这一行就无法折行也无法压缩，最右侧按钮直接捅出
卡片边界。文件里还有**两处** `.card-actions` 规则，两处都写了同一问题。

**改法**：两处规则都改为 `flex-wrap: wrap` + `justify-content: flex-end` + `min-width: 0`，
并让 `.trans-card-header` 也可换行（窄栏时按钮组自动折到第二行、右对齐）。

### 五、AI 问答界面去花哨（已简化）

| 项目 | 原来 | 现在 |
|---|---|---|
| 弹窗标题 | `🤖 AI 学术文献导师 · 深度答疑` | `AI 学术文献导师` |
| 标题栏背景 | 紫色渐变 | 普通次级背景 |
| 弹窗动画 | `scale + translateY` 弹跳 | 纯淡入 |
| 弹窗边框/阴影 | 紫色描边 + 大范围投影 | 普通边框 + 轻投影 |
| 模型标签 | 紫色底 + 紫色文字 | 灰色小字 + 细边框 |
| 回答风格 | 弹窗内下拉框 | **移除**，改为设置项 `academicReader.aiAnswerStyle` |
| 快捷提问 | `💡 讲透核心动机` 等 4 个 emoji 胶囊 | `核心动机 / 与前人区别 / 术语与公式 / 推导过程` 纯文字小方块 |
| 对话气泡 | 用户蓝色气泡 + AI 卡片卡片 | 朴素文本 + 角色标签（你 / AI），用细线分隔 |
| 每条回答的操作 | `📋 复制` `✍️ 存为批注` `🔄 重答` 带边框按钮 | `复制 / 存为批注 / 重答` 无边框文字按钮 |
| 加载状态 | 彩色底 + 转圈 spinner | 一行灰字 |
| 发送按钮 | 紫色渐变、48px 高 | 主题色实心、38px |
| 停止按钮 | 红色实心 | 灰字次要按钮 |
| 批注气泡的 AI 按钮 | `🤖 疑点向 AI 提问解答` 紫色渐变 | `AI 提问` 普通按钮 |

功能一个没少：流式输出、停止、多轮追问、新话题、重答、存为批注、全文检索上下文都还在，
只是不再靠颜色和 emoji 来表达。回答风格仍在设置里可切（`standard` / `concise` / `reviewer`）。

> 上述布局与样式均已加 CSS 回归测试（`scratch/llm-test/viewer-unit.js`）：
> 禁止 `nowrap` 回来、`.sent-row-actions` 必须是脱离文档流的悬停浮层、
> 三处按钮不得再出现渐变。

---

## 📌 v0.2.3 修复说明（逐句翻译与 AI 问答重做）
### 一、为什么"句子提取出来之后翻译不准"——四个真实根因

| # | 根因 | 后果 |
|---|------|------|
| 1 | **模型名被静默改写**：任何含 `flash` 的模型名都被改写成 `gemini-1.5-flash` | 选中的模型被降级到已下线模型，白跑 404 后退化到劣质模型 |
| 2 | **逐句对齐靠"中文标点数量比例猜"**（旧 `alignSentencesFallback` 与 `viewer.js` 里两份重复实现） | 中文分句数 ≠ 英文句数时，同一句中文重复贴在多行，或整段译文铺满每一行 |
| 3 | **段落缓存键 = 正文前 28 个字符**（旧 `getParaSig`） | 同页两段开头相同即互相串译文（实测：某正文段落拿到了论文标题的译文） |
| 4 | **切句器把"变量名+句号"当作者缩写**（旧 `\b[A-Z]\.$` 规则） | `Let the set S. Then we define W.` 整段被吞成 1 句，逐句对齐彻底失效 |

另外：`整页翻译` 会一次性并发 30 个请求（`viewer.js`），触发 429 后整页退化为"猜对齐"。

### 二、现在改成什么样

- **一次请求拿到「整段译文 + 严格逐句译文」**：用 Gemini `responseSchema` 强约束
  `sentences` 数组长度必须等于英文句数；数量不符会带错误信息自动重试一次；仍不符才降级，
  而且**降级降得老实**——要么逐句带整段上下文单独翻（仍严格 1:1），要么只给整段译文并明确标注
  "逐句对齐未成功"，**绝不按标点猜切分伪造句对**。
- **缓存键改为全文 FNV-1a 指纹**，删除前缀模糊匹配，段落间不再串译文。
- **切句器修正下标自洽性**（`startIdx/endIdx` 与正文严格对应）并重写缩写表，去掉过激的"单字母缩写"规则。
- **扩展侧并发闸门**：整页请求压到可控并发（`academicReader.translateConcurrency`，默认 3），并对同段落请求去重。
- **去掉写死某篇论文的规则**（旧版含 `'Daily life requires'`、`'Many routine, inwardly'`），换成通用启发式。

### 三、AI 问答重做

- **删除了那段硬编码的假答案**：旧版在没有 Key 或网络失败时会返回一段编造的"学术解析"
  （内容是视频目标分割的 0.16s/frame、J&F score），还会被"存为批注笔记"写进笔记文件。
  现在所有失败都以结构化错误如实上报（未配置 Key / Key 无效 / 模型无配额 / 模型不存在 / 超时 / 被安全策略拦截）。
- **真流式**：SSE 边收边渲染，可随时点「停止」；不再有那个 15 秒就弹"备用解析"的假超时。
- **真多轮**：同一聚焦对象下保留对话历史，可连续追问，可「🧹 新话题」清空、「🔄 重答」重问。
- **全文上下文**：每解析完一页就把该页正文同步给扩展，提问时按词频检索最相关的若干段落一并送给模型；
  提示词明确要求"上下文没有的信息必须说明，严禁编造论文中不存在的内容"。
- **Markdown 渲染重写**：先转义再组装，支持标题/列表/引用/代码块/公式，`$...$` 不再被吃掉，且无 XSS。
- 模型名不再被改写；标题栏显示真实模型与"首字/总耗时"；弹窗按需拉取真实可用模型列表。

### 四、模型选择（实测结论）

同一把 API Key 上不同模型的可用性差别极大，因此改为**动态回退链**：

| 模型 | 实测结果 |
|------|----------|
| `gemini-3.6-flash` | ✅ 默认：首字约 1s，逐句对齐全部正确 |
| `gemini-3.5-flash-lite` | ✅ 极快（约 0.85s），质量略低；**不支持 `thinkingBudget: 0`**（插件会自动摘掉该参数重试） |
| `gemini-3.5-flash` | ⚠️ 可用但慢（首字 14~19s），偶发 503 |
| `gemini-3.8-flash` / `gemini-flash-latest` / `gemini-3.1-pro-preview` | ❌ 429 配额超限 |
| `gemini-2.5-flash` | ❌ 404 no longer available to new users |

建议用命令面板的 **「文献阅读：从可用模型列表中选择翻译 / AI 问答模型」** 挑选——
它会拉取该 Key 下真实可用的模型，而不是让你手打模型名。

翻译默认关闭思考（`translationThinkingBudget: 0`）：实测默认思考会多烧约 1000 token、
首字延迟从 ~1s 涨到 ~19s，而翻译并不需要推理。问答默认交给模型自己决定。

### 五、本版另外修掉的三处（来自独立代码审计）

1. **单栏论文被整页并成一个段落**：`isCrossColumn = sw > 320` 会把单栏论文的每一行都判成
   "通栏大图表注"，其 section 全为 `caption`；而 caption 分支只在遇到 "Fig. N" 时才分段 →
   整页正文并成一段（一个卡片装一页、请求超长、逐句对齐全废）。
   现在先判定页面是否单栏（正文行是否普遍"横跨页面中线"），是则关闭分栏与通栏判定。
   判据用相对阈值（`pagePdfW * 0.55`），已加回归测试确保**标准双栏论文不会被误判**。
2. **8 秒看门狗废掉并发上限**：旧版每 8 秒无条件 `activeWorkers = 0` 再放 2 路请求，
   池中旧请求仍在飞 → 同一批段落被反复重复请求（重复计费），UI 呈现"假进度"。
   现在只在"45 秒确实毫无进展"时释放 1 个槽位，绝不清零。
3. **翻页时的串段写入**：翻译在途时翻页/缩放，`currentParagraphs` 已换成新页，
   同一个 `paraIndex` 可能落到另一个段落上。现在用内容指纹核对，核对不上就不动 DOM。

### 六、已知限制（未处理，如实列出）

- **非 PNAS 版式的首末页排版**：页眉过滤里仍保留 `NEUROSCIENCE` / `www.pnas.org` 等特定期刊
  字符串，首屏标题/元信息/脚注判定用的是 PNAS 双栏 Letter 的硬坐标（`sy > 660` 等）。
  换版式可能让标题归入元信息或脚注并入正文。（写死**某篇论文正文句子**的两条已删除。）
- **三栏及以上版式**不建模（只有 col1 / col2 / 通栏）。
- **PDF 反查高亮的边界**：`targetIdx <= s.endIdx` 用的是闭区间而 `endIdx` 是开区间，
  点在行首字符上可能高亮到上一句。影响轻微，未改。
- **缩写表偏保守**：`no. / min. / sec. / fig. / tab.` 等仍不切分。这是有意为之——
  现在 1:1 对齐由 schema 保证，"误合并"只是一行显示两句（内容仍正确），
  而"误切分"会产生 `See Fig.` + `2 for details.` 这种肉眼可见的垃圾行。
- `.vscode` 目录下仍留着旧的 0.1.0（注册表引用它，删除会把那块装坏）；实际使用不受影响。
