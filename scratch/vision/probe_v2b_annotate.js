/**
 * 把人工核对结论附到两次真实跑的结果 JSON 上（不发 API，纯离线）。
 * 只追加 consoleNotes 字段，不改动已存回包。
 */
const fs = require('fs');
const path = require('path');

function attach(file, notes) {
  const p = path.join(__dirname, file);
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  r.consoleNotes = notes;
  fs.writeFileSync(p, JSON.stringify(r, null, 2), 'utf8');
  console.log('已追加 consoleNotes →', file);
}

attach('probe_v2b_result.json', {
  task: '任务 A merge_next（cycle.pdf 第 2 页，真调 API）',
  quotedPairNotInArchive:
    '父 agent 引用的那对样本（"A related work fine-tunes … appearance of the" / "target object [2,34,26,14,26,11,18] during the test time."）' +
    '**不在 cycle.pdf 归档里**：cycle 存档关键词命中 0 次；该措辞出现在 scratch/llm-test/viewer-unit.js:1031 的单元测试夹具里，' +
    '另外 STM 存档里有一条用户批注用了极相似的句式（annotations 字段，非分段）。真实的 cycle 第 2 页是**单栏**页（图像已核对），无该文本。',
  mergeNextVerdict:
    '两次同样的提示词跑同一页，结果不同：第 1 次给 i=1 action=merge_next（why="小写起首，上页续句"），' +
    '第 2 次给 i=1 action=keep（why="上页续段，本页无前段可并"）。口径上 merge_next 的语义是"本段是**下一段**的续句"，' +
    '而 i=1 的下一段 [2] 以大写 "Based on these observations" 开头 → 第 1 次那次是**假阳性**（模型想表达的是"续自上一页"）。' +
    '第 2 次的判断才是语义正确的，而且"本页无前段可并"这个理由说明它分得清"跨页续接"和"merge_next"。',
  runToRunVariance: 'temperature=0 下同一提示词同一页两次回包不一致（merge_next 1 次 vs 0 次），这是协议稳定性上的真实噪声，落地时要有兜底。',
  trueCandidateMissed:
    '规则真值候选只有 1 对：[6]"2 Related works"(heading) → [7]"2.1 Semi-supervised…"——但 [6] 是标题，' +
    'merge_next 对它本来就不适用（模型给 keep 是对的，属规则字面 vs 语义的边界情形）。' +
    '真正该并的同句续接对：[1] 续自**上一页**、[7] 续到**下一页**（第 3 页 [0] 以 "methods. OVOS [2] …" 开头），都跨页，本页内无可并对象。',
  splitBonus: '模型额外把 [7] 拆成 heading("2.1 Semi-supervised video object segmentation") + body("Semi-supervised video object…")，两片类型与锚点均正确。',
  anchors: '2/2 精确命中（均在 [7] 的 parts 里），0 模糊 0 失败。',
  inline: '0 条（该页正文没有需要替换的行内公式残渣），符合"没有就给空数组"。'
});

attach('probe_v2b_p6_result.json', {
  task: '任务 B group 成组（cycle.pdf 第 6 页，真调 API）',
  groupVerdict:
    '**group 在真实素材上第一次被验证通过**（此前只有单元测试覆盖）。选页依据：第 1~6 页里只有第 6 页含 `figure-label` 类型分段（2 条），' +
    '且是唯一存在"同一图块 ≥2 个文本层分段"的页；其余页的题注段都是单成员。',
  groupsFound:
    '给 2 个 group、0 个单元素组：group1 = 4 条 table([0][1][3][4]) + 1 条 table_caption([5] Table 1)，共 5 员；' +
    'group2 = 2 条 table([6][7]) + 1 条 table_caption([8] Table 2)，共 3 员。图内/表内文字与题注确实同组，且没有把两张表混成一组。',
  captionTypeCorrect: '两个题注都标成 table_caption；captionWithoutGroup = 0。',
  minorIssue: '[0]"Method" 与 [2]"4.2 Main results" 都被标成 table：前者其实是 Table 2 的列头行（应属 group2），后者是正文章节标题（应属 heading）。' +
    '这影响的是 type 与个别归属，不影响"成组"这个结论。',
  splitBonus: '[9] 被判 split：parts = body("to the time-consuming gradient…") + body("Implementation details. The training…")，' +
    '锚点均精确命中——这是跨语义边界的真实拆分（前一段结尾 + 新小节开头被并成一段）。',
  inlineQuality: '4 条 inline 全部命中且**全部 ≤20 字**（长度 8/10/12/13，中位 12）：X t and Y ̂ t、γ = 1. 0、β 1 = 0. 9、β 2 = 0. 999，' +
    'LaTeX 也都对（\\gamma = 1.0、\\beta_1 = 0.9、\\beta_2 = 0.999）。收紧后的 find 约束这次完全守住。',
  anchors: '2/2 精确命中（均在 [9] 的 parts 里），0 模糊 0 失败。'
});

console.log('完成。');
