/**
 * 视觉探针：让支持图片的模型看真实页面，并对"本地代码分割结果"给出修正。
 *
 * 用法：node scratch/vision/probe.js [模型名]
 * 默认 deepseek-flash（DeepSeek 官方文档称其支持图片输入）。
 *
 * 说明：
 *  · 只做两件事——①纯看版面描述结构；②拿本地的分段结果请它纠正顺序/类型/合并拆分。
 *  · 绝不打印 API Key。
 *  · 结果原样存到 scratch/vision/probe_raw.json，便于人工核对。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MODEL = process.argv[2] || 'deepseek-flash';
const IMAGE = path.join(__dirname, 'p4_full.png');

// ---- 读配置（不打印 key） ----
const settingsPath = path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const apiKey = settings['academicReader.apiKey'];
const endpoint = (settings['academicReader.apiEndpoint'] || 'https://api.deepseek.com/v1').replace(/\/$/, '');
if (!apiKey) {
  console.error('设置里没有 academicReader.apiKey');
  process.exit(2);
}
console.log(`引擎端点：${endpoint}　模型：${MODEL}　Key：已读取（${String(apiKey).length} 字符，不打印）`);

// ---- 本地分段结果（第 4 页）作为对照 ----
const storeDir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
const newest = fs
  .readdirSync(storeDir)
  .filter(f => f.startsWith('paper_') && f.endsWith('.json'))
  .map(f => ({ f, t: fs.statSync(path.join(storeDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0].f;
const paper = JSON.parse(fs.readFileSync(path.join(storeDir, newest), 'utf8'));
const localParas = (paper.pageArchive || {})['4'] || [];
console.log(`本地分段（第 4 页）：${localParas.length} 段\n`);
localParas.forEach((p, i) => {
  console.log(`  [${i}] ${String(p.type).padEnd(10)} ${String(p.cleanText || '').replace(/\s+/g, ' ').slice(0, 62)}`);
});

const numbered = localParas
  .map((p, i) => `[${i}] (${p.type}) ${String(p.cleanText || '').replace(/\s+/g, ' ').trim()}`)
  .join('\n');

const b64 = fs.readFileSync(IMAGE).toString('base64');
const imageUrl = `data:image/png;base64,${b64}`;

const SYS =
  '你是学术论文版面分析器。只输出 JSON，不要任何解释、不要 markdown 代码块。' +
  '不要翻译任何内容，不要改写原文（公式符号原样保留）。';

const Q1 = `这是一篇论文第 4 页的图像。请判断版面结构并只输出 JSON：
{
  "columns": 1,
  "blocks": [
    {"order": 1, "type": "figure|table|caption|body|heading|formula|formula_inline|header|footer|reference|page_number",
     "column": null, "textStart": "该块开头 24 个字符（图/表内部文字写 (figure) ）", "note": "可选"}
  ],
  "notes": "这段页面最容易被程序搞错的地方是什么"
}
要求：blocks 按**人类阅读顺序**排列；图与表的内部文字（坐标轴、图例、子图编号）单独标成 figure/table，不要混进 caption。`;

const Q2 = `这是一篇论文第 4 页的图像。下面还有"另一个程序给出的分段结果"（顺序与类型可能都不对）。

请结合图像判断，并只输出 JSON：
{
  "columns": 1,
  "segments": [
    {"index": 0, "type": "figure|table|caption|body|heading|formula|formula_inline|header|footer|reference|page_number|noise",
     "readingOrder": 1, "action": "keep|merge_with_next|split|drop", "note": "为什么"}
  ],
  "corrections": "你改动的地方，逐条说清（例如：[7] 其实与 [6] 是同一段公式，应合并）"
}
规则：
- 对每个 index 都给出一项；index 必须与下面列表完全对应，不要新增或漏掉。
- type 用你判断的真实类型（下面给的类型是那个程序的判断，可能错）。
- 图/表内部文字标成 figure/table；纯公式行标成 formula；公式与句子混排标成 formula_inline。
- 页眉页脚页码标成 header/footer/page_number，并给 action "drop"。

另一个程序的分段结果：
${numbered}`;

async function ask(label, prompt, maxTokens = 2600) {
  const t0 = Date.now();
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYS },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ],
    temperature: 0,
    max_tokens: maxTokens,
    stream: false
  };
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.log(`\n===== ${label}：❌ HTTP ${res.status}（${ms} ms）`);
    console.log(text.slice(0, 800));
    return { label, ok: false, status: res.status, raw: text, ms };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保持 raw */
  }
  const answer = json?.choices?.[0]?.message?.content || '';
  console.log(`\n===== ${label}：✅ ${ms} ms ｜ 用量 ${JSON.stringify(json?.usage || {})}`);
  console.log(answer);
  return { label, ok: true, ms, usage: json?.usage, answer, raw: text };
}

(async () => {
  const results = [];
  results.push(await ask('Q1 纯看版面（不给它本地结果）', Q1));
  results.push(await ask('Q2 图 + 本地分段（请它纠正）', Q2));
  fs.writeFileSync(path.join(__dirname, 'probe_raw.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('\n原始响应已存：scratch/vision/probe_raw.json');
})();
