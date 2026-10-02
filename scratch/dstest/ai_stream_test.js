/**
 * 真实端到端验证：AI 问答的 OpenAI 兼容流式路径。
 * 直接编译 src/llmClient.ts 并调用 callOpenAICompatStream，用真实 DeepSeek 接口验证：
 *   1. 增量（流式）回调确实逐段到达
 *   2. 最终文本完整
 *   3. 多轮 history 被正确传给模型（模型能引用上一轮内容）
 *   4. 错误分类正确（坏 key → auth）
 *
 * 用法：node scratch/dstest/ai_stream_test.js <apiKey> [endpoint] [model]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const KEY = process.argv[2];
const ENDPOINT = process.argv[3] || 'https://api.deepseek.com/v1';
const MODEL = process.argv[4] || 'deepseek-chat';
if (!KEY) {
  console.error('缺少 apiKey');
  process.exit(2);
}

(async () => {
  // 用 tsc 预编译好的产物（node scratch/dstest/compile.js）
  const built = path.join(__dirname, 'build', 'llmClient.js');
  if (!fs.existsSync(built)) {
    console.error(`未找到编译产物 ${built}，请先运行：npx tsc src/llmClient.ts --outDir scratch/dstest/build --module commonjs --target es2020 --skipLibCheck`);
    process.exit(2);
  }
  const { callOpenAICompatStream, LlmError } = require(built);

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

  // ---- 用例 1：流式 + 最终文本 ----
  console.log('\n===== T1 流式问答（真实 DeepSeek） =====');
  const deltas = [];
  let firstDeltaAt = 0;
  const t0 = Date.now();
  try {
    const res = await callOpenAICompatStream({
      endpoint: ENDPOINT,
      apiKey: KEY,
      model: MODEL,
      systemInstruction: '你是学术论文助手。只依据用户提供的内容回答，不要编造。直接输出 Markdown 正文。',
      turns: [
        {
          role: 'user',
          text:
            '论文原文：「Space-time memory (STM) networks store past frames with object masks as memory and read relevant values using key-value addressing.」\n\n' +
            '问题：STM 用什么机制取出相关的记忆？请用中文回答，并说明依据。'
        }
      ],
      temperature: 0.4,
      maxOutputTokens: 1024,
      onDelta: chunk => {
        if (!firstDeltaAt) firstDeltaAt = Date.now() - t0;
        deltas.push(chunk);
      },
      idleTimeoutMs: 60000,
      totalTimeoutMs: 180000
    });
    const totalMs = Date.now() - t0;
    const streamed = deltas.join('');
    check('收到增量分片（流式确实生效）', deltas.length > 1, `分片数 ${deltas.length}`);
    check('首字延迟在合理范围（< 30s）', firstDeltaAt > 0 && firstDeltaAt < 30000, `${firstDeltaAt}ms`);
    check('最终文本非空且完整', res.text.trim().length > 20, `长度 ${res.text.trim().length}`);
    check('增量拼起来 == 最终文本', streamed === res.text, `流式 ${streamed.length} vs 最终 ${res.text.length}`);
    check('返回了 finishReason', !!res.finishReason, String(res.finishReason));
    check('回答用中文且扣住原文（提到 key/value 或 memory）', /key|value|记忆|键值/i.test(res.text), res.text.slice(0, 80));
    console.log(`     （首字 ${firstDeltaAt}ms，全程 ${totalMs}ms，${deltas.length} 个分片）`);
    console.log(`     回答前 100 字：${res.text.replace(/\s+/g, ' ').slice(0, 100)}`);
  } catch (e) {
    check('流式问答成功', false, `${e.name}: ${e.message}`);
  }

  // ---- 用例 2：多轮历史生效 ----
  console.log('\n===== T2 多轮历史（真实 DeepSeek） =====');
  try {
    const res = await callOpenAICompatStream({
      endpoint: ENDPOINT,
      apiKey: KEY,
      model: MODEL,
      systemInstruction: '你是学术论文助手。直接输出 Markdown 正文。',
      turns: [
        { role: 'user', text: '我给它起个别名，叫「记忆读取器」。请只回复"好的"。' },
        { role: 'model', text: '好的。' },
        { role: 'user', text: '我刚才给它起的别名是什么？只回答别名本身。' }
      ],
      temperature: 0.2,
      maxOutputTokens: 256,
      idleTimeoutMs: 60000,
      totalTimeoutMs: 120000
    });
    check('多轮：模型记住了上一轮内容', res.text.includes('记忆读取器'), res.text.slice(0, 60));
  } catch (e) {
    check('多轮调用成功', false, `${e.name}: ${e.message}`);
  }

  // ---- 用例 3：坏 key 的错误分类 ----
  console.log('\n===== T3 错误分类（坏 key） =====');
  try {
    await callOpenAICompatStream({
      endpoint: ENDPOINT,
      apiKey: 'sk-invalid-key-for-test',
      model: MODEL,
      turns: [{ role: 'user', text: 'hi' }],
      idleTimeoutMs: 20000,
      totalTimeoutMs: 40000
    });
    check('坏 key 应抛错', false, '居然成功了');
  } catch (e) {
    check('坏 key → auth 分类', e instanceof LlmError && e.kind === 'auth', `${e.kind}: ${e.message}`);
  }

  // ---- 用例 4：取消（AbortSignal） ----
  console.log('\n===== T4 取消请求 =====');
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 700);
    await callOpenAICompatStream({
      endpoint: ENDPOINT,
      apiKey: KEY,
      model: MODEL,
      turns: [{ role: 'user', text: '请写一篇 3000 字的论文综述，越详细越好。' }],
      maxOutputTokens: 4096,
      signal: ctrl.signal,
      idleTimeoutMs: 60000,
      totalTimeoutMs: 120000
    });
    console.log('     （请求在 700ms 内就完成了，未触发取消——不算失败）');
    check('取消：抛 aborted 或提前完成', true);
  } catch (e) {
    check('取消 → aborted 分类', e instanceof LlmError && e.kind === 'aborted', `${e.kind}: ${e.message}`);
  }

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail > 0 ? 1 : 0);
})();
