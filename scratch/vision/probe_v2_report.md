# v2 版面分割协议探针报告（真实 deepseek-flash 调用）

- 脚本：`scratch/vision/probe_v2.js`（真调 API，可重复运行）
- 原始回包 + 核对结果：`scratch/vision/probe_v2_result.json`
- 素材：`scratch/vision/p4_full.png`（第 4 页整页，389 KB）+ 全局存储最新存档
  `paper_1f6c2345c825e6b5dac7170135b540b1.json` 的 `pageArchive["4"]`（12 条本地分段）
- 协议：v2 = `i/type/order/group/action/why/latex/parts[{type,at,latex}]/inline[{find,latex}]`，**无 bbox**（已按用户拍板删除，回包也确实没有任何坐标字段）
- 未经我调用的原始数据全部来自上述真实文件，无编造。

## 结论先行

**协议守得住，字段级几乎全绿；但有两个保留意见：`group` 只拿到单元素 group（覆盖不足，未真正验证成组能力），`columns` 实测给错，`merge_next` 没被触发。锚点定位 6/6 全部精确命中——但这是"模型肯照抄文本层"的胜利，不是"跨写法容错"的胜利。**

| 核对项 | 结果 |
|---|---|
| ① 编号完整性 | ✅ 12/12，无漏/无多/无重复；`order` 是 1..12 严格排列；type/action 全部合法 |
| ② 锚点定位率 | ✅ **6/6 = 100%**（全部 exact-strict 精确命中，0 模糊、0 失败） |
| ③ parts 质量 | ✅ 2 个 split 段各拆 3 片，类型与锚点都正确；1 个 order 语义瑕疵 |
| ④ group + figure_caption | ⚠️ 图注正确标 `figure_caption` 且给了 group，但**该 group 只有 1 个成员**（本页文本层只覆盖 1 条图区段落，验证不充分）；无 bbox 字段 ✅ |
| ⑤ inline | ✅ 7/7 条 `find` 逐字命中；但有 1 条把整句当"行内公式"，属过度标注 |
| ⑥ 成本与延迟 | 首次 8000 token 被推理吃光 → 空回答；加倍到 16000 后成功。成功那次 reasoning 6868 tok + 正文约 1060 tok，prompt 2715 tok |

## ① 编号完整性：通过

回包 12 条，去重后 12 个不同 `i`，与本地 12 条一一对应；`missingI/extraI/duplicateI` 全空；
`order` 序列 = `1,2,3,4,5,6,7,8,9,10,11,12`，是严格排列；非法 type 0 个、非法 action 0 个。
类型改写只有 4 处（`caption→figure_caption`、`keywords→body`、1 条 `formula→noise`），其余保持。

唯一瑕疵：**`columns: 1` 是错的**（本页图像实为分栏页面，大图占栏、题注整宽）。这个字段既不准、也没有任何产品代码消费它。

## ② 锚点定位率（最重要结论）：6/6 精确命中

定位器实现（`probe_v2.js` 的 `normalize`/`locateAll`）：NFC → 去空白/零宽/全角空格 → `U+02C6` 与 `U+0302` 统一 → dash 统一（`− – — ‐ → -`）→ `× · ⋅ → x` → 上下标数字转 ASCII → 小写；先"严格归一化"精确 `indexOf`，再"去组合附标"宽松精确，最后滑动窗口 + 二元组 Dice ≥ 0.7 模糊兜底。

| 段 | 片 | 类型 | 锚点（截断） | 结果 |
|---|---|---|---|---|
| 6 | 0 | body | `With the cyclic reference set, we can obtain the prediction` | exact-strict |
| 6 | 1 | formula | `(̂) Y ̂ 1 = S θ X t, Y ̂ t, X 1 (2)` | exact-strict |
| 6 | 2 | body | `Consequently, we apply mask reconstruction loss` | exact-strict |
| 7 | 0 | formula | `L cycle,t = L (Y ̂ t, Y t) + L (Y ̂ 1, Y 1) (3)` | exact-strict |
| 7 | 1 | body | `In implementation, we utilize the combination` | exact-strict |
| 7 | 2 | formula | `∑ () 1 ∑ ̂ u ∈ Ω min(Y t,u, Y t,u)` | exact-strict |

**失败样例：0 个**，宽松与模糊两级完全没派上用场。

> ⚠️ 读这个 100% 时必须带上口径：6 个锚点全部与文本层**逐字符相同**——连 `"(̂)"`（`(`+U+0302）这种残渣顺序、
> 连公式编号 `(2)(3)` 都照抄了，逐 codepoint 对过。也就是说模型这次是严格在"照抄下面给的列表"，
> **本页没有出现"模型改用图像排版写法（如 `Ŷ_t`、`X̂_t`、真下标）"的硬骨头**。
> 文本层真实字符是 `Y`+`U+0302`（共 21 处），不是 `Ŷ`(U+0176) —— 我的两级归一化正是为这种差异准备的，
> 但这次没被触发。所以：**可以放心把锚点当手术刀用；但"锚点定位失败就跳过该处手术"的兜底逻辑仍然必须留**，
> 因为一旦模型哪天按图像写法给锚点，就只能靠"宽松归一化 + Dice 模糊"兜。

## ③ parts 质量：好

`action=split` 共 2 段（i=6、i=7），都是"正文 + 独立公式 + 正文/公式"这种真实结构，各拆 3 片，类型正确、锚点可定位、公式片都带了 LaTeX，且**首片都正确地没给 `at`**（协议允许）。

i=7 完整条目（真实回包，未删改）：

```json
{
  "i": 7, "type": "body", "order": 8, "group": null, "action": "split",
  "why": "夹带式(3)与式(4)", "latex": null,
  "parts": [
    { "type": "formula", "at": "L cycle,t = L (Y ̂ t, Y t) + L (Y ̂ 1, Y 1) (3)",
      "latex": "\\mathcal{L}_{cycle,t} = \\mathcal{L}(\\hat{Y}_t, Y_t) + \\mathcal{L}(\\hat{Y}_1, Y_1)" },
    { "type": "body", "at": "In implementation, we utilize the combination" },
    { "type": "formula", "at": "∑ () 1 ∑ ̂ u ∈ Ω min(Y t,u, Y t,u)",
      "latex": "\\mathcal{L}(\\hat{Y}_t, Y_t) = \\frac{1}{|\\Omega|}\\sum_{u \\in \\Omega}\\left((1-Y_{t,u})\\log(1-\\hat{Y}_{t,u}) + Y_{t,u}\\log(\\hat{Y}_{t,u})\\right) - \\gamma \\frac{\\sum_{u \\in \\Omega}\\min(\\hat{Y}_{t,u}, Y_{t,u})}{\\sum_{u \\in \\Omega}\\max(\\hat{Y}_{t,u}, Y_{t,u})}" }
  ],
  "inline": []
}
```

i=6 第 1 片（公式 (2)）：`at = "(̂) Y ̂ 1 = S θ X t, Y ̂ t, X 1 (2)"`，
`latex = "\\hat{Y}_1 = \\mathcal{S}_\\theta\\left(\\hat{\\mathcal{X}}_t, \\hat{\\mathcal{Y}}_t, X_1\\right)"`。

- ✅ 正确：公式识别、"正文/公式"分界、LaTeX 转写（式 (2)(3)(4) 均与图像肉眼核对一致：`\mathcal{S}_\theta`、`\mathcal{L}_{cycle,t}`、`\frac{1}{|\Omega|}` 那串都对）。
- ⚠️ 已知瑕疵：i=7 的第 0 片 `at` 是 `"L cycle,t = ..."` 而该段的 cleanText 以 `"L cycle,t = ..."` 开头 —— 语义上公式确实在最前（视觉排版如此），但它正是"文本层把公式标号顺序打乱"的产物；这种 `at` 落在段落极靠前的片，代码切点要做"避免切出空片"的保护。
- ⚠️ 模型把 i=8（本地判断为 `formula`、真实内容是式(4)的残渣碎片）改判 `noise` + `action=drop`（理由"已并入 i=7"）——**动作是对的**（避免式(4)被拆成两半），但说明模型倾向于用 `drop` 绕开"同一公式块归并"的问题。

## ④ group + figure_caption：只拿到单元素 group，验证不充分

本页图像上确实有一张大图（Figure 2，图内还有 `Segmentation Network`/`Loss`/`Correction` 等标签）和图注。但**本地文本层在这一页只吐出 1 条图区段落**，就是 `[0]` 图注（图内标签压根没进文本层）。

回包对该段的处理（真实条目）：

```json
{ "i": 0, "type": "figure_caption", "order": 1, "group": 1, "action": "keep",
  "why": "图2题注", "latex": null, "inline": [] }
```

- ✅ `type: "figure_caption"` 正确；给了 `group: 1`；`figure_caption` 无 group 的情况为 0 条；`i=8` 那条 `noise` 也没乱给 group。
- ❌ 但 `group 1` 只有 1 个成员 —— **"图内文字与图注同组"这件事本页根本没有素材可验**。要真正验证，得换一页"图内标签进了文本层"的页面（或表页）。目前只能说：模型愿意在 `figure_caption` 上给 group。
- ✅ 回包里 0 条出现 `bbox` 字段，符合"不给坐标"的要求。

## ⑤ inline：7 条全部逐字命中，但有过度标注

7 条 `find` 全部在该段 cleanText 里逐字出现（7/7 exact-strict），`latex` 也都有：`Y ̂ t→\hat{Y}_t`、`Y ̂ t,u→\hat{Y}_{t,u}`、`Y t,u→Y_{t,u}` 等，全部合理。

- ⚠️ 过度标注 1 条：i=2 的 `find: "{ Y 1 } { Y i | i ∈ [2, t − 1] }"` —— 这是**一整句公式片段**，不是"行内公式残渣"。虽然 `find` 合法可定位，但把这种长串当 inline 替换项，会把"逐字替换"变成"整句重排"，手术风险高。
- 建议：提示词里给 `find` 加硬约束——"长度 ≤ 20 字、且必须是不含空格的连续残渣 token 组（如 `Y ̂ t`）"，或要求 `find` 必须匹配形如 `[A-Za-z]\s*[̂]?\s*[_]?\s*[A-Za-z0-9,]*` 的模式。

## ⑥ 成本与延迟

| 轮次 | max_tokens | 结果 | 说明 |
|---|---|---|---|
| 1 | 8000 | ❌ 空回答 | `finish_reason=length`，`completion_tokens=8000` 全是 `reasoning_tokens`，`content` 0 字符 |
| 2 | 16000 | ✅ 成功 | `finish_reason=stop`，reasoning 6868 tok + 正文 2728 字符（约 1060 tok），prompt 2715 tok（其中 2560 命中缓存） |

- 两次 API 各约 0.6~0.7 s（服务端流式/加速），端到端总耗时 68 s（含密钥/存档读取与本地核对；另有一次失败重试的抖动）。
- **实测确认了"8000 不够"这个坑**：推理型视觉模型在 JSON 长 schema 下推理会长到吃光 8k。**建议 max_tokens 下限直接设 16000**，而不是 8000 + 翻倍重试 —— 省掉一次必然的失败往返。
- output token 构成：正文约 1.1k，推理约 6.9k → **推理是主要成本**。提示词/示例越长，推理越短不了；所以能删的字段就是省钱。

## ⑦ 协议精简建议（明确取舍）

**保留（模型零违规、代码必需）**：`i`、`type`、`action`、`parts[{type, at, latex}]`、`group`、`inline[{find, latex}]`。

**建议删除**：

1. **`columns` 直接删** —— 本页实测给错（1 vs 分栏），且无消费者。
2. **`order` 建议删（或声明"可为 null"）** —— 回包是 `1..N` 严格排列，而 `i` 的列表顺序本身就是阅读顺序，代码完全可以自己推。省 12 个数字的输出。
3. **顶层 `latex` 与 `parts[].latex` 重复** —— 建议语义收敛为"**只有 `action=keep` 且 `type=formula` 的整段公式才用顶层 `latex`**"，`parts` 里的公式片一律用 `parts[].latex`，避免模型两边都填、以及 `latex: null` 这种噪声（本例 12 条里有 6 条显式 `"latex": null`、7 条显式 `"inline": []`）。
4. **`why` 可以留**，但压缩到"10 字内"更省；它对人审很有用。
5. **`fixes` 可以留**（1 句，成本极低，调试价值高）。

**需要补/改的（比删字段更重要）**：

1. **`max_tokens` 下限 16000**（实测 8000 必空）。
2. **`merge_next` 需要更强的引导**：本页真正该合并的 `[1]`（"the inference stage, the corresponding predicted mask Ŷ_t …"）和 `[2]`（"mask. Hence, we have …"）模型都给了 `keep`。复杂 schema 下模型变保守、放弃了续句判断 —— 要么在提示词里单独强调这一条，要么承认 `merge_next` 不可依赖、改用本地启发式（首字母小写 + 上段未以句号结尾）。
3. **`group` 要给更强的约束**：明确"同一张图的 `figure`（图内文字）+ `figure_caption` 必须同 group"，并**换一页真正有图内文字的页面实测**，本页不能算通过。
4. **`inline.find` 加长度/形态约束**，杜绝"整句当行内公式"。

**一句话总评**：v2 的字段结构对模型不算重，12/12 编号、6/6 锚点、7/7 inline 逐字命中、parts 拆分正确，说明"编号 + 锚点 + 分片类型"这套骨架是稳的，**可以按"锚点定位失败就跳过该处手术"落地**；风险集中在两处不是"模型不听话"而是"**本页没考到**"（group 成组、锚点跨写法容错）和"**模型会绕**"（`merge_next` 不用、用 `drop` 代替归并）。
