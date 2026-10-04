# Zotero 作为第二数据源：调研结论、已实现部分与待做（实测）

> 状态（2026-10-04 起调研 → 1.6.2 落地只读联动）：
> **只读联动已实现**——认领论文、取父条目元数据、取逐页全文、读批注、**把批注按坐标画进阅读器**；
> **尚未实现**——任何形式的回写（需 Zotero 10+ 的写接口；直改库本仓库不做）。
>
> **证据等级**（每条结论都标注，别再出现"只验了两个提取器就写'任何提取器'"这种事）：
>
> | 标记 | 含义 |
> |---|---|
> | **实测** | 本机真机跑过，有可复现的数据（命令见文末） |
> | **源码** | 读了 Zotero / pdf.js / Zotero reader 的源码，结论由代码本身确定 |
> | **推断** | 由上两者推出、还没直接验证 —— 当"待验证"看，别当结论引用 |

## 〇、结论速览

| 问题 | 结论 | 证据 |
|---|---|---|
| 能用 Zotero 拿论文身份（标题/作者/年份/会议/DOI）吗？ | 能，比从 PDF 首页猜准得多 | 实测 |
| 能替代本机几何层吗？ | **不能**：Zotero 存的是扁平纯文本，没有基线/字号，而公式语义恰恰全在几何里 | 实测 |
| 能救坏字形（`$` / `%`）吗？ | **不能**：同一页同一处，两边的坏字形一模一样 —— 它们来自 PDF 自身的 ToUnicode | 实测（逐字节） |
| 升级 pdf.js 能提高识别率吗？ | **不能**：3.11.174 / 4.10.38 / 5.4.54 抽出的文本逐页逐字节相同；而且 4.x 起 `renderTextLayer` 被移除，升级会直接打坏文本层 | 实测 + 源码 |
| Zotero 全文真正的用处是什么？ | ① 规范元数据 ② 按页文本（给"用户还没翻到的页"当 AI 问答上下文） ③ 带精确坐标的批注 | 已实现 |
| 能回写 Zotero 吗？ | 不能：9.0.6 的本地 API 只有 GET，写接口是 Zotero 10+；直改库官方明确警告会损坏库 —— **本仓库不做** | 源码 + 官方 |

## 一、本机 Zotero 库现状（2026-10-04 实测 + 1.6.x 复测）

| 项 | 值 |
|---|---|
| 版本 / 程序目录 | **Zotero 9.0.6**，程序在 `D:\Zotero`（**实测**：目录里有 `app/`、`uninstall/`、`install.log`） |
| 数据目录 | `C:\Users\paroxetine\Zotero`（**实测**） |
| 数据库 | `zotero.sqlite`（**实测** 1,421,312 字节 ≈ 1.36 MB，61 张表；同目录还有 `zotero.sqlite-journal`，说明 Zotero 正在运行） |
| 条目 | 5 条顶层 + **3 个 PDF 附件**，1 个分类（**实测**） |
| 全文文本 | 3 篇都有：`storage\<KEY>\.zotero-ft-cache`（UTF-8，无 U+FFFD、无双向控制字符）（**实测**） |
| 全文接口 | `/api/users/0/items/<附件KEY>/fulltext` 的 `content` 与 `.zotero-ft-cache` **逐字节一致**，另外附送 `indexedPages` / `totalPages`（**实测**） |
| 批注 | `itemAnnotations` 表**当前 0 行**（**实测**，1.6.x 复测）。早期调研记录里写过"仅 1 条（AOT，`#ffd400`，第 1 页，text='gy, Zhejian'）"，**本轮没有复现** —— 这条按"待复核"处理，别当现状；以现场查询为准（命令见文末） |
| 本地 API | 端点 `http://127.0.0.1:23119/api/`。**默认关闭**；未开时 **403 + body `Local API is not enabled`**；打开后**本地读不需要任何 API key**；9.0.6 **只有 GET**，写接口是 Zotero 10+（**实测**：403 body 与 `/api/` 探测；**源码**：`defaults/preferences/zotero.js` 的 `httpServer.localAPI.enabled` 默认 false、`server_localAPI.js` 的 `_initInternal` 里没有 key 校验） |

三篇附件（**实测**）：

| KEY | 论文 |
|---|---|
| `GUT7U72G` | Yang et al. - Associating Objects with Transformers (AOT) |
| `DE6KQMVB` | Li et al. - Delving into the Cyclic Mechanism (cycle) |
| `NQI6N4AP` | Oh et al. 2019 - STM |

## 二、纠正两条已经写进仓库的错误结论

### 2.1 错：`/api/` 返回 403 是"需要 API key"。真因：pref 没开

| 情形 | HTTP | body | 正确结论 |
|---|---|---|---|
| 本地 API 关着（9.0.6 默认） | **403** | `Local API is not enabled` | **开关没打开**，不是缺鉴权 |
| 本地 API 开着 | 200 | JSON（`/api/` 本身返回一句占位文本） | 本地读**不需要任何 key** |

- **源码**：开关是 pref `extensions.zotero.httpServer.localAPI.enabled`（Zotero 源码 `defaults/preferences/zotero.js`，默认 `false`）；打开之后 `server_localAPI.js` 的 `_initInternal` 里**没有 key 校验分支**，所以本地读无需鉴权。
- **实测**：关着时 `GET http://127.0.0.1:23119/api/` → 403 + `Local API is not enabled`；打开并重启 Zotero 后同一请求 200。
- **怎么开**：Zotero 设置 → 高级 → 勾选「允许本机其它程序与 Zotero 通信」，然后**重启 Zotero**。
- **读 pref 的坑**（**源码** + 单测钉住）：用户从没改过这个开关时，`prefs.js` 里**没有这一行** —— "没写"必须回退到默认值 `false`，绝不能当成"开了"。`readBoolPref()` 因此返回三态：`true` / `false` / `null`（没写）。
- 本机 profile 路径的形态（**实测**）：`%APPDATA%\Zotero\Zotero\Profiles\<随机前缀>.default\prefs.js` —— 随机前缀无法硬编码，只能枚举 `<root>\*\prefs.js`。

### 2.2 错：Zotero 全文能还原坏字形。逐字节核对推翻

**原来的写法**（本文件上一版第 44 行那张表）："STM p4 `k^Q ∈ R^{H×W×C/8}`：本机几何层只能整条丢弃，Zotero 全文是 `kQ ∈ RH×W ×C/8` → **Zotero 对**"，并据此在"建议的分工"里写了第 2 条"用 Zotero 对应位置文本替换坏字符，恢复本机只能丢弃的公式"。**这两处都是错的。**

**当初为什么会判错**（写清楚，免得下次再犯）：

1. 只比了**肉眼观感**，没有逐字节核对同一处字符；
2. Zotero 的输出是**空白规范化后的扁平文本**——同一处公式在它那里是 `RH×W ×C/8` 这种被空格分开的形状，看起来比本机的 `H×$×%` 整齐，于是被当成"字母是对的"；
3. 一旦逐字节回到**同一页**（第 4 页，Figure 3 所在的那一片），Zotero 全文里出现的是 **`H×$×%/8`、`T×H×$×%/2`** —— 与本机几何层**完全一样**。也就是说，"看着对"只是比对位置不同造成的错觉，不是提取能力的差别。

**逐字节核对结果**（**实测**）：

| 对比项 | 本机几何层（pdf.js 3.11.174） | Zotero 全文 | 结论 |
|---|---|---|---|
| STM 第 3 页坏字形处数 | 4 | 4 | 相同 |
| STM 第 4 页坏字形处数 | 22 | 22 | 相同 |
| STM 全 10 页 | 逐页比对 | 逐页比对 | **逐页计数相同**，没有一页是 Zotero 更干净 |
| AOT 全篇 | 11 | 34（多出的集中在第 7–9 页） | Zotero 更多；两边计数口径/提取范围不同，超出部分的机制本轮**没追**（**推断**：与提取器的空白/连字处理有关，不影响下面的结论） |

**结论**：坏字形来自 **PDF 自身的 ToUnicode 编码**（CambriaMath 这类字体把多个字形映射到同一个错误码位），两个提取器都拿不到真字母。**Zotero 全文不能当"坏字形的解药"** —— 第三节"结论与分工"里那条"用 Zotero 对应位置文本替换坏字符"因此标为"**实测不可行**"（原先的"建议的分工"第 2 条已删）。

**连带纠正**：交接文档里原话"STM 那些公式的 ToUnicode 坏了，**任何提取器**都拿不到真字母" —— 这句话其实**是对的**；是后来 CHANGELOG 1.6.1 里"Zotero 就拿到了"那条说明错了，本轮一并改口。当初为了翻这句话，只验了 pdf.js 与 PyMuPDF 就下"任何"的结论，方向对但证据不足；现在有了逐字节数据。

### 2.3 升级 pdf.js 是伪命题，而且会打坏文本层

| 项 | 实测 / 源码 | 后果 |
|---|---|---|
| 文本抽取 | pdf.js **3.11.174 / 4.10.38 / 5.4.54** 三个版本抽出的文本**逐页逐字节相同**（页级 diff 全等；唯一差异是版本号字符串本身，1 字节） | "升级 pdf.js 能提高识别率"**不成立** |
| 文本层 API | **源码**：`renderTextLayer` 是 3.x 的 API，4.x 起已移除；而 `media/viewer.js` 依赖 `window.pdfjsLib.renderTextLayer`（渲染透明文本层，划线高亮、点中文跳英文、文本层定位全靠它） | 升到 4.x/5.x **直接打坏文本层**，不是"更好"，是"更坏" |

要提升公式识别率，靠的是**视觉模型**（本仓库 1.1.0 起已有），不是换提取器，也不是换 pdf.js 版本。

## 三、Zotero 全文 vs 本机几何抽取：谁适合干什么

同一份 PDF、同一处公式，两边分别抽成什么（**全部实测**；比原来那版多了一列"证据"）：

| 位置 | 本机几何层 | Zotero 全文 | 谁对 | 证据 |
|---|---|---|---|---|
| STM p4 `k^Q ∈ R^{H×W×C/8}` | **`H×$×%`**（W→`$`、C→`%`） | 同一页同样是 **`H×$×%/8`、`T×H×$×%/2`**；只有空白被规范化后那一段看起来像 `RH×W ×C/8` | **都不对**（本轮更正：原先写"Zotero 对"是错判） | 实测，逐字节 |
| AOT p5 `D ∈ R^{M×C}` | `D\in R^{M\times C}` | `D ∈ RM×C`（丢基线，`M` 分不出上标/正文） | **本机对** | 实测 |
| AOT p6 `X_l^t ∈ R^{HW×C}` | `X_{l}^{t}` + `\in R^{HW\times C}` | `l ∈ RHW ×C`（**`X` 与真下标 `l` 丢失**） | **本机对** | 实测 |
| AOT p6 最长的 AttLT 公式 | 完整一条 | 截断成 `AttLT (Xt` | **本机对** | 实测 |
| AOT 普通正文 | `t HW × C`（字形间塞空格） | `RT HW ×C`（更干净） | Zotero 略优（但只对**纯正文**成立） | 实测 |

### 结论与分工（1.6.x 的立场）

| 用途 | 谁来做 | 说明 |
|---|---|---|
| 论文身份 / 元数据（标题、作者、年份、会议、DOI） | **Zotero** | 实测比从 PDF 首页猜准得多；已实现 |
| "用户还没翻到的页"的文本上下文 | **Zotero** | 逐页全文注册进翻译器的页面索引，AI 问答可引用；已实现（页数校验通过才注册） |
| 带精确坐标的批注 | **Zotero** | 已实现：读取 + 按坐标画进阅读器（1.6.2，见 §5.1） |
| 公式的上下标 / 帽子 / 基线 / 几何分层 | **本机几何层** | Zotero 给不了（扁平纯文本），**永远不要把几何层换成 Zotero 全文** |
| 坏字形（`$` / `%`）恢复 | **视觉模型** | 用 Zotero 对应位置文本替换：**实测不可行**（2.2），已从"建议分工"里删掉。拿扁平文本去替换公式区域，只会把"看得见的坏"变成"看不出错的错"，更危险 |

> 仍然成立的一条判断：用户截图里的公式长相问题，根因是**译文层**（模型转写 LaTeX 写错，见 1.6.0 的公式专项），与数据源无关。Zotero 联动解决的是元数据、上下文与批注，**不解决公式渲染**。

## 四、已实现部分（1.6.x，只读）

| 文件 | 内容 |
|---|---|
| `src/zoteroClient.ts`（新增，不 `import vscode`） | 只读客户端，纯 HTTP + 数据整形，因此能进 Node 单测直接跑 |
| `src/pdfEditorProvider.ts` | 宿主接线 `linkZoteroPaper()`：探测、认领、注册全文、把结果发给 webview |
| `media/viewer.js` | `zoteroData` 分支：弹一行提示 + 标题 tooltip；导出精读稿时把元数据写进 frontmatter 与引言块 |
| `package.json` | 配置项 `academicReader.zoteroIntegration`（默认 `true`；关掉则**不发任何本地请求**） |
| `scratch/zotero/zotero_client_test.js`（新增） | **37 条**单测，含 8 条桩 HTTP 的端到端、1 条真机联调（`ZOTERO_REAL_TEST=0` 可跳过） |
| `scratch/zotero/viewer_zotero_test.js`（新增） | webview 侧回归（真 jsdom + 真派发 `zoteroData` 消息）：消息异步到达（可能早于 `initPdfData`）不能踩 TDZ，认领失败时必须给"怎么开"的指引。两者一起跑用 `npm run test:zotero` |

客户端做了四件事：

1. **探测**（`detect()`）——三种失败必须分清，因为用户的下一步动作完全不同：

   | 情形 | 判据 | 给用户的话 |
   |---|---|---|
   | Zotero 没开 | 请求失败 / `status === 0` | "没检测到 Zotero（本地接口无响应）。打开 Zotero 即可自动认领当前论文。" |
   | 接口没开 | `403` 且 body 含 `not enabled` | "Zotero 在运行，但本地接口没打开：设置 → 高级 → 勾选「允许本机其它程序与 Zotero 通信」，然后重启 Zotero。" |
   | 其它错误 | 其余状态码 | 如实报状态码与 body 前 120 字，**不猜** |

   探测结果带 `X-Zotero-Version`（实测 9.0.6）。读 `prefs.js` 只为判断开关状态，读不到就记 `unknown` —— 真正的判据是 HTTP 探测，不是能不能读到文件。

2. **三级匹配认领**（`matchZoteroItem()`）——

   | 级别 | 判据 | 为什么需要它 | 何时放弃 |
   |---|---|---|---|
   | ① 完整路径 | `links.enclosure.href` 解出的路径与本地 PDF 相同 | Zotero 库里指向的就是同一个文件（例如从 Zotero 同步目录打开） | —— |
   | ② 文件名 | 文件名（已解码、小写、压空白）相同 | 跨机器 / 换目录后仍然成立 | 同名多条 → 用文件大小消歧；仍不唯一 → **放弃** |
   | ③ 文件大小 | 附件的 `enclosure.length` 与本地字节数相同，且**库里唯一** | **真实高频场景**：从浏览器下载的 `2103.10088.pdf` 拖进 Zotero 被改名成 `Yang 等 - Associating….pdf`，文件名毫无关系、字节数一模一样 | 不唯一 → **放弃** |

   **全部不中 = `link: null`，什么都不做**。理由很硬：认错论文会把别人的元数据、批注、全文搬到这篇上，比不认更糟。每一步都记下 `matchedBy`（`path` / `basename` / `size`），界面与日志里能说清"凭什么认成了这一条"。

3. **取元数据 / 全文 / 批注**——`getItem()` 取父条目（走 `links.up.href`，回退 `data.parentItem`）；`getFullText()` 取逐页全文；`getAnnotations()` 走 `/items/<附件KEY>/children` 再过滤 `itemType === 'annotation'`（**实测**：库里没有批注时返回**空数组**而不是 404；子条目里的 `note` 必须被过滤掉）。任何一步失败都只让那一步为空，**不抛异常** —— 阅读器不能因为 Zotero 出问题就打不开论文。

4. **页数校验**——见下一节（认领成功 ≠ 可以用全文）。

### 端到端数据流（认领一次做了什么）

1. 打开 PDF → webview 先渲染首屏；`webviewReady` 之后宿主**不 await** 地发起第一次认领（探测超时 4 秒，绝不能白屏 4 秒）；
2. `detect()` 不通 → 只发一行提示（"Zotero 没开"/"接口没开"），阅读不受影响；
3. 认领成功 → 取父条目元数据、逐页全文、批注；
4. webview 用 pdf.js 解析完把**真实页数**回报（`pdfOpened`）→ 宿主**再发起一次带 `expectedPages` 的认领**，页数结论以这一次为准；
5. 页数一致 → `translator.registerPageText()` 逐页注册全文（AI 问答能引用还没翻到的页）；页数不一致 → `pageCountMismatch = true`，**只提示、不注册**；
6. webview 弹一行"已认领 Zotero 论文：…"，标题 tooltip 挂上规范著录；导出精读稿时 frontmatter 写入 `zotero_title` / `zotero_authors` / `zotero_year` / `zotero_venue` / `zotero_doi` / `zotero_item`，引言块写一行 `> Zotero：…`。

> 换论文时必须清掉上一篇的认领结果（`this.zoteroLink = null`），否则"这篇没认领成功"时会残留上一篇的全文上下文 —— AI 会拿 A 论文的原文回答 B 论文的问题。

### 页数校验为什么必须有

- Zotero 全文**按页存**：接口只给一整块 `content`，页分隔符是换页符 `\f`（**实测**：10 页 PDF = 10 段）；
- 宿主**不自己解析 PDF**（多一份解析器就多一处不一致），真实页数由 webview 用 pdf.js 解析后回报；
- 判据：切出的段数与真实页数（优先用 webview 报的 `expectedPages`，否则用接口的 `totalPages`）不一致 → `pageCountMismatch = true`；
- 处理：**只发提示、不注册全文**。静默错位比没有上下文更坏 —— AI 会拿第 5 页的原文回答第 7 页的问题，用户完全看不出来。

### 实测踩过的三个坑

| # | 坑 | 症状 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | `parseFileUrl()` 返回**小写** storage key | 拿 `nqi6n4ap` 去拼 storage 目录/对附件 KEY 时对不上 | 归一化函数为了比对把整串转了小写，而 storage key 是**目录名**（大小写敏感） | 归一化后的串只用来比对；key 从**原始 href** 再取一次。由单测抓出 |
| 2 | 附件的**占位标题**被当成论文标题 | 界面上标题显示成 `PDF` / `T` | Zotero 导入 PDF 时附件 title 默认就是 `PDF` / `Full Text PDF` / `Snapshot`，用户手改过可能是单个字符 | `isPlaceholderTitle()` + 标题回退链：父条目 `title` → 附件 `title`（非占位）→ `enclosure` 文件名（去 `.pdf`） |
| 3 | 测试桩用 `url.includes()` 做路由 | 认领在"取父条目"那一步**静默失败**（元数据全空），断言却不报错 | 子串匹配不锚定：列表端点 `/items?itemType=attachment` 与单条目端点 `/items/<key>` 共享 `/items` 前缀，单条目请求被列表路由接走，返回的是数组 | 桩改用**锚定**的正则（`/api/$`、`/items\?itemType=attachment`、`/items/PAPER001$`）—— "测试桩必须贴近真实语义"这条老纪律又一次应验 |

> 顺带一条实测确认（写测试桩时别想当然）：`?` 在**子串匹配**里只是普通字符，在**正则**里是量词。`/items?itemType=attachment` 这条模式两种写法都匹配不到 `/items/BBBB2222` —— 真正把单条目请求吞掉的是更短的 `/items` 前缀。端点路由要么锚定全路径，要么用 `$` 收尾。

## 五、批注：坐标口径已确认，导入已实现（1.6.2）

**口径（源码 + 实测）**：`annotationPosition` 是 **JSON 字符串**，关键字段是 `pageIndex` 与 `rects: [[x1,y1,x2,y2], ...]`（还有 `paths` / `fontSize` / `rotation` 等，reader 源码里 `positionsEqual` 只读 `pageIndex` / `rects` / `paths`）。`rects` 是 **PDF 用户空间点**：原点在**左下**、**y 轴向上**。要画到画布上（左上原点、y 向下）必须翻一次：

```
top = pageHeightPdf - y2
```

`src/zoteroClient.ts` 里的 `rectToTopDown(rect, pageHeightPdf)` 就是这一步（同时把 x1>x2 / y1>y2 归一化、过滤非数字）；`toViewerAnnotations()` 再把它整批转成阅读器的批注形状。**两者都已实现、已接进渲染、有 19 条单测**（含坐标翻转、零面积矩形丢弃、无页高整条丢弃、坏 JSON、颜色映射）。

### 5.0 一个诚实的缺口：**还没有用真实批注样本端到端验过**

本机库 `itemAnnotations` 表**实测 0 行** —— 用户在 Zotero 里还没划过。所以现在的验证是：
桩数据（照抄真机 API 的字段名与数值口径）+ 真机**结构自检**（库里一旦有批注，`npm run test:zotero` 会自动逐字段核对
`pageIndex` / `rects` / `color` 三条假设是否成立，见 §六 第 6 项）。

**没做到的**：拿一条真实批注跑完"读取 → 换算 → 画到正确像素位置"的全链路，再用截图核对高亮落在原文正确位置。
这条在你于 Zotero 里划第一条高亮之后就能补上。在那之前，**不要把"批注导入"当成已验证的成品功能**。

**导入时要处理的清单**（做之前先看这份）：

| 事项 | 为什么 |
|---|---|
| `annotationPageLabel` → `pageIndex` 的映射 | 页标签是用户/PDF 自定义的（罗马数字、封面不计页），两者不一定相等 |
| 多 `rect` / 多行高亮 | 一条批注可能跨行、跨栏，`rects` 是数组不是单个矩形 |
| `rotation` | 页面有旋转时坐标口径还要再转一次 |
| 缩放 | 画布是按当前 zoom 渲染的，坐标要乘缩放；换缩放要重画 |
| 与仓库现有批注存储的合并 | 本仓库有自己的批注数据（`.json` 存档），导入的 Zotero 批注是"只读外部批注"还是"可编辑的本地批注"，必须先定 —— **已定：当作本机批注写进同一数组、可编辑，但按 id 判重、本机那份永远是"更新的"**，且**绝不回写 Zotero** |
| `annotationType` 的分支 | `highlight` / `underline` / `note` / `image` / `ink` 的画法完全不同 —— **第一版做法：`highlight`/`underline` 归"高亮"按 rects 画；`note`/`text` 归"笔记"；`image`/`ink` 也保留（用占位文字入列表，因为它们的 rects 同样有效）** |

## 六、下一步待做

| # | 事项 | 依赖 / 前提 | 状态 |
|---|---|---|---|
| 1 | 批注导入：按坐标画进阅读器（划线高亮） | 坐标换算 + 页高表已接好 | **1.6.2 已做**（见 §5.1） |
| 2 | 回写 Zotero（把本仓库的笔记/标签推回条目） | 需要 **Zotero 10+ 的写接口**，或**直接改库** —— 官方明确警告会损坏库，**本仓库不做** | **不做**（立场：只读） |
| 3 | ~~批注导入可选写进导出的精读稿 / 批注 PDF~~ | 导入后即成为本机批注，**导出链路自动带上**（精读稿的"我的批注"与批注 PDF 都读同一个数组） | 免做（副作用即达成） |
| 4 | 页数一致性更强的判据 | 现在只比页数；可再比"本地第 1 页文本 vs Zotero 第 1 页文本"的指纹，挡"页数相同但内容不是同一版"（换过文件、重排过） | 未做（**推断**：现有页数判据已能挡住最常见的"只索引了前 N 页"） |
| 5 | 用 Zotero 全文做术语/章节级上下文 | 逐页全文已注册；可再抽"术语表"辅助翻译一致性 | 未做 |
| 6 | 真机批注样本 | 本机 `itemAnnotations` 仍为 0 行 → 批注**结构自检**会自动跳过；等你在 Zotero 里划一条，`npm run test:zotero` 就会拿它逐字段核对 `pageIndex` / `rects` / `color` 三条假设 | 等样本 |

### 5.1 批注导入的实现口径（1.6.2）

| 环节 | 做法 | 理由 |
|---|---|---|
| 取批注 | `/api/users/0/items/<附件key>/children` 里 `data.itemType === 'annotation'` 的子条目 | 本地 API 没有专门的批注端点（源码：children 走共享的 Items 类后过滤掉父条目） |
| 页码 | `annotationPosition.pageIndex`（**0 基**）→ 阅读器的 1 基；缺失时用 `annotationPageLabel` 查表 | 与 Zotero reader 语义一致 |
| 坐标 | `rects` 是 **PDF 用户空间点**（原点左下、y 向上）；`top = pageHeightPdf - y2` | reader 源码里也是 `viewport.convertToViewportPoint` 之后才画 |
| 页高来源 | webview 侧 `page.getViewport({scale:1}).height`，逐页取（上限 400 页），随 `pdfOpened` 上报 | 只有 pdf.js 知道真实页高；**拿不到页高就整条丢弃** —— 翻错 y 会把高亮画到无关段落 |
| 颜色 | Zotero 官方九色盘精确匹配（`#ffd400`→yellow 等），自定义色走 HSV 色相 | 早期按"比较 RGB 大小"的启发式会把默认黄判成橙（实测 R−G=0、G−B=212） |
| 判重 | id = `zotero-<附件key>-<批注key>`；已存在则整条跳过 | `zoteroData` 会到两次；且用户可能改过颜色/补过笔记 |
| 畸形数据 | 坏 JSON / 无 rects / 页高缺失 / 零面积矩形 → 丢弃该条 | 阅读器有个"缺 rects 就按段落猜位置"的自动修复分支，那是给用户手划批注准备的，不能被外部数据触发 |
| 落盘 | 导入后立刻 `saveAnnotations`，并重画当前页 | 否则下次打开就没了 |

## 七、读取坑（只对**离线探针**有意义；产品实现走 `/api/`，不直读库）

- **Zotero 运行中时 `mode=ro` 也会 `database is locked`**（**实测**；同目录确实有 `zotero.sqlite-journal`）。必须用：

  ```python
  sqlite3.connect(f'file:{db}?immutable=1', uri=True)
  ```

  `immutable=1` 不走锁、不写任何东西，对正在运行的 Zotero 安全（本仓库一律只读，绝不改动用户库）。
- `itemAttachments.path` **实测读出来是 `None`**（值在 `itemData` 里，字段名 `path`），**不能靠它拿文件名**；要拿文件名得走 `itemData` / `itemDataValues`，或者直接用 storage 目录里的 PDF。
- 上面两条**只在直读数据库时成立**。产品实现（`src/zoteroClient.ts`）走的是 `/api/`，**不读 `zotero.sqlite`、也不读 `.zotero-ft-cache`**：接口返回的 `content` 与 `.zotero-ft-cache` 逐字节一致（**实测**），还多给了 `indexedPages` / `totalPages` —— 同一份数据，不碰文件锁、不碰 schema。
- 现场复核用的两条只读命令（PowerShell）：

  ```powershell
  # 本地接口是否打开（403 + Local API is not enabled = pref 没开）
  (Invoke-WebRequest -Uri 'http://127.0.0.1:23119/api/' -UseBasicParsing).StatusCode
  # prefs.js 里的开关行（没有这一行 = 从没改过 = 默认 false）
  Select-String -Path "$env:APPDATA\Zotero\Zotero\Profiles\*\prefs.js" -Pattern 'localAPI'
  ```

## 八、可复用的探针（全部只读）

| 脚本 | 用途 | 状态 |
|---|---|---|
| `scratch/zotero_probe.py` | 库规模、表结构、附件、storage 目录总览 | 直读库（`immutable=1`） |
| `scratch/zotero_fulltext_probe.py` | `fulltextItems` / `itemAnnotations` / `itemAttachments` 结构与内容 | 直读库（`immutable=1`） |
| `scratch/zotero_text_compare.py` | `.zotero-ft-cache` 解码 + 公式痕迹统计 | 直读文件 |
| `scratch/zotero/zotero_client_test.js` | 37 条单测：prefs 解析、file:// URL 解析、三级匹配、页数校验、批注坐标、探测三态、8 条桩 HTTP 端到端、1 条真机联调 | 走 `/api/`，不读库 |
| `scratch/zotero/viewer_zotero_test.js` | webview 侧回归（真 jsdom + 真派发 `zoteroData` 消息）：异步消息早于 `initPdfData` 也不能踩 TDZ；认领失败要给"怎么开"的指引 | 不读库 |

三个 Python 脚本都不含 `INSERT/UPDATE/DELETE/CREATE`（已用 grep 确认）。单测的构建与运行：

```powershell
npm run test:zotero     # 一次性：编译 + 客户端 + webview 侧两组单测
# 需要二分定位时，拆开来跑：
npx tsc src/zoteroClient.ts --outDir dist-test --module commonjs --target es2020 --skipLibCheck
node scratch/zotero/zotero_client_test.js
$LASTEXITCODE          # 必须是 0；0xC0000409 = 进程崩溃，不是断言失败（见 design-notes.md）
```
