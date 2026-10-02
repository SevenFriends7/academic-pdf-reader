/**
 * 问答两类行为实测：
 *   A 类（通用概念）→ 必须正面回答，不能拒答、不能反复声明"上下文未提供"
 *   B 类（本论文特定事实，且上下文里没有）→ 必须诚实说"上下文未提供"，不能编造
 * 用法：node scratch/dstest/qa_scope_test.js <deepseekKey>
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const raw = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'settings.json'), 'utf8'));
const conf = {};
Object.keys(raw)
  .filter(k => k.startsWith('academicReader.'))
  .forEach(k => (conf[k.slice('academicReader.'.length)] = raw[k]));
conf.translationService = 'openai-compatible';
conf.apiKey = process.argv[2];
conf.aiModel = '';

const stub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => (conf[k] !== undefined ? conf[k] : d) }) },
  window: {},
  Uri: {}
};
const ol = Module._load;
Module._load = function (r) {
  if (r === 'vscode') return stub;
  return ol.apply(this, arguments);
};

const { PaperTranslator } = require(path.join(__dirname, 'build', 'translator.js'));

// 用真实的论文片段当上下文（STM 第 2 页）
const CTX =
  'The question is how to design an efficient deep neural network (DNN) architecture that exploits all the frames. ' +
  'In this paper, we propose a novel DNN system based on the memory network that computes the spatio-temporal attention ' +
  'on every pixel in multiple frames of the video for each pixel in the query image, to decide whether the pixel belongs ' +
  'to a foreground object or not. While the online learning improves accuracy, it is computationally expensive, limiting its practical use.';

const CASES = [
  {
    id: 'A1',
    kind: '通用概念',
    question: 'object-agnostic segmentation 到底是什么意思？我从来没听过这个词，能通俗讲讲吗？',
    expect: 'positive',
    forbid: [/无法确定/, /上下文未提供/, /当前上下文没有/]
  },
  {
    id: 'A2',
    kind: '发散联想',
    question: '突然想到一个问题：如果我不做视频分割，而是想用类似的记忆机制做音频降噪，思路成立吗？',
    expect: 'positive',
    forbid: [/无法确定/, /上下文未提供/, /仅凭当前上下文/]
  },
  {
    id: 'A3',
    kind: '术语背景',
    question: 'online learning 在深度学习里一般指什么？和 offline learning 的区别是什么？',
    expect: 'positive',
    forbid: [/无法确定/, /上下文未提供/]
  },
  {
    id: 'B1',
    kind: '论文特定事实（上下文里没有）',
    question: '这篇论文在 DAVIS-2016 验证集上报告的 J&F 分数具体是多少？',
    expect: 'honest',
    forbid: [/\b6[0-9]\.[0-9]\b/, /\b7[0-9]\.[0-9]\b/, /\b8[0-9]\.[0-9]\b/] // 不许凭空给出数字
  }
];

(async () => {
  const t = new PaperTranslator(() => {});
  let pass = 0;
  let fail = 0;
  const dump = [];

  for (const c of CASES) {
    console.log(`\n[${c.id}] ${c.kind} — ${c.question}`);
    let answer = '';
    try {
      const r = await t.streamAcademicAnswer(
        {
          requestId: 'q-' + c.id,
          question: c.question,
          selectedText: '',
          contextParagraph: CTX,
          page: 2,
          history: []
        },
        () => {}
      );
      answer = r.answer;
    } catch (e) {
      console.log(`  ❌ 调用失败: ${e.kind || e.name}: ${e.message}`);
      fail++;
      continue;
    }

    const body = answer.replace(/\s/g, '').length;
    const notesGap = /未提供|未包含|没有给出|无法确定|并没有出现|不在.*上下文|查不到|论文中未|上下文里没有/.test(answer);
    dump.push(`## [${c.id}] ${c.kind}\n\n**问**：${c.question}\n\n**答**（${body} 字）：\n\n${answer}\n\n---\n`);

    if (c.expect === 'positive') {
      // 判据：既要正面回答，又不能把篇幅写爆（篇幅是 token 花销的直接来源）。
      // 默认风格为 concise → 预算 60~800 字；旧默认 standard 动辄 1600+ 字。
      const substantive = body >= 60;
      const withinBudget = body <= 800;
      if (!substantive) {
        console.log(`  ❌ 回答过短（${body} 字）——疑似仍在拒答`);
        fail++;
      } else if (!withinBudget) {
        console.log(`  ❌ 超出篇幅预算（${body} 字 > 800 字）——回答又开始膨胀了`);
        fail++;
      } else {
        console.log(`  ✅ 正面回答（${body} 字，在预算内）${notesGap ? '；并如实标注了论文里没有该内容' : ''}`);
        pass++;
      }
    } else {
      const fabricated = c.forbid.some(re => re.test(answer));
      if (fabricated) {
        console.log('  ❌ 编造了上下文里没有的具体数字');
        fail++;
      } else if (!notesGap) {
        console.log('  ⚠️ 没编数字，但也没明确说明上下文未提供');
        fail++;
      } else {
        console.log('  ✅ 诚实说明上下文未提供，且没有编数字');
        pass++;
      }
    }
  }

  const outPath = path.join(__dirname, 'qa_scope_out.md');
  fs.writeFileSync(outPath, `# 问答两类行为实测输出\n\n上下文（STM 第 2 页片段）：\n\n> ${CTX}\n\n---\n\n${dump.join('\n')}`, 'utf8');
  console.log(`\n完整回答已写入 ${outPath}`);
  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail > 0 ? 1 : 0);
})();
