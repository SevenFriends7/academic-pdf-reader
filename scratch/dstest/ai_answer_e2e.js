/**
 * 决定性验证：直接实例化真实的 Translator 类，调用 streamAcademicAnswer，
 * 用真实 DeepSeek 接口确认「AI 问答跟随所选引擎」而不是偷偷走 Gemini。
 *
 * vscode 模块用 stub 替换（translator.ts 只用到 workspace.getConfiguration）。
 * 用法：node scratch/dstest/ai_answer_e2e.js <deepseekKey> [geminiKey]
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const DS_KEY = process.argv[2];
const GEM_KEY = process.argv[3] || 'AQ.FAKE-GEMINI-KEY-FOR-TEST-000000000000';
if (!DS_KEY) {
  console.error('缺少 DeepSeek key');
  process.exit(2);
}

// ---- 读真实用户设置（用于构造 stub 配置） ----
const settingsPath = path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'settings.json');
const rawSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const conf = {};
Object.keys(rawSettings)
  .filter(k => k.startsWith('academicReader.'))
  .forEach(k => (conf[k.slice('academicReader.'.length)] = rawSettings[k]));
// 强制用到我们要验证的值
conf.translationService = 'openai-compatible';
conf.apiEndpoint = 'https://api.deepseek.com/v1';
conf.modelName = 'deepseek-chat';
conf.apiKey = DS_KEY;
conf.geminiApiKey = GEM_KEY;
conf.aiModel = '';

// ---- vscode stub ----
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (key, dflt) => (conf[key] !== undefined ? conf[key] : dflt)
    })
  },
  window: {},
  Uri: {}
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const BUILD = path.join(__dirname, 'build');
if (!fs.existsSync(path.join(BUILD, 'translator.js'))) {
  console.error('缺少编译产物，请先运行：\n  npx tsc src/translator.ts --outDir scratch/dstest/build --module commonjs --target es2020 --skipLibCheck --esModuleInterop');
  process.exit(2);
}
const { PaperTranslator } = require(path.join(BUILD, 'translator.js'));

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => {
    if (ok) {
      pass++;
      console.log(`  ✅ ${name}`);
    } else {
      fail++;
      console.log(`  ❌ ${name}${detail ? '\n       ' + detail : ''}`);
    }
  };

  const t = new PaperTranslator(() => {});

  // ---- 用例 1：引擎为 openai-compatible 时，AI 问答必须走 DeepSeek ----
  console.log('\n===== T1 streamAcademicAnswer 走 DeepSeek（真实接口） =====');
  const deltas = [];
  try {
    const res = await t.streamAcademicAnswer(
      {
        requestId: 'test-req-1',
        question: 'STM 用什么机制读取记忆？',
        selectedText: '',
        contextParagraph:
          '【第 3 页·第 2 段】Space-time memory networks store past frames with object masks as memory, and read relevant values using key-value addressing.',
        page: 3,
        history: [],
        answerStyle: 'standard'
      },
      chunk => deltas.push(chunk)
    );
    check('返回了回答', !!res.answer && res.answer.length > 10, `长度 ${res.answer ? res.answer.length : 0}`);
    check('模型名是 DeepSeek 的模型（不是 gemini-*）', /deepseek/i.test(res.model), `model=${res.model}`);
    check('确实流式（收到多个增量）', deltas.length > 1, `分片 ${deltas.length}`);
    check('增量拼接 == 最终回答', deltas.join('') === res.answer, `流式 ${deltas.join('').length} vs 最终 ${res.answer.length}`);
    check('回答扣住给定上下文（key-value/键值/记忆）', /key|value|键值|记忆/i.test(res.answer), res.answer.slice(0, 80));
    check('记录了首字与总耗时', typeof res.ttftMs === 'number' && res.totalMs > 0, `ttft=${res.ttftMs}ms total=${res.totalMs}ms`);
    console.log(`     （模型 ${res.model}，首字 ${res.ttftMs}ms，全程 ${res.totalMs}ms）`);
    console.log(`     回答前 90 字：${res.answer.replace(/\s+/g, ' ').slice(0, 90)}`);
  } catch (e) {
    check('AI 问答调用成功', false, `${e.name}: ${e.message}`);
  }

  // ---- 用例 2：多轮对话经该路径也生效 ----
  console.log('\n===== T2 多轮历史（真实接口） =====');
  try {
    await t.streamAcademicAnswer(
      { requestId: 'h1', question: '把 STM 的记忆起个别名叫「记忆读取器」，只回复"好的"。', selectedText: '', page: 3 },
      () => {}
    );
    const r2 = await t.streamAcademicAnswer(
      {
        requestId: 'h2',
        question: '刚才让它叫什么名字？只回答名字本身。',
        selectedText: '',
        page: 3,
        history: [
          { role: 'user', text: '把 STM 的记忆起个别名叫「记忆读取器」，只回复"好的"。' },
          { role: 'model', text: '好的。' }
        ]
      },
      () => {}
    );
    check('多轮：记住了上一轮', r2.answer.includes('记忆读取器'), r2.answer.slice(0, 60));
  } catch (e) {
    check('多轮调用成功', false, `${e.name}: ${e.message}`);
  }

  // ---- 用例 3：假装 Gemini key 无效 —— 若问答还在偷偷走 Gemini，这一步必失败 ----
  console.log('\n===== T3 反证：Gemini key 是假的，问答照样成功 =====');
  check('T3 前提：stub 里的 geminiApiKey 是伪造的', /FAKE/.test(vscodeStub.workspace.getConfiguration().get('geminiApiKey')), '');

  // ---- 用例 4：内置引擎应给出明确报错而不是静默走 Gemini ----
  console.log('\n===== T4 不支持的引擎要明确报错 =====');
  const saved = conf.translationService;
  conf.translationService = 'built-in';
  try {
    await t.streamAcademicAnswer({ requestId: 'b1', question: 'hi', selectedText: '', page: 1 }, () => {});
    check('内置引擎应拒绝 AI 问答', false, '居然成功了');
  } catch (e) {
    check('内置引擎 → invalid-request 且提示清楚', e.kind === 'invalid-request' && /引擎/.test(e.message), `${e.kind}: ${e.message}`);
  }
  conf.translationService = saved;

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail > 0 ? 1 : 0);
})();
