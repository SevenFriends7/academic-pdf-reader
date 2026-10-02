/**
 * 用真实 DeepSeek Key 复现插件里的 OpenAI 兼容翻译路径，定位问题。
 * 用法：node scratch/deepseek_diag.js
 */
const fs = require('fs');

const settingsPath = process.env.APPDATA + '\\Antigravity IDE\\User\\settings.json';
const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const KEY = s['academicReader.apiKey'];
const ENDPOINT = (s['academicReader.apiEndpoint'] || '').replace(/\/+$/, '');
const MODEL = s['academicReader.modelName'] || 'deepseek-chat';

console.log('endpoint =', ENDPOINT);
console.log('model    =', MODEL);
console.log('key      =', KEY ? KEY.slice(0, 6) + '…' + KEY.slice(-4) + ` (len ${KEY.length})` : '(空)');
console.log('');

const SENTENCES = [
  'We propose a transformer-based architecture for long-horizon video object segmentation.',
  'Unlike prior work that relies on single-frame matching, our model maintains a compact memory bank, as shown in Fig. 2.',
  'This design significantly reduces drift caused by occlusions and appearance changes (e.g., rotation or lighting shifts).',
  'Experiments on three benchmarks show a 4.2% improvement in J&F score over the strongest baseline, with runtime of 0.16 s/frame.',
  'Ablation studies further confirm that both memory compression and temporal attention are necessary.'
];
const PARAGRAPH = SENTENCES.join(' ');

async function post(body, label, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    console.log(`--- ${label} ---`);
    console.log(`HTTP ${res.status}  耗时 ${Date.now() - started}ms`);
    if (!res.ok) {
      console.log('错误体:', text.slice(0, 600));
      return null;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.log('返回不是 JSON:', text.slice(0, 300));
      return null;
    }
    const choice = json.choices && json.choices[0];
    console.log('finish_reason =', choice && choice.finish_reason);
    console.log('usage =', JSON.stringify(json.usage));
    const content = choice && choice.message && choice.message.content;
    console.log('content 长度 =', content ? content.length : '(空)');
    return content;
  } catch (e) {
    console.log(`--- ${label} ---`);
    console.log('异常:', e.name, e.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  // ===== 0. 最基本的连通性与鉴权 =====
  const hello = await post(
    { model: MODEL, messages: [{ role: 'user', content: '回复两个字：收到' }], stream: false },
    'T0 基本连通性'
  );
  console.log('T0 回答:', hello);
  console.log('');

  // ===== 1. 复刻插件里的逐句 JSON 路径（带 response_format + 默认 max_tokens）=====
  const N = SENTENCES.length;
  const prompt = `请把下面这段英文学术论文内容翻译为简体中文。

【英文原句，共 ${N} 句】
${SENTENCES.map((x, i) => `[${i + 1}] ${x}`).join('\n')}

【输出要求】
1. "translation"：整段连贯、地道、严谨的中文学术译文。
2. "sentences"：逐句译文数组，长度**必须恰好为 ${N}**，第 i 项只对应第 i 句，不得合并或拆分。
3. 公式、数学符号、变量名、缩写、文献引用编号原样保留。
4. 只输出 JSON 对象，形如 {"translation":"…","sentences":["…","…"]}，不要任何解释。`;

  const c1 = await post(
    {
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一名专业的学术论文翻译专家，只输出严格合法的 JSON 对象。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      stream: false,
      response_format: { type: 'json_object' }
      // 注意：这里**故意不传 max_tokens**，复刻插件当前的行为
    },
    'T1 逐句 JSON（无 max_tokens，默认 4096）'
  );
  if (c1) {
    console.log('content 前 700 字:');
    console.log(c1.slice(0, 700));
    try {
      const parsed = JSON.parse(c1);
      console.log('');
      console.log('JSON 解析: OK');
      console.log('sentences 数量 =', Array.isArray(parsed.sentences) ? parsed.sentences.length : 'NOT ARRAY', `(应为 ${N})`);
    } catch (e) {
      console.log('');
      console.log('!! JSON 解析失败:', e.message);
    }
  }
  console.log('');

  // ===== 2. 加上 max_tokens: 8192 =====
  const c2 = await post(
    {
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一名专业的学术论文翻译专家，只输出严格合法的 JSON 对象。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      stream: false,
      max_tokens: 8192,
      response_format: { type: 'json_object' }
    },
    'T2 逐句 JSON（max_tokens: 8192）'
  );
  if (c2) {
    try {
      const parsed = JSON.parse(c2);
      console.log('sentences 数量 =', Array.isArray(parsed.sentences) ? parsed.sentences.length : 'NOT ARRAY', `(应为 ${N})`);
      console.log('translation 前 120 字:', (parsed.translation || '').slice(0, 120));
    } catch (e) {
      console.log('!! JSON 解析失败:', e.message, '| 尾部:', c2.slice(-120));
    }
  }
  console.log('');

  // ===== 3. 长段落：模拟真实论文段落（10 句、更长），看是否被截断 =====
  const longSents = [];
  for (let i = 0; i < 12; i++) {
    longSents.push(
      `In the ${i + 1}th experiment, we evaluate the proposed memory compression module on the DAVIS benchmark and observe that the temporal attention mechanism consistently improves the region similarity while reducing the contour accuracy degradation caused by long-term occlusion.`
    );
  }
  const longPrompt = `请把下面这段英文学术论文内容翻译为简体中文。

【英文原句，共 ${longSents.length} 句】
${longSents.map((x, i) => `[${i + 1}] ${x}`).join('\n')}

【输出要求】
1. "translation"：整段连贯中文学术译文。
2. "sentences"：逐句译文数组，长度**必须恰好为 ${longSents.length}**。
3. 只输出 JSON 对象。`;

  const c3 = await post(
    {
      model: MODEL,
      messages: [
        { role: 'system', content: '你是学术翻译专家，只输出严格合法的 JSON。' },
        { role: 'user', content: longPrompt }
      ],
      temperature: 0.2,
      stream: false,
      response_format: { type: 'json_object' }
    },
    'T3 长段落 JSON（无 max_tokens）'
  );
  if (c3) {
    try {
      const parsed = JSON.parse(c3);
      console.log('sentences 数量 =', Array.isArray(parsed.sentences) ? parsed.sentences.length : 'NOT ARRAY', `(应为 ${longSents.length})`);
    } catch (e) {
      console.log('!! JSON 解析失败（极可能被截断）:', e.message);
      console.log('   尾部 200 字:', c3.slice(-200));
    }
  }
}

main().catch(e => console.error('FATAL', e));
