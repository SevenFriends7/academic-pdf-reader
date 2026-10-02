import * as fs from 'fs';
import {
  generate,
  listAvailableModels,
  LlmError,
  classifyHttpError,
  buildModelChain,
  filterUsableModel,
  DEFAULT_TRANSLATION_MODEL,
  DEFAULT_ASSISTANT_MODEL
} from '../../src/llmClient';

const T_MODEL = DEFAULT_TRANSLATION_MODEL;
const A_MODEL = DEFAULT_ASSISTANT_MODEL;

const KEY = fs.readFileSync('D:/kx/上海交大/.gemini-key', 'utf8').trim();

function log(...a: any[]) {
  console.log(...a);
}

const PARAGRAPH = [
  'We propose a transformer-based architecture for long-horizon video object segmentation.',
  'Unlike prior work that relies on single-frame matching, our model maintains a compact memory bank, as shown in Fig. 2.',
  'This design significantly reduces drift caused by occlusions and appearance changes (e.g., rotation or lighting shifts).',
  'Experiments on three benchmarks show a 4.2% improvement in J&F score over the strongest baseline, with runtime of 0.16 s/frame.',
  'Ablation studies further confirm that both memory compression and temporal attention are necessary.'
];

const SCHEMA = {
  type: 'object',
  properties: {
    translation: { type: 'string' },
    sentences: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5 }
  },
  required: ['translation', 'sentences'],
  propertyOrdering: ['translation', 'sentences']
};

async function t1_models() {
  log('\n===== T1 ListModels =====');
  try {
    const models = await listAvailableModels(KEY, true);
    log('OK count =', models.length);
    log('has gemini-3.6-flash:', models.includes('gemini-3.6-flash'));
    log('sample:', models.filter(m => /flash|pro/.test(m)).slice(0, 10).join(', '));
  } catch (e: any) {
    log('FAIL', e.message, e.kind);
  }
}

async function t2_translateJson() {
  log('\n===== T2 逐句 JSON 结构化翻译 (gemini-3.6-flash) =====');
  let deltaCount = 0;
  const t0 = Date.now();
  try {
    const r = await generate(
      KEY,
      {
        model: T_MODEL,
        systemInstruction: '你是学术翻译专家。只输出严格 JSON。',
        turns: [
          {
            role: 'user',
            text: `请把下面这段英文学术论文内容翻译为简体中文。

【英文原句，共 ${PARAGRAPH.length} 句】
${PARAGRAPH.map((s, i) => `[${i + 1}] ${s}`).join('\n')}

【输出要求】
1. "translation"：整段连贯的中文学术译文。
2. "sentences"：逐句译文数组，长度必须恰好为 ${PARAGRAPH.length}，第 i 项对应第 i 句。
3. 公式、符号、缩写、引用编号原样保留。
只输出 JSON。`
          }
        ],
        temperature: 0.2,
        maxOutputTokens: 8192,
        jsonSchema: SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
        idleTimeoutMs: 60000,
        totalTimeoutMs: 180000,
        onDelta: () => {
          deltaCount++;
        }
      },
      m => log('  [llm]', m)
    );
    log('model =', r.model, '| fellBackFrom =', JSON.stringify(r.fellBackFrom || null));
    log('ttft =', r.ttftMs, 'ms | total =', r.totalMs, 'ms | delta chunks =', deltaCount);
    log('usage =', JSON.stringify(r.usage));
    log('finishReason =', r.finishReason);
    log('--- 原始返回 ---');
    log(r.text.slice(0, 1200));
    let parsed: any = null;
    try {
      parsed = JSON.parse(r.text.replace(/```json|```/g, '').trim());
    } catch (e: any) {
      log('!! JSON.parse 失败:', e.message);
    }
    if (parsed) {
      log('--- 解析结果 ---');
      log('translation 长度 =', (parsed.translation || '').length);
      log('sentences 数量 =', Array.isArray(parsed.sentences) ? parsed.sentences.length : 'NOT ARRAY');
      if (Array.isArray(parsed.sentences)) {
        parsed.sentences.forEach((s: string, i: number) => log(`  [${i + 1}] ${s}`));
      }
      log(
        '>>> 关键校验: sentences 数量 === 5 ?',
        Array.isArray(parsed.sentences) && parsed.sentences.length === 5 ? 'PASS' : 'FAIL'
      );
    }
  } catch (e: any) {
    log('FAIL', e instanceof LlmError ? `${e.kind} / ${e.apiMessage}` : e.message);
    log('  toUserMessage:', e instanceof LlmError ? e.toUserMessage() : '');
    log('  rawBody:', e.rawBody ? e.rawBody.slice(0, 400) : '(none)');
  }
}

async function t3_streamQA() {
  log('\n===== T3 流式学术问答（含思考内容过滤） =====');
  let chunks = 0;
  let chars = 0;
  const t0 = Date.now();
  let firstChunkAt = 0;
  try {
    const r = await generate(
      KEY,
      {
        model: T_MODEL,
        systemInstruction:
          '你是严谨的学术论文研究助手。只依据提供的原文作答，上下文没有的信息必须说明"当前上下文未提供"，绝不编造。输出 Markdown。',
        turns: [
          {
            role: 'user',
            text: `【读者聚焦的原文】\n${PARAGRAPH[1]}\n\n【该句所在段落全文】\n${PARAGRAPH.join(
              ' '
            )}\n\n【读者的疑问】\n作者为什么用 memory bank 而不是单帧匹配？这样做解决了什么问题？`
          }
        ],
        temperature: 0.4,
        maxOutputTokens: 16384,
        idleTimeoutMs: 90000,
        totalTimeoutMs: 420000,
        onDelta: c => {
          chunks++;
          chars += c.length;
          if (!firstChunkAt) firstChunkAt = Date.now() - t0;
        }
      },
      m => log('  [llm]', m)
    );
    log('model =', r.model);
    log('首块到达 =', firstChunkAt, 'ms | 总耗时 =', r.totalMs, 'ms | chunk 数 =', chunks, '| 总字符 =', r.text.length);
    log('usage =', JSON.stringify(r.usage));
    log('finishReason =', r.finishReason);
    log('--- 回答全文 ---');
    log(r.text);
    const looksLikeThought = /^(Here's a thinking process|Let me think|思考过程|分析：)/i.test(r.text.trim());
    log('>>> 关键校验: 正文未混入思考过程 ?', looksLikeThought ? 'FAIL' : 'PASS');
  } catch (e: any) {
    log('FAIL', e instanceof LlmError ? `${e.kind} / ${e.apiMessage}` : e.message);
  }
}

async function t4_errors() {
  log('\n===== T4 错误分类 =====');

  // 4a 已下线模型是否被过滤
  log('filterUsableModel("gemini-1.5-flash") =', filterUsableModel('gemini-1.5-flash') || '(已过滤)');
  log('filterUsableModel("gemini-2.0-flash") =', filterUsableModel('gemini-2.0-flash') || '(已过滤)');
  log('filterUsableModel("gemini-2.5-flash") =', filterUsableModel('gemini-2.5-flash'));
  log('buildModelChain("gemini-1.5-flash") =', buildModelChain('gemini-1.5-flash').slice(0, 4).join(' > '));

  // 4b 无效 key
  try {
    await generate('AQ.invalid-key-for-test', {
      model: T_MODEL,
      turns: [{ role: 'user', text: 'hi' }],
      totalTimeoutMs: 20000
    });
    log('4b 无效 key: 竟然成功了？（不应发生）');
  } catch (e: any) {
    log('4b 无效 key →', e instanceof LlmError ? e.kind : 'unknown');
    log('   message:', e instanceof LlmError ? e.toUserMessage() : e.message);
  }

  // 4c 不存在的模型（走回退链）
  try {
    const r = await generate(KEY, {
      model: 'gemini-does-not-exist-xyz',
      turns: [{ role: 'user', text: '回复两个字：收到' }],
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
      totalTimeoutMs: 120000
    });
    log('4c 不存在模型 → 回退到', r.model, '| fellBackFrom =', JSON.stringify(r.fellBackFrom));
    log('   回答:', r.text.slice(0, 60).replace(/\n/g, ' '));
  } catch (e: any) {
    log('4c FAIL →', e instanceof LlmError ? `${e.kind} / ${e.apiMessage}` : e.message);
  }

  // 4d thinkingBudget: 0 是否被接受
  try {
    const r = await generate(KEY, {
      model: T_MODEL,
      turns: [{ role: 'user', text: '把 "occlusion" 翻译成中文，只输出译文。' }],
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 2048,
      idleTimeoutMs: 30000,
      totalTimeoutMs: 90000
    });
    log('4d thinkingBudget:0 → 成功', r.totalMs, 'ms | usage:', JSON.stringify(r.usage));
  } catch (e: any) {
    log('4d thinkingBudget:0 → 失败', e instanceof LlmError ? `${e.kind} / ${e.apiMessage}` : e.message);
  }

  // 4e 状态码分类（离线校验）
  log('4e classifyHttpError(404):', classifyHttpError(404, '{"error":{"code":404,"message":"models/x is not found","status":"NOT_FOUND"}}', 'x').kind);
  log('4e classifyHttpError(429 quota):', classifyHttpError(429, '{"error":{"code":429,"message":"Quota exceeded for free_tier","status":"RESOURCE_EXHAUSTED"}}', 'x').kind);
  log('4e classifyHttpError(400):', classifyHttpError(400, '{"error":{"code":400,"message":"Invalid JSON payload","status":"INVALID_ARGUMENT"}}', 'x').kind);
  log('4e classifyHttpError(500):', classifyHttpError(500, 'oops', 'x').kind);
}

async function t5_multiturn() {
  log('\n===== T5 多轮追问（历史是否生效） =====');
  try {
    const r1 = await generate(KEY, {
      model: T_MODEL,
      systemInstruction: '你是学术助手，回答简短。',
      turns: [{ role: 'user', text: '我在读一篇关于视频目标分割的论文，它用了 memory bank。我们把这个话题记作话题A。' }],
      maxOutputTokens: 4096,
      totalTimeoutMs: 120000
    });
    log('第1轮回答:', r1.text.slice(0, 120).replace(/\n/g, ' '));

    const r2 = await generate(KEY, {
      model: T_MODEL,
      systemInstruction: '你是学术助手，回答简短。',
      turns: [
        { role: 'user', text: '我在读一篇关于视频目标分割的论文，它用了 memory bank。我们把这个话题记作话题A。' },
        { role: 'model', text: r1.text },
        { role: 'user', text: '我们刚才那个话题叫什么？只回答代号。' }
      ],
      maxOutputTokens: 4096,
      totalTimeoutMs: 120000
    });
    log('第2轮回答:', r2.text.slice(0, 200).replace(/\n/g, ' '));
    log('>>> 多轮上下文生效 ?', /A/.test(r2.text) ? 'PASS' : 'FAIL（模型未记住历史）');
  } catch (e: any) {
    log('FAIL', e instanceof LlmError ? `${e.kind} / ${e.apiMessage}` : e.message);
  }
}

async function main() {
  const only = process.argv[2] || 'all';
  if (only === 'all' || only === '1') await t1_models();
  if (only === 'all' || only === '2') await t2_translateJson();
  if (only === 'all' || only === '3') await t3_streamQA();
  if (only === 'all' || only === '4') await t4_errors();
  if (only === 'all' || only === '5') await t5_multiturn();
  log('\n===== 全部测试结束 =====');
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
