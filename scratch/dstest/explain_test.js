/**
 * 讲解质量实测：模拟"基础一般"的读者提问，检查回答是否补齐前置概念。
 * 用法：node scratch/dstest/explain_test.js <key>
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
conf.aiAnswerStyle = undefined; // 走 package.json 的默认值
delete conf.aiAnswerStyle;

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

const CTX =
  'We propose a novel DNN system based on the memory network that computes the spatio-temporal attention on every pixel in multiple frames of the video for each pixel in the query image, to decide whether the pixel belongs to a foreground object or not. ' +
  'Key is used for addressing. Specifically, similarities between key features of the query and the memory frames are computed to determine when-and-where to retrieve relevant memory values from. Therefore, key is learned to encode visual semantics for matching robust to appearance variations. ' +
  'On the other hand, value stores detailed information for producing the mask estimation.';

const QUESTIONS = [
  {
    id: 'Q1',
    q: '论文里说的 key-value addressing 到底怎么工作的？我基础一般，能不能从头讲一遍？',
    // 期望出现"讲解性"标记：类比/例子/通俗说明
    want: [/例如|比如|打个比方|可以理解为|类比|通俗/, /查询|query/i, /键|key/i],
    forbid: []
  },
  {
    id: 'Q2',
    q: '为什么这里要用注意力机制？直接比对像素不行吗？',
    want: [/例如|比如|可以理解为|区别|相比/, /像素|pixel/i],
    forbid: []
  }
];

(async () => {
  const t = new PaperTranslator(() => {});
  let pass = 0;
  let fail = 0;
  const dump = [];
  for (const c of QUESTIONS) {
    console.log(`\n[${c.id}] ${c.q}`);
    let answer = '';
    try {
      const r = await t.streamAcademicAnswer(
        { requestId: c.id, question: c.q, selectedText: '', contextParagraph: CTX, page: 3, history: [] },
        () => {}
      );
      answer = r.answer;
    } catch (e) {
      console.log(`  ❌ 调用失败: ${e.kind || e.name}: ${e.message}`);
      fail++;
      continue;
    }
    const body = answer.replace(/\s/g, '').length;
    dump.push(`## [${c.id}]\n\n**问**：${c.q}\n\n**答**（${body} 字）：\n\n${answer}\n\n---\n`);
    const hasExplain = c.want.every(re => re.test(answer));
    console.log(`  回答 ${body} 字；含讲解性表述与关键概念：${hasExplain ? '✅' : '❌'}`);
    if (body < 250) {
      console.log('  ❌ 太短，基础一般的读者可能仍看不懂');
      fail++;
    } else if (!hasExplain) {
      console.log('  ❌ 缺少"举例/类比/通俗说明"或关键概念没覆盖');
      fail++;
    } else {
      console.log('  ✅ 有讲解、篇幅足够');
      pass++;
    }
  }
  fs.writeFileSync(path.join(__dirname, 'explain_out.md'), `# 讲解质量实测\n\n上下文：\n\n> ${CTX}\n\n---\n\n${dump.join('\n')}`, 'utf8');
  console.log(`\n完整回答已写入 scratch/dstest/explain_out.md`);
  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
})();
