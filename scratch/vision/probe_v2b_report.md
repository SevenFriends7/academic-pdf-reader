# 第二轮探针报告（merge_next / group，用 cycle.pdf 真实归档页）

真实调用 deepseek-flash，两次：**第 2 页（任务 A：merge_next）** 与 **第 6 页（任务 B：group）**。
素材来自 `$env:APPDATA\Code\User\globalStorage\paper-reader.academic-pdf-reader\paper_1f6c2345c825e6b5dac7170135b540b1.json`
（pdfName=cycle.pdf，归档页 1~6，mtime 2026-10-03T08:56:06Z，sha256 前缀 `34b40aee9d15c847`；跑完后复核过，探针发出的分段与当前存档一致）。
结果文件：`probe_v2b_result.json`（p2）、`probe_v2b_p6_result.json`（p6）。未改 `src/` 与 `media/`。

## 结论先行

1. **`merge_next` 在真实素材上"考到了"，但结论偏负面**：模型**没有**在真正的续句上给出 `merge_next`；
   唯一那次 `merge_next` 是**假阳性**，而且**同一提示词同一页两次跑结果不同**（1 次 vs 0 次）——协议这一条不稳。
2. **`group` 在真实素材上第一次验证通过**：第 6 页两张表被正确分到 2 个 group，**表内文字与表题注确实同组**，
   共 5 员 + 3 员，0 个单元素组，题注类型全部为 `table_caption`。
3. **锚点 4/4 精确命中**（p2 两处 + p6 两处），0 模糊 0 失败；`inline` 4 条全部命中且**全部 ≤20 字**（收紧生效）。
4. **两次都没有空回答**（`max_tokens=16000` 起，未触发加倍重试）——再次印证 8000 的坑。
5. ⚠️ **父任务引用的那对"跨栏续句"样本并不在 cycle 归档里**（详见任务 A 第 0 条），所以下面用的是归档里**真实**的续句对。

## 任务 A：merge_next（cycle 第 2 页）

### A0. 先纠正素材前提（重要）

父 agent 给的样本对 `A related work fine-tunes deep network models on the initial object mask in the first frame to remember the appearance of the` /
`target object [2,34,26,14,26,11,18] during the test time.`：

- 在 **cycle 存档全文里关键词命中 0 次**；
- 该措辞实际出现在 **`scratch/llm-test/viewer-unit.js:1031`** 的单元测试夹具里（另有 `scratch/host_html_smoke.js:438`、`scratch/dstest/quality_probe.js:48`）；
- 另外 **STM 存档的 `annotations`** 里有一条用户批注用了极相似句式（`"Many of aforementioned methods fine-tune … to remember the appearance of the"`，`page=2`），但那是批注、不是分段；
- 图像已核对：**cycle 第 2 页是单栏页**（顶部 Figure 1 + 通栏正文），不存在"跨栏"。

所以在 cycle 上无法用这一对做验证。归档里**真实存在**的相邻续接是：

| 对 | 位置 | 上段结尾 | 下段开头 |
|---|---|---|---|
| [1] → [2] | 同页 | [1] 末尾 `…upcoming new frames.`（有句号） | [2] `Based on these observations, …`（**新段落**，大写开头） |
| [1] 续自 | **上一页**（p1 末尾） | p1 `…A natural solution toward the problem is to process videos in sequential order…` | [1] `background camel will serve as erroneous guidance…`（**小写开头，真跨页续句**） |
| [7] 续到 | **下一页**（p3 [0]） | [7] `…can be generally divided into online methods and offline`（**无句末标点**） | p3 [0] `methods. OVOS [2] is the first online approach…`（**小写开头**） |

### A1. 模型给了几次 merge_next？

**两次跑给出了不同答案**（同一提示词、同一页、`temperature=0`）：

| 跑次 | merge_next 次数 | 具体条目 |
|---|---|---|
| 第 1 次 | **1 次** | `i=1`，`why="小写起首，上页续句"` |
| 第 2 次（结果文件采用这次） | **0 次** | `i=1` 给了 `keep`，`why="上页续段，本页无前段可并"` |

这是**真实的 run-to-run 噪声**，值得记进风险清单：`merge_next` 这一条在 temperature=0 下都不稳。

### A2. 有没有命中真正的续句？

**没有。**
真正的续句对是 `[1]`（续自 p1）和 `[7]`（续到 p3 [0]），二者**都跨页**，页内没有可并对象。
模型对 `[1]` 的两次判断其实都**理解了内容**：
- 第 1 次说"上页续句"却错给了 `merge_next`（语义是"与下一段合并"）；
- 第 2 次说"**本页无前段可并**"并给 `keep` —— **这个判断才是对的**，而且说明它分得清"跨页续接"和"merge_next"。

`[7]` 两次都给 `keep`（顺序视为页内独立段），并且在第 2 次里被**正确拆开**：

```json
{"i":7,"type":"heading","order":8,"group":null,"action":"split","why":"小节标题与正文粘连","latex":null,
 "parts":[{"type":"heading","at":"2.1 Semi-supervised video object segmentation"},
          {"type":"body","at":"Semi-supervised video object"}],
 "inline":[]}
```

`[7]` 与 p3 的续接页内无法处理，所以这里不能怪模型——这属于**协议能力边界**：`merge_next` 只能表达页内合并，跨页续句需要"上一页/下一页"的联合处理。

### A3. 假阳性

被判 `merge_next` 的只有第 1 次的 `i=1` 这一条：

```json
{"i":1,"type":"body","order":2,"group":null,"action":"keep","why":"上页续段，本页无前段可并","latex":null,"parts":[],"inline":[]}   ← 第 2 次（正确）
{"i":1,"type":"body","order":2,"group":null,"action":"merge_next","why":"小写起首，上页续句", ...}                                  ← 第 1 次（假阳性）
```

- 上段（回包顺序里的上一段）：`[0]` 是图注 `Figure 1: An example of error propagation risk during the inference time.`
- 下段（回包顺序里的下一段）：`[2]` `Based on these observations, in this paper, we propose to train and apply a segmentation n…` —— **以大写开头、是完整新段落**
- ⇒ `i=1` 与 `[2]` 之间根本没有续接关系，`merge_next` 的方向错了 → **假阳性**。

**另一个边界情形（不是模型的错）**：规则字面给出的唯一"真值候选"是
`[6]"2 Related works"(heading)` → `[7]"2.1 Semi-supervised video object segmentation…"`：
上段是标题、无句末标点，下段以数字开头，字面命中规则；但标题本来就不该 `merge_next`。
模型给 `keep`，**从语义看是对的**——这说明父 agent 的判据（"上段无句末标点 + 下段小写/数字开头"）**在标题/编号小节前会产生字面假候选**，
落地时建议加一条排除：`type in (heading, title, abstract, caption, table_caption, figure_caption) → 不做 merge_next`。

模型**没有**把任何"大写开头的完整新段落"误判成续句（两次都没有），这点是好的。

### A4. 回包数组顺序 = 阅读顺序吗？

- `order` 与数组下标严格对应（`orderIsSequence = true`，两次都是 1..8 连续）。
- 本页单栏，数组顺序 = 从上到下，与图像一致。
- **但跨栏场景没考到**：cycle 归档 6 页里 **第 2 页是单栏**，p1/p3/p4/p5/p6 也未发现双栏排版（p4 是大图 + 单栏正文）。
  所以"数组顺序在跨栏场景下是否成立"**本轮依然没有真实证据**——这点和 group 之前的状态一样，需要在真正双栏的论文上补测。

## 任务 B：group 成组（cycle 第 6 页）

### B0. 选页依据

把 1~6 页按"短标签型分段"扫了一遍（`survey_cycle_pages.js`，明细 `cycle_pages_survey.json`）：

| 页 | 段数 | 类型构成 | 短标签型 |
|---|---|---|---|
| 1 | 8 | title/metadata/body×3/abstract/heading/footnote | 4（但都是标题、作者、页脚，非图块） |
| 2 | 8 | caption/body×6/heading | 1（heading） |
| 3 | 9 | body×6/heading×2/keywords | 1（heading） |
| 4 | 12 | caption/body×6/keywords/heading×2/formula×2 | 1（formula 残片 `\| Ω \| ̂`） |
| 5 | 8 | body×6/heading×2 | 1（heading） |
| **6** | **11** | **heading×2/body×5/figure-label×2/caption×2** | **2 条 `figure-label`** |

**只有第 6 页含 `figure-label` 类型分段，且是唯一存在"同一图块 ≥2 个文本层分段"的页**（其余页题注段均为单成员）。
所以选第 6 页跑 —— 结论：**group 这次真的考到了**。

### B1. 成组结果：2 组，全部多成员，题注都挂对了

```
group 1（5 员，含题注=true，类型=table/table_caption）
    [0] table          order=1 Method
    [1] table          order=2 RGMP [1] DMM-Net [8] AGSS-VOS 
    [3] table          order=3 validation Extra data OL J (%)
    [4] table          order=4 RVOS [23] RGMP [1] AGSS-VOS [3
    [5] table_caption  order=5 Table 1: Comparison with state
group 2（3 员，含题注=true，类型=table/table_caption）
    [6] table          order=6 Extra data OL J S (%) J U (%) 
    [7] table          order=7 RVOS [23] S2S [11] RGMP [1] X 
    [8] table_caption  order=8 Table 2: Comparison with state
```

对应的原始条目（group 1 的完整成员 + group 2）：

```json
{"i":0,"type":"table","order":1,"group":1,"action":"keep","why":"表1表头行","latex":null,"parts":[],"inline":[]}
{"i":1,"type":"table","order":2,"group":1,"action":"keep","why":"表1数据行","latex":null,"parts":[],"inline":[]}
{"i":3,"type":"table","order":3,"group":1,"action":"keep","why":"表1分组行","latex":null,"parts":[],"inline":[]}
{"i":4,"type":"table","order":4,"group":1,"action":"keep","why":"表1test-dev行","latex":null,"parts":[],"inline":[]}
{"i":5,"type":"table_caption","order":5,"group":1,"action":"keep","why":"表1题注","latex":null,"parts":[],"inline":[]}
{"i":6,"type":"table","order":6,"group":2,"action":"keep","why":"表2表头行","latex":null,"parts":[],"inline":[]}
{"i":7,"type":"table","order":7,"group":2,"action":"keep","why":"表2数据行","latex":null,"parts":[],"inline":[]}
{"i":8,"type":"table_caption","order":8,"group":2,"action":"keep","why":"表2题注","latex":null,"parts":[],"inline":[]}
```

图像核对（`cycle_p6_full.png`）：页面上确为 **Table 1（DAVIS17，含 validation 与 test-dev 两块）** 与 **Table 2（Youtube-VOS）** 两张表，
两段题注分别紧跟各自表格。模型把 Table 1 的 4 个碎片 + 题注收进 group 1，把 Table 2 的 2 个碎片 + 题注收进 group 2，
**没有把两张表混成一组，也没有出现单元素 group**。`captionWithoutGroup = 0`。

- ✅ `type: table_caption` 正确（上一轮 p4 只有单成员 group，这次是真多成员）。
- ⚠️ 小瑕疵（不影响成组结论）：`[0]"Method"` 其实是 **Table 2** 的列头行（应属 group 2），`[2]"4.2 Main results"` 是正文章节标题（应是 `heading`），
  两者都被标成 `table`；`[0]` 还被归进了 group 1。属 type/归属的小偏差。
- ✅ 回包里 **0 条出现 `columns`**、**0 条出现 `bbox`**，符合"删字段、不给坐标"。

## 其余口径（两页合并）

| 项 | p2（任务 A） | p6（任务 B） |
|---|---|---|
| 编号完整性 | 漏 0 / 多 0 / 重复 0；order 与数组顺序一致 ✅ | 漏 0 / 多 0 / 重复 0；一致 ✅ |
| 锚点定位 | 2/2 精确（严格），0 宽松 / 0 模糊 / **0 失败** | 2/2 精确，0 / 0 / **0 失败** |
| inline | 0 条（该页无合适残渣，给空数组 ✅） | **4 条全部命中**；长度 8/10/12/13，中位 12，**超 20 字 0 条** |
| 空回答 | 无（16000 直接成功） | 无 |
| 耗时 / token | 0.7s；prompt 2707，completion 2748（其中 reasoning 2360） | 0.8s；prompt 3400，completion 2167（其中 reasoning 1577） |
| 总 token | 5455（缓存命中 2560） | 5567（无缓存命中） |

`inline` 收紧后的表现很好：4 条全是残渣形态（`X t and Y ̂ t`、`γ = 1. 0`、`β 1 = 0. 9`、`β 2 = 0. 999`），
LaTeX 也都正确（`\gamma = 1.0`、`\beta_1 = 0.9`、`\beta_2 = 0.999`），**没有再出现上一轮那种整句当 inline 的过度标注**。

## 协议风险与建议（基于本轮真实证据）

1. **`merge_next` 建议降级为"提示"而不是"指令"**：同一提示词两次跑结果不同（1 次 vs 0 次），
   且真正的续句对都跨页、页内协议表达不了。若要保留，至少加两条：
   - 排除 `heading/title/caption/table_caption/figure_caption`（否则"2 Related works"→"2.1 …"这种字面候选会误触发）；
   - 要求"下一段以大写开头则不得给出 merge_next"（本轮第 1 次就是踩了这条）。
2. **跨页续句需要单独机制**：cycle 第 2 页两端（续自 p1、续到 p3）都不是页内可解的。要么把相邻页一起送进模型，要么本地处理。
3. **跨栏顺序仍未验证**：cycle 6 页均非双栏，`segments` 数组顺序 = 阅读顺序只在单栏上成立。建议后续在真有双栏的论文上补测。
4. **`group` 可以放心保留**（本轮 2 组全对、题注全挂对），但建议补一条类型约束：表内文字统一 `table`、正文章节标题不得标 `table`。
5. **`columns` 删掉是对的**（两次跑 0 条出现），**`bbox` 也是 0 条出现**，符合预期。
6. `max_tokens=16000` 两次都是一次成功，未触发重试 —— 与第一轮"8000 必空"的结论一致，维持 16000 下限。

## 产出与文件

- `scratch/vision/probe_v2b.js`（已参数化：`--page N`、`--pdf cycle|stm`、`--check` 只做前置检查；`PROBE_OUT` 可换输出文件名）
- `scratch/vision/probe_v2b_result.json`（p2 = 任务 A 的原始回包 + 核对 + 人工结论）
- `scratch/vision/probe_v2b_p6_result.json`（p6 = 任务 B 的原始回包 + 核对 + 人工结论）
- `scratch/vision/cycle_p2_full.png`、`cycle_p6_full.png`（渲染的页面图）
- `scratch/vision/survey_cycle_pages.js` + `cycle_pages_survey.json`（1~6 页选页体检）
- `scratch/vision/probe_v2b_annotate.js`（把上述结论离线附到两份结果 JSON 上）
- 未修改 `src/` 与 `media/`。
