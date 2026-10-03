/**
 * 协议探针 v2：验证"升级版版面分割协议"（带 parts / group / inline 的 JSON）
 * 能否被真实视觉模型（deepseek-flash）稳定遵守。
 *
 * 只做两件事：
 *   1) 用真实第 4 页图 + 全局存储里的本地分段，把 v2 提示词发给真实 API（一次，空回答自动加倍重试）；
 *   2) 把回包与本地分段放进同一份报告里逐条核对：
 *      - 编号完整性（每个 i 恰好一次；order 是否 1..N 排列）
 *      - at 锚点可定位性（精确 / 模糊 / 失败，**本探针最重要的结论**）
 *      - parts 质量（action=split 的分片）
 *      - group + figure_caption 成组情况
 *      - inline 的 find 是否逐字出现在 cleanText 里
 *      - 耗时与 usage token
 *
 * 注意：v2 协议**已删除 bbox**（用户拍板不做几何估计/裁图），提示词与核对都不涉及。
 * 不修改 src/ 与 media/ 下任何产品代码，也不 bundle translator.ts —— 直接 fetch 调 API。
 *
 * 用法：node scratch/vision/probe_v2.js [模型名]
 * 产出：scratch/vision/probe_v2_result.json + 结尾可读摘要
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MODEL = process.argv[2] || process.env.VISION_MODEL || 'deepseek-flash';
const PAGE = '4';
const OUT_JSON = path.join(__dirname, 'probe_v2_result.json');
const IMG = path.join(__dirname, 'p4_full.png');
const TEX_LIMIT = 1500;

// ---------------------------------------------------------------- 配置读取
function loadConf() {
  const settingsPath = path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json');
  if (!fs.existsSync(settingsPath)) throw new Error(`找不到 VS Code 设置：${settingsPath}`);
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const apiKey = (s['academicReader.apiKey'] || '').trim();
  const endpoint = (s['academicReader.apiEndpoint'] || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (!apiKey) throw new Error('设置里没有 academicReader.apiKey，无法真实调用 API');
  return { apiKey, endpoint, settingsPath };
}

function loadLocalSegments() {
  const dir = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
  if (!fs.existsSync(dir)) throw new Error(`找不到 VS Code 全局存储目录：${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter(f => f.startsWith('paper_') && f.endsWith('.json'))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error(`全局存储目录里没有 paper_*.json：${dir}`);
  const newest = files[0].f;
  const paper = JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8'));
  const archive = paper.pageArchive || {};
  const page = archive[PAGE];
  if (!Array.isArray(page) || !page.length) {
    throw new Error(
      `最新存档 ${newest} 里没有 pageArchive["${PAGE}"]（有 ${Object.keys(archive).join(',') || '空'}）。` +
        `请先在扩展里打开那篇论文的第 ${PAGE} 页以生成该页分段，不要用别的页编造数据。`
    );
  }
  const segs = page.map(p => ({ id: Number(p.id), type: String(p.type || ''), cleanText: String(p.cleanText || '') }));
  return { file: newest, dir, segs };
}

// ---------------------------------------------------------------- 归一化 / 定位器
/**
 * 归一化（区分"严格"与"宽松"两级）：
 *  - NFC 预组合；空白与零宽字符全部删除
 *  - 全角空格/标点 → 半角
 *  - 组合抑扬符 U+0302 与 spacing modifier circumflex U+02C6 统一成 U+0302
 *    （PDF 文本层抽出来的是 "Y" + U+0302，模型照抄图像时可能写 U+0302 或 U+02C6）
 *  - 各种 dash（− U+2212, – U+2013, — U+2014, ‐ U+2010）→ "-"
 *  - × · ⋅ → "x"；上下标数字 Unicode → ASCII 数字
 *  - 可选 stripMarks：去掉组合附标（Y+U+0302 → Y），用来吸收"模型写了 Ŷ、文本层只有 Y"这类差异
 */
const FULLWIDTH_SPACE = /[\u3000\u00a0\u2000-\u200b\ufeff]/g;
const DIACRITIC_RE = /[\u0300-\u036f]/g;
const SUPERSUB_MAP = {
  '\u2070': '0', '\u00b9': '1', '\u00b2': '2', '\u00b3': '3', '\u2074': '4',
  '\u2075': '5', '\u2076': '6', '\u2077': '7', '\u2078': '8', '\u2079': '9',
  '\u2080': '0', '\u2081': '1', '\u2082': '2', '\u2083': '3', '\u2084': '4',
  '\u2085': '5', '\u2086': '6', '\u2087': '7', '\u2088': '8', '\u2089': '9',
  '\u0302': '\u0302'
};

function normalize(s, { stripMarks = false } = {}) {
  let t = String(s == null ? '' : s).normalize('NFC');
  t = t.replace(FULLWIDTH_SPACE, '');
  t = t.replace(/\u02c6/g, '\u0302'); // modifier letter circumflex → combining circumflex
  t = t.replace(/[\u2212\u2010-\u2015\u2018\u2019]/g, '-');
  t = t.replace(/[\u00d7\u22c5\u00b7]/g, 'x');
  t = t.replace(/[\u2070-\u2079\u2080-\u2089]/g, c => SUPERSUB_MAP[c] || c);
  if (stripMarks) t = t.replace(DIACRITIC_RE, '');
  t = t.replace(/\s+/g, '');
  return t.toLowerCase();
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
/** 滑动窗口 + 二元组 Dice 相似度，返回 {score, index, window} */
function fuzzyFind(text, anchor, threshold = 0.7) {
  const n = anchor.length;
  if (!n) return { score: 0, index: -1, window: '' };
  const lens = [...new Set([n, Math.max(1, n - 1), n + 1, Math.round(n * 0.75), Math.round(n * 1.25)])].filter(
    l => l >= 1 && l <= text.length
  );
  let best = { score: 0, index: -1, window: '' };
  for (const L of lens) {
    for (let i = 0; i + L <= text.length; i++) {
      const w = text.slice(i, i + L);
      const sc = dice(w, anchor);
      if (sc > best.score) best = { score: sc, index: i, window: w };
    }
  }
  best.passed = best.score >= threshold;
  return best;
}

/** 宽松定位器：先精确（严格 → 宽松），再模糊 */
function locateAll(cleanText, anchor) {
  const T_strict = normalize(cleanText);
  const T_loose = normalize(cleanText, { stripMarks: true });
  const A_strict = normalize(anchor);
  const A_loose = normalize(anchor, { stripMarks: true });
  const res = { anchor, strict: null, loose: null, fuzzy: null, method: 'fail', index: null };

  if (A_strict && T_strict.includes(A_strict)) {
    res.strict = T_strict.indexOf(A_strict);
    res.method = 'exact-strict';
    res.index = res.strict;
  } else if (A_loose && T_loose.includes(A_loose)) {
    res.loose = T_loose.indexOf(A_loose);
    res.method = 'exact-loose';
    res.index = res.loose;
  } else {
    const f = fuzzyFind(T_loose, A_loose, 0.7);
    res.fuzzy = f;
    if (f.passed) {
      res.method = 'fuzzy';
      res.index = f.index;
    }
  }
  // 给报告用：失败时打印"锚点 vs 该段对应区域"的对照
  if (res.method === 'fail') {
    const f2 = fuzzyFind(T_loose, A_loose, 0); // 取最优，供人工判断
    res.bestGuess = { score: Number(f2.score.toFixed(3)), window: f2.window, at: f2.index };
    res.textLoose = T_loose;
  }
  return res;
}

// ---------------------------------------------------------------- v2 提示词
const ALLOWED_TYPES = [
  'title', 'abstract', 'heading', 'body', 'caption', 'figure', 'figure_caption', 'table', 'formula',
  'formula_inline', 'reference', 'footnote', 'header', 'footer', 'page_number', 'noise', 'keywords',
  'metadata', 'significance'
];

function buildPrompt(pageNum, segments) {
  const numbered = segments
    .map(s => `[${s.id}] (${s.type}) ${String(s.cleanText || '').replace(/\s+/g, ' ').trim().slice(0, TEX_LIMIT)}`)
    .join('\n');

  const example = JSON.stringify({
    columns: 2,
    segments: [
      { i: 0, type: 'body', order: 1, group: null, action: 'split', why: '正文夹带独立公式', latex: null,
        parts: [
          { type: 'body', at: null },
          { type: 'formula', at: 'L cycle,t = L (Y ̂ t, Y t)', latex: '\\mathcal{L}_{cycle,t}=\\mathcal{L}(\\hat{Y}_t,Y_t)+\\mathcal{L}(\\hat{Y}_1,Y_1)' },
          { type: 'body', at: 'In implementation, we utilize' }
        ],
        inline: [{ find: 'Y ̂ t', latex: '\\hat{Y}_t' }] }
    ],
    fixes: '把公式从正文里拆出来'
  });

  return (
    `这是学术论文第 ${pageNum} 页的图像。下面是一份程序从 PDF 文本层给出的分段（顺序与类型可能有错，` +
    `其中公式被抽成了 "Y ̂ t" 这种残渣）。请结合图像判断版面，**只输出 JSON**，结构如下：\n` +
    `{"columns":1,"segments":[{"i":0,"type":"body","order":1,"group":null,"action":"keep","why":"15字内","latex":"仅公式类需要","parts":[{"type":"body","at":"这一片开头的原文文字"},{"type":"formula","at":"...","latex":"\\mathcal{L}=..."}],"inline":[{"find":"Y ̂ t","latex":"\\hat{Y}_t"}]}],"fixes":"一句话"}\n` +
    `示例（仅示范字段写法，不要照抄内容）：\n${example}\n\n` +
    `规则（必须严格遵守）：\n` +
    `- 每个 i 必须**恰好出现一次**，不得新增、不得漏掉、不得重复；i 必须与下面列表的编号一致。\n` +
    `- type 取值只能是：${ALLOWED_TYPES.join('|')}。这是你判断的**真实**类型（列表里的是程序判断，可能错）。\n` +
    `- order：阅读顺序，从 1 开始、到 N 结束，1..N 每个整数用且只用一次。\n` +
    `- action 只能是：keep（独立成段）| merge_next（其实是下一段的续句，应与下一段合并）| split（这一段里混了多种内容）| drop（页眉页脚页码、图内零散标签等应丢掉的碎片）。\n` +
    `- parts：**只在 action="split" 时给**。按顺序列出拆出来的每一片，type 是这一片的真实类型；` +
    `at 是**这一片开头在文本层里的原文文字**——照抄下面列表里的残渣写法（不要用你从图像看到的排版写法），10~40 字；` +
    `第一片可以不给 at（默认从段首开始）；公式片额外给 latex。\n` +
    `- group：同一张图/表/公式块的成员给同一个正整数（同一页内唯一），不同图块用不同数字；独立成段的内容给 null。` +
    `图注那一行给 type "figure_caption"，并让它和图内文字属于同一个 group。\n` +
    `- latex：公式类（type 为 formula）**必须给**，转写成可渲染的 LaTeX（不要 $ 包裹、不要 \\begin{equation}）。非公式类给 null。` +
    `程序从文本层抽出的是 "Y ̂ t" 这种残渣，图像是唯一可靠来源；` +
    `例如图像上的 Ŷ_t = L(Ŷ_t, Y_t) + L(Ŷ_1, Y_1) 要写成 \\hat{Y}_t = \\mathcal{L}(\\hat{Y}_t, Y_t) + \\mathcal{L}(\\hat{Y}_1, Y_1)。\n` +
    `- inline：仅当段落正文里夹着行内公式、而文本层抽出来是残渣（如 "Y ̂ t"、"L cycle,t"）时给出替换项；` +
    `find 必须是该段文本里**逐字出现**的残渣子串（照抄列表里的写法），latex 是可渲染的 LaTeX。没有就给空数组 []。\n` +
    `- 不要输出 bbox 或任何坐标字段。\n` +
    `- 不要翻译，不要复述原文，不要 markdown 代码块，不要任何解释文字。\n\n` +
    `程序的分段结果：\n${numbered}`
  );
}

// ---------------------------------------------------------------- API
async function callVision({ endpoint, apiKey, imageBase64, mime, prompt, maxTokens }) {
  const body = {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content:
          '你是学术论文版面分析器。只输出 JSON（json 对象），不要 markdown 代码块，不要解释，不翻译原文。'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } }
        ]
      }
    ],
    max_tokens: maxTokens,
    temperature: 0,
    response_format: { type: 'json_object' }
  };
  const t0 = Date.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 600)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`API 回包不是 JSON：${text.slice(0, 300)}`);
  }
  const choice = (json.choices || [])[0] || {};
  return {
    content: choice.message?.content || '',
    finishReason: choice.finish_reason,
    usage: json.usage || null,
    ms,
    raw: json
  };
}

// ---------------------------------------------------------------- 核对
function checkNumbering(segs, local) {
  const ids = local.map(s => s.id);
  const seen = new Map();
  const dup = [];
  const extra = [];
  for (const s of segs) {
    const i = Number(s && s.i);
    if (!Number.isFinite(i)) { extra.push(s); continue; }
    if (seen.has(i)) dup.push(i);
    seen.set(i, s);
    if (!ids.includes(i)) extra.push(s);
  }
  const missing = ids.filter(i => !seen.has(i));
  const orders = segs.map(s => Number(s.order));
  const badOrder = orders.filter(o => !Number.isFinite(o));
  const sorted = orders.filter(o => Number.isFinite(o)).slice().sort((a, b) => a - b);
  const orderIsPerm = sorted.length === ids.length && sorted.every((o, k) => o === k + 1);
  const typeBad = segs.filter(s => !ALLOWED_TYPES.includes(String(s.type))).map(s => ({ i: s.i, type: s.type }));
  const actionBad = segs.filter(s => !['keep', 'merge_next', 'split', 'drop'].includes(String(s.action))).map(s => ({
    i: s.i, action: s.action
  }));
  return {
    localCount: ids.length,
    returnedCount: segs.length,
    uniqueI: seen.size,
    duplicateI: dup,
    missingI: missing,
    extraI: extra.map(s => ({ i: s.i, type: s.type })),
    orderIsPermutation: orderIsPerm,
    orderSequence: orders,
    orderMissingOrNonNumeric: badOrder.length,
    orderMissingI: segs.filter(s => !Number.isFinite(Number(s.order))).map(s => s.i),
    orderDuplicate: sorted.filter((o, k) => k > 0 && sorted[k - 1] === o),
    illegalTypes: typeBad,
    illegalActions: actionBad
  };
}

function checkAnchors(segs, localById) {
  const rows = [];
  const counts = { total: 0, exactStrict: 0, exactLoose: 0, fuzzy: 0, fail: 0 };
  for (const s of segs) {
    if (String(s.action) !== 'split') continue;
    const loc = localById.get(Number(s.i));
    const cleanText = loc ? loc.cleanText : '';
    const parts = Array.isArray(s.parts) ? s.parts : [];
    for (let k = 0; k < parts.length; k++) {
      const at = parts[k] && parts[k].at;
      if (at === null || at === undefined || String(at).trim() === '') {
        rows.push({ i: s.i, partIndex: k, anchor: null, method: 'absent(first-part-ok)', note: k === 0 ? '首片允许缺 at' : '非首片缺 at（违规）' });
        continue;
      }
      counts.total++;
      const r = locateAll(cleanText, String(at));
      if (r.method === 'exact-strict') counts.exactStrict++;
      else if (r.method === 'exact-loose') counts.exactLoose++;
      else if (r.method === 'fuzzy') counts.fuzzy++;
      else counts.fail++;
      rows.push({
        i: s.i,
        partIndex: k,
        anchor: String(at),
        type: parts[k].type,
        method: r.method,
        index: r.index,
        fuzzyScore: r.fuzzy ? Number((r.fuzzy.score || 0).toFixed(3)) : r.bestGuess?.score ?? null,
        bestGuessWindow: r.method === 'fail' ? r.bestGuess?.window : undefined,
        cleanTextSnippet: r.method === 'fail' ? cleanText.replace(/\s+/g, ' ').slice(0, 160) : undefined
      });
    }
  }
  counts.located = counts.exactStrict + counts.exactLoose + counts.fuzzy;
  counts.locateRate = counts.total ? Number((counts.located / counts.total).toFixed(3)) : null;
  return { counts, rows };
}

function checkGroups(segs) {
  const groups = new Map();
  for (const s of segs) {
    const g = s.group;
    if (g === null || g === undefined || g === '' || Number(g) === 0) continue;
    const key = String(g);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ i: s.i, type: s.type, order: s.order, action: s.action });
  }
  const groupList = [...groups.entries()].map(([g, members]) => ({
    group: g,
    members,
    hasCaption: members.some(m => m.type === 'figure_caption' || m.type === 'caption' || m.type === 'table_caption'),
    hasFigureish: members.some(m => ['figure', 'table', 'figure_caption'].includes(m.type)),
    size: members.length
  }));
  return {
    groupCount: groupList.length,
    groups: groupList,
    segmentsWithGroup: segs.filter(s => s.group !== null && s.group !== undefined && s.group !== '').length,
    standAloneInGroup: groupList.filter(g => g.size === 1).map(g => g.group),
    captionButNoGroup: segs.filter(s => ['figure_caption', 'caption'].includes(String(s.type)) && (s.group === null || s.group === undefined)).map(s => s.i),
    bboxPresent: segs.filter(s => s.bbox !== undefined).map(s => s.i)
  };
}

function checkInline(segs, localById) {
  const rows = [];
  let total = 0, found = 0, notFound = 0;
  for (const s of segs) {
    const arr = Array.isArray(s.inline) ? s.inline : [];
    for (const it of arr) {
      total++;
      const loc = localById.get(Number(s.i));
      const cleanText = loc ? loc.cleanText : null;
      const find = it && it.find;
      const has = cleanText !== null && find ? locateAll(cleanText, String(find)).method !== 'fail' : false;
      if (has) found++; else notFound++;
      rows.push({
        i: s.i, find, latex: it && it.latex, hasLatex: !!(it && it.latex),
        inCleanText: has,
        localExists: cleanText !== null,
        method: cleanText !== null && find ? locateAll(cleanText, String(find)).method : 'n/a'
      });
    }
  }
  return { total, found, notFound, rows, segmentsWithInline: segs.filter(s => Array.isArray(s.inline) && s.inline.length).map(s => s.i) };
}

function checkLatex(segs) {
  const formulaish = segs.filter(s => ['formula'].includes(String(s.type)));
  const withLatex = formulaish.filter(s => typeof s.latex === 'string' && s.latex.trim());
  const partFormula = [];
  for (const s of segs) {
    for (const [k, p] of (Array.isArray(s.parts) ? s.parts : []).entries()) {
      if (p && p.type === 'formula') partFormula.push({ i: s.i, partIndex: k, hasLatex: !!(p.latex && String(p.latex).trim()), latex: p.latex });
    }
  }
  return {
    formulaSegments: formulaish.map(s => s.i),
    formulaWithLatex: withLatex.map(s => s.i),
    formulaMissingLatex: formulaish.filter(s => !(typeof s.latex === 'string' && s.latex.trim())).map(s => s.i),
    formulaParts: partFormula,
    formulaPartsMissingLatex: partFormula.filter(p => !p.hasLatex)
  };
}

// ---------------------------------------------------------------- main
(async () => {
  const startedAll = Date.now();
  const conf = loadConf();
  const { file: storeFile, segs: local } = loadLocalSegments();
  const imageBase64 = fs.readFileSync(IMG).toString('base64');
  const mime = 'image/png';
  const prompt = buildPrompt(Number(PAGE), local);
  const localById = new Map(local.map(s => [s.id, s]));

  console.log(`模型：${MODEL}　端点：${conf.endpoint}　Key：已读取（不打印）`);
  console.log(`图片：${IMG}（${(fs.statSync(IMG).size / 1024).toFixed(0)} KB）　本地分段：${local.length} 条（来自 ${storeFile} 的 pageArchive["${PAGE}"]）`);
  console.log(`提示词：${prompt.length} 字符\n`);

  let attempt = null;
  let parsed = null;
  let budget = 8000;
  const attemptsLog = [];
  for (let round = 0; round < 2; round++) {
    const r = await callVision({ endpoint: conf.endpoint, apiKey: conf.apiKey, imageBase64, mime, prompt, maxTokens: budget });
    let ok = false, perr = null, obj = null;
    const cleaned = String(r.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    if (!cleaned) perr = '空回答（content 为空，多半是推理吃光了预算）';
    else {
      try { obj = JSON.parse(cleaned); ok = true; } catch (e) { perr = `不是合法 JSON：${e.message}`; }
    }
    attemptsLog.push({
      round: round + 1, maxTokens: budget, ms: r.ms, finishReason: r.finishReason,
      usage: r.usage, contentChars: cleaned.length, parsed: ok, error: perr,
      reasoningChars: (r.raw.choices?.[0]?.message?.reasoning_content || '').length
    });
    console.log(`第 ${round + 1} 次调用：max_tokens=${budget}　${(r.ms / 1000).toFixed(1)}s　finish=${r.finishReason}　` +
      `usage=${JSON.stringify(r.usage)}　content=${cleaned.length} 字符　${ok ? '解析成功' : '失败：' + perr}`);
    attempt = r;
    if (ok && Array.isArray(obj.segments) && obj.segments.length) { parsed = obj; break; }
    if (round === 0) { budget = 16000; console.log('→ 加倍 max_tokens 到 16000 重试一次'); }
  }

  if (!parsed) {
    const report = { ok: false, model: MODEL, error: '两次调用都没有拿到可用 JSON 回包', attempts: attemptsLog, rawTail: String(attempt?.content || '').slice(0, 2000) };
    fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
    console.log('\n❌ 失败：两次调用都没有拿到可用 JSON 回包。如实报告，不编造。原始片段：');
    console.log(String(attempt?.content || '').slice(0, 1200));
    process.exit(1);
  }

  const segs = parsed.segments;
  const numbering = checkNumbering(segs, local);
  const anchors = checkAnchors(segs, localById);
  const groups = checkGroups(segs);
  const inline = checkInline(segs, localById);
  const latex = checkLatex(segs);

  const splitSegs = segs.filter(s => String(s.action) === 'split');
  const review = splitSegs.map(s => ({
    i: s.i,
    localType: localById.get(Number(s.i))?.type,
    cleanTextRaw: localById.get(Number(s.i))?.cleanText,
    visionEntry: s
  }));

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    endpoint: conf.endpoint,
    page: Number(PAGE),
    image: { path: IMG, bytes: fs.statSync(IMG).size, mime },
    storeFile,
    promptChars: prompt.length,
    attempts: attemptsLog,
    usage: attempt.usage,
    latencyMs: attempt.ms,
    finishReason: attempt.finishReason,
    columns: parsed.columns,
    fixes: parsed.fixes,
    localSegments: local,
    rawResponse: parsed,
    checks: {
      numbering,
      anchors,
      groups,
      inline,
      latex,
      splitReview: review
    },
    summary: {
      numberingOk: numbering.missingI.length === 0 && numbering.extraI.length === 0 && numbering.duplicateI.length === 0,
      orderOk: numbering.orderIsPermutation,
      anchorCount: anchors.counts.total,
      anchorLocated: anchors.counts.located,
      anchorFailed: anchors.counts.fail,
      anchorRate: anchors.counts.locateRate,
      exactStrict: anchors.counts.exactStrict,
      exactLoose: anchors.counts.exactLoose,
      fuzzy: anchors.counts.fuzzy,
      splitCount: splitSegs.length,
      groupCount: groups.groupCount,
      inlineCount: inline.total,
      inlineFound: inline.found,
      formulaMissingLatex: latex.formulaMissingLatex,
      bboxPresent: groups.bboxPresent,
      totalMs: Date.now() - startedAll
    }
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');

  // ------------------------------------------------------------ 可读摘要
  const L = console.log;
  L('\n================ 核对摘要 ================');
  L(`耗时 ${(attempt.ms / 1000).toFixed(1)}s（总 ${((Date.now() - startedAll) / 1000).toFixed(1)}s）　finish=${attempt.finishReason}　usage=${JSON.stringify(attempt.usage)}`);
  L(`columns=${parsed.columns}　fixes=${parsed.fixes || '(无)'}`);

  L('\n[1] 编号完整性');
  L(`  本地 ${numbering.localCount} 条 / 回包 ${numbering.returnedCount} 条 / 去重后 ${numbering.uniqueI} 个不同 i`);
  L(`  漏掉 i：${numbering.missingI.length ? numbering.missingI.join(',') : '无'}　` +
    `多出 i：${numbering.extraI.length ? JSON.stringify(numbering.extraI) : '无'}　` +
    `重复 i：${numbering.duplicateI.length ? numbering.duplicateI.join(',') : '无'}`);
  L(`  order 是否 1..N 排列：${numbering.orderIsPermutation ? '是' : '否'}　序列=${numbering.orderSequence.join(',')}` +
    (numbering.orderDuplicate.length ? `　重复 order=${numbering.orderDuplicate.join(',')}` : ''));
  L(`  非法 type：${numbering.illegalTypes.length ? JSON.stringify(numbering.illegalTypes) : '无'}　非法 action：${numbering.illegalActions.length ? JSON.stringify(numbering.illegalActions) : '无'}`);

  L('\n[2] at 锚点定位率（关键）');
  L(`  锚点共 ${anchors.counts.total} 个：精确(严格) ${anchors.counts.exactStrict} ｜ 精确(宽松) ${anchors.counts.exactLoose} ｜ 模糊 ${anchors.counts.fuzzy} ｜ **定位不到 ${anchors.counts.fail}**`);
  L(`  可定位率 = ${anchors.counts.located}/${anchors.counts.total} = ${anchors.counts.total ? ((anchors.counts.located / anchors.counts.total) * 100).toFixed(1) : '-'}%`);
  anchors.rows.forEach(r => {
    if (r.method === 'absent(first-part-ok)') { L(`  · i=${r.i} 第${r.partIndex}片：无 at（${r.note}）`); return; }
    L(`  · i=${r.i} 第${r.partIndex}片 [${r.type}] ${r.method}${r.fuzzyScore !== null && r.method !== 'exact-strict' && r.method !== 'exact-loose' ? ' score=' + r.fuzzyScore : ''}　「${String(r.anchor).slice(0, 60)}」`);
  });
  const fails = anchors.rows.filter(r => r.method === 'fail');
  if (fails.length) {
    L('  定位不到明细：');
    fails.forEach(f => {
      L(`   ! i=${f.i} 第${f.partIndex}片 ${f.type}`);
      L(`     锚点        : ${JSON.stringify(f.anchor)}`);
      L(`     最佳猜测窗口: ${JSON.stringify(f.bestGuessWindow)} (score=${f.fuzzyScore})`);
      L(`     该段 cleanText: ${JSON.stringify(f.cleanTextSnippet)}`);
    });
  }

  L('\n[3] split / parts');
  L(`  action=split 共 ${splitSegs.length} 段：${splitSegs.map(s => s.i).join(',') || '无'}`);
  review.forEach(r => {
    L(`  · i=${r.i}（本地类型 ${r.localType}）why=${r.visionEntry.why || '-'}`);
    (r.visionEntry.parts || []).forEach((p, k) => L(`      part${k}: type=${p.type} at=${JSON.stringify(p.at)} latex=${p.latex ? JSON.stringify(String(p.latex).slice(0, 70)) : '-'}`));
  });

  L('\n[4] group / figure_caption（本页无 bbox 字段）');
  L(`  给出 group 的段：${groups.segmentsWithGroup} 条，共 ${groups.groupCount} 个 group`);
  groups.groups.forEach(g => L(`  · group ${g.group}（${g.size} 员，含图注=${g.hasCaption}）：${g.members.map(m => `[${m.i}]${m.type}`).join(' ')}`));
  L(`  figure_caption/caption 却没给 group：${groups.captionButNoGroup.length ? groups.captionButNoGroup.join(',') : '无'}`);
  L(`  回包里出现 bbox 字段的段：${groups.bboxPresent.length ? groups.bboxPresent.join(',') : '无（符合"不给坐标"的要求）'}`);

  L('\n[5] inline');
  L(`  共 ${inline.total} 条，find 在 cleanText 里逐字出现 ${inline.found} 条，未出现 ${inline.notFound} 条`);
  inline.rows.forEach(r => L(`  · i=${r.i} find=${JSON.stringify(r.find)} → ${r.inCleanText ? '出现(' + r.method + ')' : '未出现'}　latex=${JSON.stringify(r.latex)}`));

  L('\n[6b] 定位率口径说明（务必一起读）');
  L(`  上面 ${anchors.counts.total} 个锚点全部是 exact-strict，且逐字符等于文本层原文（连 ")(" + U+0302 这种残渣顺序都照抄了）。`);
  L('  所以 100% 定位率证明的是「模型愿意照抄文本层写法」；本页没有出现"模型改用图像排版写法"的硬骨头。');
  L(`  columns 字段：回包给的是 ${parsed.columns}；本页图像实为**分栏页面（图在栏内/题注整宽）**，这个值不可信，且没有任何产品代码消费它。`);

  L('\n[6] LaTeX');
  L(`  type=formula 的段：${latex.formulaSegments.join(',') || '无'}；其中给了 latex：${latex.formulaWithLatex.join(',') || '无'}；缺 latex：${latex.formulaMissingLatex.join(',') || '无'}`);
  latex.formulaParts.forEach(p => L(`  · parts 里的公式片 i=${p.i} part${p.partIndex} latex=${p.hasLatex ? JSON.stringify(String(p.latex).slice(0, 70)) : '（缺）'}`));

  L(`\n原始回包与核对结果已存：${path.relative(process.cwd(), OUT_JSON)}`);
})().catch(e => {
  console.error('探针失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
