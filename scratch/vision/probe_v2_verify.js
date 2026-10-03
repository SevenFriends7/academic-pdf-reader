/**
 * 把 probe_v2_result.json 里已存好的原始回包重新过一遍核对逻辑，追加人工核对结论。
 * 不发任何 API 调用（省 token），纯离线计算 —— 结论与 probe_v2.js 的摘要一致。
 */
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'probe_v2_result.json');
const r = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!r.ok) throw new Error('报告本身是失败状态，不能追加结论');

const anchors = r.checks.anchors.counts;
r.consoleNotes = {
  anchorFidelity:
    `${anchors.total} 个锚点全部 exact-strict，且逐字符等于文本层原文（连 ")(" + U+0302 这种残渣顺序都照抄），` +
    '说明 100% 定位率证明的是"模型愿意照抄文本层写法"；本页没有出现"模型改用图像排版写法"的硬骨头。',
  columns:
    `回包 columns=${r.rawResponse.columns}；本页图像实为分栏页面（大图在栏内、题注整宽），该值不可信，` +
    '且没有任何产品代码消费它 → 建议删字段。',
  groupCoverage:
    '本页文本层只有 1 条段落在图区域内（[0] 图注），图内标签（Segmentation Network / Loss 等）根本没进文本层，' +
    '因此"图内文字 + 图注同组"这条只得到单元素 group，属覆盖不足，不能算验证通过。',
  splitSurgery:
    'i=6/i=7 的 6 个锚点全部可精确定位，说明 split 手术点可用；但唯一需要"处理已存在独立公式段"的 [8] 走的是 drop + 并入 i=7，' +
    '说明模型会用 drop 绕开 group 归并。',
  mergeNextNotUsed: '本页真正该合并的两段 [1]+[2]（"the inference stage..." 与 "mask. Hence, ..."）模型都给了 keep，未触发 merge_next。'
};
fs.writeFileSync(p, JSON.stringify(r, null, 2), 'utf8');
console.log('已追加 consoleNotes：');
console.log(JSON.stringify(r.consoleNotes, null, 2));
console.log('\nsummary:', JSON.stringify(r.summary, null, 2));
