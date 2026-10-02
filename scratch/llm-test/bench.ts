import * as fs from 'fs';
import { callGeminiStream, listAvailableModels, LlmError } from '../../src/llmClient';

const KEY = fs.readFileSync('D:/kx/上海交大/.gemini-key', 'utf8').trim();

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

const PROMPT = `请把下面这段英文学术论文内容翻译为简体中文。

【英文原句，共 ${PARAGRAPH.length} 句】
${PARAGRAPH.map((s, i) => `[${i + 1}] ${s}`).join('\n')}

【输出要求】
1. "translation"：整段连贯的中文学术译文。
2. "sentences"：逐句译文数组，长度必须恰好为 ${PARAGRAPH.length}，第 i 项对应第 i 句。
3. 公式、符号、缩写、引用编号原样保留。
只输出 JSON。`;

interface Row {
  model: string;
  thinking: string;
  status: string;
  ttft?: number;
  total?: number;
  thoughts?: number;
  outTok?: number;
  sentCount?: number | string;
  quality?: string;
}

const rows: Row[] = [];

async function benchTranslation(model: string, thinkingBudget: number | undefined) {
  const label = thinkingBudget === undefined ? '默认思考' : `budget=${thinkingBudget}`;
  const row: Row = { model, thinking: label, status: '?' };
  try {
    const r = await callGeminiStream(KEY, model, {
      model,
      systemInstruction: '你是学术翻译专家。只输出严格 JSON。',
      turns: [{ role: 'user', text: PROMPT }],
      temperature: 0.2,
      maxOutputTokens: 8192,
      jsonSchema: SCHEMA,
      thinkingConfig: thinkingBudget === undefined ? undefined : { thinkingBudget },
      idleTimeoutMs: 90000,
      totalTimeoutMs: 240000
    });
    row.status = 'OK';
    row.ttft = r.ttftMs;
    const total = Date.now();
    row.thoughts = r.usage?.thoughtsTokenCount || 0;
    row.outTok = r.usage?.candidatesTokenCount || 0;
    let parsed: any = null;
    try {
      parsed = JSON.parse(r.text.replace(/```json|```/g, '').trim());
    } catch {
      parsed = null;
    }
    row.sentCount = parsed && Array.isArray(parsed.sentences) ? parsed.sentences.length : 'PARSE_FAIL';
    row.quality = parsed && parsed.translation ? parsed.translation.slice(0, 60) + '…' : '(无)';
  } catch (e: any) {
    if (e instanceof LlmError) {
      row.status = `${e.kind}${e.status ? ' HTTP' + e.status : ''}`;
      row.quality = (e.apiMessage || '').slice(0, 110);
    } else {
      row.status = 'ERR';
      row.quality = String(e.message).slice(0, 110);
    }
  }
  rows.push(row);
  console.log(
    `${model.padEnd(24)} ${label.padEnd(12)} ${String(row.status).padEnd(14)} ttft=${String(
      row.ttft
    ).padStart(6)} thoughts=${String(row.thoughts).padStart(5)} out=${String(row.outTok).padStart(4)} sentences=${String(
      row.sentCount
    ).padStart(10)}  ${row.quality}`
  );
}

async function main() {
  const models = ['gemini-3.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];
  const budgets: (number | undefined)[] = [0, 128, undefined];
  console.log('模型'.padEnd(24) + '思考'.padEnd(14) + '状态'.padEnd(14) + '指标');
  console.log('-'.repeat(150));
  for (const m of models) {
    for (const b of budgets) {
      await benchTranslation(m, b);
    }
  }
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
