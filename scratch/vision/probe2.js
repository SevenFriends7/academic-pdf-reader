/**
 * 视觉探针 · 第二轮：给足输出预算 + 生产形态（JSON 模式、精简 note），量真实成本与延迟。
 * 用法：node scratch/vision/probe2.js [模型名]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MODEL = process.argv[2] || 'deepseek-flash';
const IMAGE = path.join(__dirname, 'p4_full.png');

const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Code', 'User', 'settings.json'), 'utf8'));
const apiKey = settings['academicReader.apiKey'];
const endpoint = (settings['academicReader.apiEndpoint'] || 'https://api.deepseek.com/v1').replace(/\/$/, '');

const storeDir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
const newest = fs
  .readdirSync(storeDir)
  .filter(f => f.startsWith('paper_') && f.endsWith('.json'))
  .map(f => ({ f, t: fs.statSync(path.join(storeDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0].f;
const paper = JSON.parse(fs.readFileSync(path.join(storeDir, newest), 'utf8'));
const localParas = (paper.pageArchive || {})['4'] || [];
const numbered = localParas.map((p, i) => `[${i}] (${p.type}) ${String(p.cleanText || '').replace(/\s+/g, ' ').trim()}`).join('\n');
const imageUrl = `data:image/png;base64,${fs.readFileSync(IMAGE).toString('base64')}`;

const SYS =
  '你是学术论文版面分析器。只输出 JSON，不要解释、不要 markdown 代码块、不要复述原文。' +
  '不翻译、不改写原文，公式符号原样保留。';

const Q1 = `这是一篇论文第 4 页图像。只输出 JSON：
{"columns":1,"blocks":[{"order":1,"type":"figure|table|caption|body|heading|formula|formula_inline|header|footer|page_number","column":null,"textStart":"该块开头 20 字符，图/表内部文字写 (figure)","note":""}],"notes":"程序最容易搞错的地方（30 字内）"}
blocks 按人类阅读顺序；图/表内部文字单列，不要混进 caption。`;

const Q3 = `这是论文第 4 页图像，下面是某程序的分段结果（顺序/类型可能有错）。只输出 JSON：
{"columns":1,"segments":[{"i":0,"type":"figure|table|caption|body|heading|formula|formula_inline|header|footer|page_number|noise","order":1,"action":"keep|merge_next|split|drop","why":"15 字内"}],"fixes":"一句话总结你改了什么"}
规则：每个 i 都要有；type 按你判断的真实类型；纯公式行 formula，公式与句子混排 formula_inline；页眉页脚页码 header/footer/page_number 且 drop。

分段结果：
${numbered}`;

async function ask(label, prompt, { maxTokens = 6000, jsonMode = false } = {}) {
  const t0 = Date.now();
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }
    ],
    temperature: 0,
    max_tokens: maxTokens,
    stream: false
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.log(`\n===== ${label}：❌ HTTP ${res.status}（${ms} ms）\n${text.slice(0, 600)}`);
    return { label, ok: false, ms, raw: text };
  }
  const json = JSON.parse(text);
  const answer = json.choices?.[0]?.message?.content || '';
  const u = json.usage || {};
  console.log(
    `\n===== ${label}：✅ ${ms} ms ｜ 输入 ${u.prompt_tokens}（其中 reasoning ${u.completion_tokens_details?.reasoning_tokens ?? 0}）/ 输出 ${u.completion_tokens} / 合计 ${u.total_tokens}`
  );
  console.log(`finish_reason=${json.choices?.[0]?.finish_reason}`);
  console.log(answer ? answer.slice(0, 2200) : '(空回答)');
  return { label, ok: true, ms, usage: u, finish: json.choices?.[0]?.finish_reason, answer, raw: text };
}

(async () => {
  const out = [];
  out.push(await ask('Q1 纯看版面（预算 6000）', Q1));
  out.push(await ask('Q3 生产形态（JSON 模式 + 精简 note）', Q3, { maxTokens: 4000, jsonMode: true }));
  fs.writeFileSync(path.join(__dirname, 'probe2_raw.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('\n原始响应已存：scratch/vision/probe2_raw.json');
})();
