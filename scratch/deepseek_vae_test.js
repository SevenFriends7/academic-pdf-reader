/** 一次性诊断：把 VAE 第 4 页重参数化段的“送翻译文本”真实发给 DeepSeek，看占位符是否被保留。 */
'use strict';
const fs = require('fs');
const path = require('path');

const settings = JSON.parse(fs.readFileSync(process.env.APPDATA + '\\Code\\User\\settings.json', 'utf8'));
const KEY = settings['academicReader.apiKey'];
const ENDPOINT = (settings['academicReader.apiEndpoint'] || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = settings['academicReader.modelName'] || 'deepseek-chat';
if (!KEY) throw new Error('no key');

const SENTENCES = [
  'This reparameterization is useful for our case since it can be used to rewrite an expectation w.r.t ⟦q φ (z | x)⟧ such that the Monte Carlo estimate of the expectation is differentiable w.r.t. ⟦φ ∏⟧.',
  'A proof is as follows.',
  '⟦∏⟧ Given the deterministic mapping ⟦∫⟧ ⟦∫⟧ ⟦z = g φ (ε, x)⟧ we know that ⟦∫⟧ ⟦q φ (z | x)⟧ i ⟦dzi⟧ = ⟦p (ε)⟧ ⟦i dε i⟧.',
  'Therefore, ⟦q φ (z | x) f (z) dz =⟧ ⟦p (ε) f (z) d ε =⟧ ⟦p (ε) f (g φ (ε, x)) d ε⟧.',
  'It follows'
];
const N = SENTENCES.length;
const prompt = `请把下面这段英文学术论文内容翻译为简体中文。

【英文原句，共 ${N} 句】
${SENTENCES.map((x, i) => `[${i + 1}] ${x}`).join('\n')}

【输出要求】
1. "translation"：整段连贯、地道、严谨的中文学术译文。
2. "sentences"：逐句译文数组，长度**必须恰好为 ${N}**，第 i 项只对应第 i 句，不得合并或拆分。
3. 所有 ⟦...⟧ 包裹的内容是公式占位符，必须**逐字原样保留**，不得翻译、改写、增删括号。
4. 只输出 JSON 对象，形如 {"translation":"…","sentences":["…","…"]}，不要任何解释。`;

(async () => {
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一名专业的学术论文翻译专家，只输出严格合法的 JSON 对象。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  });
  const text = await res.text();
  console.log('HTTP', res.status);
  if (!res.ok) { console.log(text.slice(0, 800)); return; }
  const j = JSON.parse(text);
  const c = j.choices[0].message.content;
  console.log('usage', JSON.stringify(j.usage));
  console.log('content:', c);
  const p = JSON.parse(c);
  console.log('\n--- sentences ---');
  p.sentences.forEach((s, i) => console.log(`[${i + 1}] ${s}`));
})().catch(e => { console.error(e); process.exit(1); });
