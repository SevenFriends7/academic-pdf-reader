/**
 * 协议探针 v2b（第二轮）：专测 **group 成组** 与 **merge_next**
 *
 * 目标素材：cycle.pdf 第 2 页（跨栏/跨页续句样本）为主；`--pdf stm --page 6` 可切到 STM（但 STM 无归档页）。
 * 参数：--page N　--pdf cycle|stm　--check（只做前置检查、不调 API）
 * 但本探针**必须**有真实的本地分段（pageArchive[page] 的 id/type/cleanText）当输入 —— 协议本身
 * 就是"给模型看编号分段让它按编号回答"，所以没有任何占位/合成模式：
 * 如果全局存储里 STM 那一篇没有归档页，本脚本会**如实报错并退出**，不会自己从零实现文本层分段。
 *
 * 用法：
 *   node scratch/vision/probe_v2b.js            # 真调 API（需要 STM 的归档页存在）
 *   node scratch/vision/probe_v2b.js --check    # 只做前置检查，不调 API（不发请求、不花钱）
 *
 * 产出：scratch/vision/probe_v2b_result.json
 * 与第一轮 probe_v2.js 的差异（照父 agent 已落到产品的提示词）：
 *   1. 删掉 columns 字段
 *   2. inline.find ≤20 字符且必须是残渣形态，不许整句
 *   3. 明确 segments 按阅读顺序排列
 *   4. 单独强调 merge_next 的判据
 * 不修改 src/ 与 media/ 下任何产品代码。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MODEL = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : (process.env.VISION_MODEL || 'deepseek-flash');
const CHECK_ONLY = process.argv.includes('--check');

/** 命令行参数：--page N（页）、--pdf cycle|stm（换素材；默认 cycle，因为 STM 没有归档页） */
function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PAPERS = {
  cycle: {
    key: 'cycle',
    id: 'paper_1f6c2345c825e6b5dac7170135b540b1.json',
    pdfPath: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\cycle.pdf',
    name: 'cycle.pdf'
  },
  stm: {
    key: 'stm',
    id: 'paper_bffd2a00e397d6c1cbca9492a9d7b3d9.json',
    pdfPath: 'D:\\kx\\上海交大\\梯度校正测验\\梯度校正测验\\STM.pdf',
    name: 'STM.pdf'
  }
};
const PAPER = PAPERS[String(argValue('--pdf', 'cycle')).toLowerCase()] || PAPERS.cycle;
const PAGE = String(argValue('--page', process.env.PROBE_PAGE || (PAPER.key === 'stm' ? '6' : '2')));
const TEX_LIMIT = 1500;
const INLINE_MAX = 20;
const OUT_JSON = path.join(__dirname, process.env.PROBE_OUT || 'probe_v2b_result.json');
/** 图片命名沿用已渲染好的约定：cycle_p{N}_full.png / stm_p{N}_full.png */
const IMG = path.join(__dirname, `${PAPER.key}_p${PAGE}_full.png`);

// ---------------------------------------------------------------- 配置
function loadConf() {
  const settingsPath = path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json');
  if (!fs.existsSync(settingsPath)) throw new Error(`找不到 VS Code 设置：${settingsPath}`);
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const apiKey = (s['academicReader.apiKey'] || '').trim();
  const endpoint = (s['academicReader.apiEndpoint'] || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (!apiKey) throw new Error('设置里没有 academicReader.apiKey，无法真实调用 API');
  return { apiKey, endpoint };
}

/** 在**两个**扩展 id 的 globalStorage 里找目标论文的归档页（按存档文件名或 pdfName/pdfPath 匹配） */
function findTargetArchive() {
  const roots = ['paper-reader.academic-pdf-reader', 'academic-tools.academic-pdf-reader'].map(id =>
    path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', id)
  );
  const found = [];
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.startsWith('paper_') && x.endsWith('.json'))) {
      let paper;
      try {
        paper = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (e) {
        found.push({ dir, file: f, pdfName: '(解析失败)', isTarget: false, pages: [], error: e.message });
        continue;
      }
      const nameBlob = `${paper.pdfName || ''} ${paper.pdfPath || ''}`;
      const isTarget =
        f === PAPER.id || new RegExp(`(^|[\\\\/])${PAPER.name.replace('.', '\\.')}$`, 'i').test(nameBlob);
      const pa = paper.pageArchive || {};
      found.push({
        dir, file: f, pdfName: paper.pdfName || '(未知)', isTarget,
        pages: Object.keys(pa), pageArchive: pa
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------- v2b 提示词（与第一轮同骨架 + 四处改动）
const ALLOWED_TYPES = [
  'title', 'abstract', 'heading', 'body', 'caption', 'figure', 'figure_caption', 'table', 'table_caption',
  'formula', 'formula_inline', 'reference', 'footnote', 'header', 'footer', 'page_number', 'noise',
  'keywords', 'metadata', 'significance'
];

function buildPrompt(pageNum, segments) {
  const numbered = segments
    .map(s => `[${s.id}] (${s.type}) ${String(s.cleanText || '').replace(/\s+/g, ' ').trim().slice(0, TEX_LIMIT)}`)
    .join('\n');

  const example = JSON.stringify({
    segments: [
      { i: 0, type: 'table', order: 1, group: 1, action: 'keep', why: '表格1', latex: null, parts: [], inline: [] },
      { i: 1, type: 'table_caption', order: 2, group: 1, action: 'keep', why: '表1题注', latex: null, parts: [], inline: [] },
      { i: 2, type: 'heading', order: 3, group: null, action: 'keep', why: '小节标题', latex: null, parts: [], inline: [] }
    ],
    fixes: '把表内文字与表题注归到同一组'
  });

  return (
    `这是学术论文第 ${pageNum} 页的图像。下面是一份程序从 PDF 文本层给出的分段（顺序与类型可能有错，` +
    `表格/图内部文字会是一堆零散短行，公式会被抽成 "Y ̂ t" 这种残渣）。请结合图像判断版面，**只输出 JSON**，结构如下：\n` +
    `{"segments":[{"i":0,"type":"body","order":1,"group":null,"action":"keep","why":"15字内","latex":"仅公式类需要","parts":[{"type":"body","at":"这一片开头的原文文字"},{"type":"formula","at":"...","latex":"\\mathcal{L}=..."}],"inline":[{"find":"Y ̂ t","latex":"\\hat{Y}_t"}]}],"fixes":"一句话"}\n` +
    `示例（仅示范字段写法，不要照抄内容）：\n${example}\n\n` +
    `规则（必须严格遵守）：\n` +
    `- **segments 数组请按你判断的阅读顺序排列**（左栏从上到下、再右栏从上到下）。\n` +
    `- 每个 i 必须**恰好出现一次**，不得新增、不得漏掉、不得重复；i 必须与下面列表的编号一致。\n` +
    `- type 取值只能是：${ALLOWED_TYPES.join('|')}。这是你判断的**真实**类型（列表里的是程序判断，可能错）。\n` +
    `- order：阅读顺序，从 1 开始、到 N 结束；它应与数组顺序一致。\n` +
    `- action 只能是：keep（独立成段）| merge_next（其实是下一段的续句，应与下一段合并）| split（这一段里混了多种内容，如"正文 + 独立公式 + 正文"）| drop（页眉页脚页码、图内零散标签等应丢掉的碎片）。\n` +
    `- **merge_next 的判据：若某段的开头是小写字母/数字/左括号，或它上一段没有以句号等句末标点结束，` +
    `那它多半是上一段的续句（被文本层错误切开，常见于分栏处的半句）→ 给 merge_next。**\n` +
    `- parts：**只在 action="split" 时给**。按顺序列出拆出来的每一片，type 是这一片的真实类型；` +
    `at 是**这一片开头在文本层里的原文文字**——照抄下面列表里的残渣写法（不要用你从图像看到的排版写法），10~40 字；` +
    `第一片可以不给 at（默认从段首开始）；公式片额外给 latex。\n` +
    `- group：同一张表/图的成员给同一个正整数（同一页内唯一：整张表格的所有行、图内所有文字、该表的题注都算同一组），` +
    `不同表/图用不同数字；独立成段的内容给 null。题注那一行给 type "table_caption"（表格）或 "figure_caption"（图），` +
    `并让它和表内/图内文字属于同一个 group。\n` +
    `- latex：公式类（type 为 formula）**必须给**，转写成可渲染的 LaTeX（不要 $ 包裹、不要 \\begin{equation}）。非公式类给 null。\n` +
    `- inline：仅当段落正文里夹着行内公式、而文本层抽出来是残渣时给出替换项；` +
    `find 必须是该段文本里**逐字出现**的残渣子串（照抄列表里的写法），**长度不得超过 ${INLINE_MAX} 个字符**，` +
    `且必须是"残渣形态"（如 "Y ̂ t"、"L cycle,t"、"S θ"）——**不许把整句、整段公式当 inline**。没有合适的就给空数组 []。\n` +
    `- 不要输出 columns 字段，也不要输出 bbox 或任何坐标字段。\n` +
    `- 不要翻译，不要复述原文，不要 markdown 代码块，不要任何解释文字。\n\n` +
    `程序的分段结果：\n${numbered}`
  );
}

// ---------------------------------------------------------------- API
async function callVision({ endpoint, apiKey, imageBase64, mime, prompt, maxTokens }) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: '你是学术论文版面分析器。只输出 JSON（json 对象），不要 markdown 代码块，不要解释，不翻译原文。' },
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
  const json = JSON.parse(text);
  const choice = (json.choices || [])[0] || {};
  return {
    content: choice.message?.content || '',
    reasoningChars: (choice.message?.reasoning_content || '').length,
    finishReason: choice.finish_reason,
    usage: json.usage || null,
    ms
  };
}

// ---------------------------------------------------------------- 归一化 / 定位器（与第一轮同口径）
const DIACRITIC_RE = /[\u0300-\u036f]/g;
const SUPERSUB_MAP = {
  '\u2070': '0', '\u00b9': '1', '\u00b2': '2', '\u00b3': '3', '\u2074': '4', '\u2075': '5',
  '\u2076': '6', '\u2077': '7', '\u2078': '8', '\u2079': '9', '\u2080': '0', '\u2081': '1',
  '\u2082': '2', '\u2083': '3', '\u2084': '4', '\u2085': '5', '\u2086': '6', '\u2087': '7',
  '\u2088': '8', '\u2089': '9'
};
function normalize(s, { stripMarks = false } = {}) {
  let t = String(s == null ? '' : s).normalize('NFC');
  t = t.replace(/[\u3000\u00a0\u2000-\u200b\ufeff]/g, '');
  t = t.replace(/\u02c6/g, '\u0302');
  t = t.replace(/[\u2212\u2010-\u2015\u2018\u2019]/g, '-');
  t = t.replace(/[\u00d7\u22c5\u00b7]/g, 'x');
  t = t.replace(/[\u2070-\u2079\u2080-\u2089]/g, c => SUPERSUB_MAP[c] || c);
  if (stripMarks) t = t.replace(DIACRITIC_RE, '');
  return t.replace(/\s+/g, '').toLowerCase();
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
function fuzzyFind(text, anchor, threshold = 0.7) {
  const n = anchor.length;
  if (!n) return { score: 0, index: -1, window: '' };
  const lens = [...new Set([n, Math.max(1, n - 1), n + 1, Math.round(n * 0.75), Math.round(n * 1.25)])].filter(l => l >= 1 && l <= text.length);
  let best = { score: 0, index: -1, window: '' };
  for (const L of lens) {
    for (let i = 0; i + L <= text.length; i++) {
      const sc = dice(text.slice(i, i + L), anchor);
      if (sc > best.score) best = { score: sc, index: i, window: text.slice(i, i + L) };
    }
  }
  best.passed = best.score >= threshold;
  return best;
}
function locateAll(cleanText, anchor) {
  const T_strict = normalize(cleanText), T_loose = normalize(cleanText, { stripMarks: true });
  const A_strict = normalize(anchor), A_loose = normalize(anchor, { stripMarks: true });
  if (A_strict && T_strict.includes(A_strict)) return { method: 'exact-strict', index: T_strict.indexOf(A_strict), fuzzyScore: null };
  if (A_loose && T_loose.includes(A_loose)) return { method: 'exact-loose', index: T_loose.indexOf(A_loose), fuzzyScore: null };
  const f = fuzzyFind(T_loose, A_loose, 0.7);
  if (f.passed) return { method: 'fuzzy', index: f.index, fuzzyScore: Number(f.score.toFixed(3)) };
  const b = fuzzyFind(T_loose, A_loose, 0);
  return { method: 'fail', index: null, fuzzyScore: Number(b.score.toFixed(3)), bestGuessWindow: b.window };
}

// ---------------------------------------------------------------- 核对
function checkGroups(segs, localById) {
  const groups = new Map();
  for (const s of segs) {
    const g = s.group;
    if (g === null || g === undefined || g === '' || Number(g) === 0) continue;
    const key = String(g);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      i: s.i, type: s.type, order: s.order, action: s.action,
      head: String(localById.get(Number(s.i))?.cleanText || '').replace(/\s+/g, ' ').slice(0, 30)
    });
  }
  const list = [...groups.entries()].map(([g, members]) => ({
    group: g, size: members.length, members,
    hasCaption: members.some(m => /caption/.test(String(m.type))),
    types: [...new Set(members.map(m => m.type))]
  }));
  return {
    groupCount: list.length,
    groups: list,
    singletons: list.filter(g => g.size === 1).map(g => g.group),
    /** 每组的类型构成：能看出模型是否真把"图内文字 + 图注"收进同一组，还是只给题注挂了个号 */
    typeCounts: list.map(g => ({ group: g.group, size: g.size, typeCounts: g.members.reduce((a, m) => { a[m.type] = (a[m.type] || 0) + 1; return a; }, {}) })),
    captionWithoutGroup: segs.filter(s => /caption/.test(String(s.type)) && (s.group === null || s.group === undefined)).map(s => s.i),
    bboxPresent: segs.filter(s => s.bbox !== undefined).map(s => s.i),
    columnsPresent: segs.filter(s => s.columns !== undefined).length
  };
}

function checkMergeNext(segs, localById) {
  const rows = [];
  for (const s of segs) {
    if (String(s.action) !== 'merge_next') continue;
    const cur = localById.get(Number(s.i));
    const idx = segs.findIndex(x => Number(x.i) === Number(s.i));
    const next = idx >= 0 ? segs[idx + 1] : undefined;
    const prev = idx > 0 ? segs[idx - 1] : undefined;
    const text = String(cur?.cleanText || '').replace(/\s+/g, ' ').trim();
    const prevText = String(localById.get(Number(prev?.i))?.cleanText || '').replace(/\s+/g, ' ').trim();
    rows.push({
      i: s.i, localType: cur?.type, why: s.why,
      prevInResponseOrder: prev ? { i: prev.i, type: prev.type, tail: prevText.slice(-60) } : null,
      head: text.slice(0, 60), tail: text.slice(-60),
      startsLowercaseOrDigit: /^[a-z(\d]/.test(text),
      endsWithoutTerminalPunct: !/[.!?]["')\]]?$/.test(text),
      /**
       * merge_next 的真伪判据：action=merge_next 的语义是"本段其实是**下一段**的续句"，
       * 所以下一段必须以小写/数字/左括号开头（续句特征）。若下一段以大写字母开头，
       * 说明模型想表达的是"本段续自上一段/上一页"——那是 keep，不是 merge_next。
       */
      nextSegmentLooksLikeContinuation: next
        ? /^[a-z(\d]/.test(String(localById.get(Number(next.i))?.cleanText || '').replace(/\s+/g, ' ').trim())
        : false,
      nextInResponseOrder: next
        ? { i: next.i, type: next.type, head: String(localById.get(Number(next.i))?.cleanText || '').replace(/\s+/g, ' ').slice(0, 60) }
        : null
    });
  }
  const keepButLooksLikeContinuation = segs
    .filter(s => String(s.action) === 'keep')
    .map(s => {
      const t = String(localById.get(Number(s.i))?.cleanText || '').replace(/\s+/g, ' ').trim();
      return { i: s.i, startsLowercaseOrDigit: /^[a-z(\d]/.test(t), head: t.slice(0, 50) };
    })
    .filter(r => r.startsLowercaseOrDigit);

  /**
   * 真值对照：按"上段尾无句末标点 且 下段首小写/数字"在**回包顺序**里逐对扫一遍，
   * 这是 merge_next 规则本身给出的候选；再看模型有没有命中/漏掉/错标。
   */
  const adjacentCandidates = [];
  for (let k = 0; k + 1 < segs.length; k++) {
    const a = segs[k], b = segs[k + 1];
    const ta = String(localById.get(Number(a.i))?.cleanText || '').replace(/\s+/g, ' ').trim();
    const tb = String(localById.get(Number(b.i))?.cleanText || '').replace(/\s+/g, ' ').trim();
    const prevEndsOpen = !/[.!?]["')\]]?$/.test(ta);
    const nextStartsLower = /^[a-z(\d]/.test(tb);
    if (prevEndsOpen && nextStartsLower) {
      adjacentCandidates.push({
        prevI: a.i, prevType: a.type, prevAction: a.action, prevTail: ta.slice(-60),
        nextI: b.i, nextType: b.type, nextAction: b.action, nextHead: tb.slice(0, 60),
        modelMarkedMergeNext: String(a.action) === 'merge_next'
      });
    }
  }
  return { count: rows.length, rows, keepButLooksLikeContinuation, adjacentCandidates };
}

function checkAnchors(segs, localById) {
  const rows = [];
  const counts = { total: 0, exactStrict: 0, exactLoose: 0, fuzzy: 0, fail: 0, absent: 0 };
  for (const s of segs) {
    if (String(s.action) !== 'split') continue;
    const cleanText = localById.get(Number(s.i))?.cleanText || '';
    for (const [k, p] of (Array.isArray(s.parts) ? s.parts : []).entries()) {
      const at = p && p.at;
      if (at === null || at === undefined || String(at).trim() === '') {
        counts.absent++;
        rows.push({ i: s.i, partIndex: k, anchor: null, method: 'absent' });
        continue;
      }
      counts.total++;
      const r = locateAll(cleanText, String(at));
      if (r.method === 'exact-strict') counts.exactStrict++;
      else if (r.method === 'exact-loose') counts.exactLoose++;
      else if (r.method === 'fuzzy') counts.fuzzy++;
      else counts.fail++;
      rows.push({
        i: s.i, partIndex: k, anchor: String(at), type: p.type, method: r.method,
        fuzzyScore: r.fuzzyScore,
        bestGuessWindow: r.method === 'fail' ? r.bestGuessWindow : undefined,
        cleanTextSnippet: r.method === 'fail' ? cleanText.replace(/\s+/g, ' ').slice(0, 160) : undefined
      });
    }
  }
  counts.located = counts.exactStrict + counts.exactLoose + counts.fuzzy;
  counts.locateRate = counts.total ? Number((counts.located / counts.total).toFixed(3)) : null;
  return { counts, rows };
}

function checkInline(segs, localById) {
  const rows = [];
  let total = 0, found = 0, tooLong = 0;
  for (const s of segs) {
    for (const it of (Array.isArray(s.inline) ? s.inline : [])) {
      total++;
      const cleanText = localById.get(Number(s.i))?.cleanText;
      const find = String(it?.find ?? '');
      const len = [...find].length;
      const has = cleanText !== undefined && find ? locateAll(cleanText, find).method !== 'fail' : false;
      if (has) found++;
      if (len > INLINE_MAX) tooLong++;
      rows.push({ i: s.i, find, len, overLimit: len > INLINE_MAX, inCleanText: has, latex: it?.latex });
    }
  }
  const lens = rows.map(r => r.len).sort((a, b) => a - b);
  return {
    total, found, notFound: total - found, overLimit: tooLong,
    lenMin: lens[0] ?? null, lenMax: lens[lens.length - 1] ?? null,
    lenMedian: lens.length ? lens[Math.floor(lens.length / 2)] : null,
    rows
  };
}

/** 前置检查失败时也留一份可读的结果文件 */
function writeFail(reason, archives, extra) {
  try {
    fs.writeFileSync(OUT_JSON, JSON.stringify({
      ok: false,
      generatedAt: new Date().toISOString(),
      reason,
      ...(extra || {}),
      archives: archives.map(a => ({ dir: a.dir, file: a.file, pdfName: a.pdfName, isTarget: !!a.isTarget, archivedPages: a.pages })),
      targetPdf: PAPER.pdfPath,
      note: '本地分段必须由产品生成；探针不合成分段、不拿别的论文页顶替。'
    }, null, 2), 'utf8');
    console.log(`（失败详情已存 ${path.relative(process.cwd(), OUT_JSON)}）`);
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- main
(async () => {
  const startedAll = Date.now();
  const archives = findTargetArchive();
  const target = archives.find(a => a.isTarget);

  console.log(`模型：${MODEL}　素材：${PAPER.name} 第 ${PAGE} 页　图片：${path.basename(IMG)}（${fs.existsSync(IMG) ? (fs.statSync(IMG).size / 1024).toFixed(0) + ' KB' : '不存在'}）`);
  console.log('全局存储里的论文存档：');
  for (const a of archives) {
    console.log(`  ${a.file}　pdf=${a.pdfName}　归档页=[${a.pages.join(',') || '无'}]${a.isTarget ? '　← 本次目标' : ''}`);
  }

  if (!target) {
    const msg = `全局存储里没有 ${PAPER.name} 的存档记录（两个扩展 id 都查过了）`;
    console.log(`\n❌ ${msg}`);
    writeFail(msg, archives);
    process.exit(2);
  }
  if (!target.pages.length) {
    const msg = `找到 ${PAPER.name} 的存档 ${target.file}，但 pageArchive 里**一个归档页都没有**（pageArchive={}）。` +
      `本地分段必须由产品在打开该页时生成，探针不会自己从零实现文本层分段，也不会拿别的论文的页顶替。`;
    console.log(`\n❌ ${msg}`);
    console.log(`\n需要的前置动作：在扩展里打开 ${PAPER.name} 第 ${PAGE} 页（滚动/停留让它生成该页分段），然后重跑本脚本。`);
    writeFail(msg, archives);
    process.exit(2);
  }
  if (!Object.prototype.hasOwnProperty.call(target.pageArchive, PAGE)) {
    const msg = `${PAPER.name} 存档里没有第 ${PAGE} 页（现有归档页=[${target.pages.join(',')}]）`;
    console.log(`\n❌ ${msg}`);
    writeFail(msg, archives);
    process.exit(2);
  }
  const local = (target.pageArchive[PAGE] || []).map(p => ({
    id: Number(p.id), type: String(p.type || ''), cleanText: String(p.cleanText || '')
  }));
  console.log(`\n✅ 找到 ${PAPER.name} 第 ${PAGE} 页本地分段 ${local.length} 条（来自 ${target.file}）`);
  if (local.length < 8) {
    const msg = `${PAPER.name} 第 ${PAGE} 页只有 ${local.length} 条分段（<8），不满足"分段数 ≥8"的要求，拒绝用它跑`;
    console.log(`❌ ${msg}`);
    writeFail(msg, archives);
    process.exit(2);
  }
  const prompt = buildPrompt(Number(PAGE), local);
  console.log(`提示词 ${prompt.length} 字符；inline.find 上限 ${INLINE_MAX}；无 columns/bbox 字段。`);

  if (CHECK_ONLY) {
    console.log('\n--check 模式：不调用 API。以上前置检查通过，去掉 --check 即可真跑。');
    console.log('\n本地分段：');
    local.forEach(s => console.log(`  [${s.id}] (${s.type}) ${s.cleanText.replace(/\s+/g, ' ').slice(0, 90)}`));
    fs.writeFileSync(OUT_JSON, JSON.stringify({
      ok: false, mode: 'check-only', page: PAGE, localCount: local.length, localSegments: local,
      promptChars: prompt.length,
      archivesSummary: archives.map(a => ({ file: a.file, pdfName: a.pdfName, pages: a.pages }))
    }, null, 2), 'utf8');
    return;
  }

  const conf = loadConf();
  const imageBase64 = fs.readFileSync(IMG).toString('base64');
  const localById = new Map(local.map(s => [s.id, s]));
  const attempts = [];
  let parsed = null, last = null, budget = 16000; // 第一轮实测：8000 必空，直接 16000 起
  for (let round = 0; round < 2; round++) {
    const r = await callVision({ endpoint: conf.endpoint, apiKey: conf.apiKey, imageBase64, mime: 'image/png', prompt, maxTokens: budget });
    const cleaned = String(r.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let ok = false, err = null, obj = null;
    if (!cleaned) err = '空回答（content 为空，推理吃光预算）';
    else {
      try { obj = JSON.parse(cleaned); ok = true; } catch (e) { err = '不是合法 JSON：' + e.message; }
    }
    attempts.push({
      round: round + 1, maxTokens: budget, ms: r.ms, finishReason: r.finishReason,
      usage: r.usage, reasoningChars: r.reasoningChars, contentChars: cleaned.length, parsed: ok, error: err
    });
    console.log(`第 ${round + 1} 次调用：max_tokens=${budget}　${(r.ms / 1000).toFixed(1)}s　finish=${r.finishReason}　usage=${JSON.stringify(r.usage)}　${ok ? '解析成功' : '失败：' + err}`);
    last = r;
    if (ok && Array.isArray(obj.segments) && obj.segments.length) { parsed = obj; break; }
    if (round === 0) { budget = 32000; console.log('→ 加倍 max_tokens 重试一次'); }
  }

  if (!parsed) {
    const msg = '两次调用都没有拿到可用 JSON 回包';
    console.log(`\n❌ ${msg}`);
    writeFail(msg, archives, { attempts });
    process.exit(1);
  }

  const segs = parsed.segments;
  const ids = local.map(s => s.id);
  const seen = new Map();
  const dup = [];
  const extra = [];
  for (const s of segs) {
    const i = Number(s?.i);
    if (!Number.isFinite(i)) { extra.push(s); continue; }
    if (seen.has(i)) dup.push(i);
    seen.set(i, s);
    if (!ids.includes(i)) extra.push(s);
  }
  const numbering = {
    localCount: ids.length, returnedCount: segs.length, uniqueI: seen.size,
    missingI: ids.filter(i => !seen.has(i)), duplicateI: dup,
    extraI: extra.map(s => ({ i: s?.i, type: s?.type })),
    orderSequence: segs.map(s => s.order),
    orderIsSequence: segs.every((s, k) => Number(s.order) === k + 1)
  };
  const groupCheck = checkGroups(segs, localById);
  const merge = checkMergeNext(segs, localById);
  const anchors = checkAnchors(segs, localById);
  const inline = checkInline(segs, localById);

  const report = {
    ok: true, generatedAt: new Date().toISOString(), page: Number(PAGE), model: MODEL, endpoint: conf.endpoint,
    image: { path: IMG, bytes: fs.statSync(IMG).size }, storeFile: target.file, promptChars: prompt.length,
    attempts, usage: last.usage, latencyMs: last.ms, fixes: parsed.fixes,
    localSegments: local, rawResponse: parsed,
    checks: { numbering, groups: groupCheck, mergeNext: merge, anchors, inline },
    summary: {
      numberingOk: !numbering.missingI.length && !numbering.extraI.length && !numbering.duplicateI.length,
      groupCount: groupCheck.groupCount, singletonGroups: groupCheck.singletons,
      captionWithoutGroup: groupCheck.captionWithoutGroup,
      mergeNextCount: merge.count, keepButLooksLikeContinuation: merge.keepButLooksLikeContinuation.length,
      anchorCount: anchors.counts.total, anchorLocated: anchors.counts.located, anchorFailed: anchors.counts.fail,
      anchorRate: anchors.counts.locateRate, inlineCount: inline.total, inlineFound: inline.found,
      inlineOverLimit: inline.overLimit, bboxPresent: groupCheck.bboxPresent, columnsPresent: groupCheck.columnsPresent,
      totalMs: Date.now() - startedAll
    }
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');

  const L = console.log;
  L('\n================ v2b 核对摘要 ================');
  L(`耗时 ${(last.ms / 1000).toFixed(1)}s（总 ${((Date.now() - startedAll) / 1000).toFixed(1)}s）　finish=${last.finishReason}　usage=${JSON.stringify(last.usage)}`);
  L(`[1] 编号：漏 ${numbering.missingI.length}｜多 ${numbering.extraI.length}｜重复 ${numbering.duplicateI.length}｜order 与数组顺序一致=${numbering.orderIsSequence}`);
  L(`[2] group 成组：${groupCheck.groupCount} 组（单元素组 ${groupCheck.singletons.length} 个：${groupCheck.singletons.join(',') || '无'}）；题注没给 group：${groupCheck.captionWithoutGroup.join(',') || '无'}`);
  groupCheck.groups.forEach(g => {
    L(`  · group ${g.group}（${g.size} 员，含题注=${g.hasCaption}，类型=${g.types.join('/')}）`);
    g.members.forEach(m => L(`      [${m.i}] ${String(m.type).padEnd(14)} order=${m.order} ${m.head}`));
  });
  L(`  回包出现 columns 字段的段：${groupCheck.columnsPresent}　出现 bbox 的段：${groupCheck.bboxPresent.length ? groupCheck.bboxPresent.join(',') : '无'}`);
  L(`[3] merge_next：模型给了 ${merge.count} 次`);
  merge.rows.forEach(r => {
    L(`  · i=${r.i}（${r.localType}）why=${r.why}`);
    L(`      本段首: ${JSON.stringify(r.head)}`);
    L(`      本段尾: ${JSON.stringify(r.tail)}　[首小写/数字=${r.startsLowercaseOrDigit} 尾无句末标点=${r.endsWithoutTerminalPunct}]`);
    L(`      回包顺序里的上一段: ${r.prevInResponseOrder ? '[' + r.prevInResponseOrder.i + '] ' + r.prevInResponseOrder.type + ' 尾=' + JSON.stringify(r.prevInResponseOrder.tail) : '(开头)'}`);
    L(`      回包顺序里的下一段: ${r.nextInResponseOrder ? '[' + r.nextInResponseOrder.i + '] ' + r.nextInResponseOrder.type + ' 首=' + JSON.stringify(r.nextInResponseOrder.head) : '(末尾)'}`);
    L(`      ⇒ 下一段像续句吗（决定这个 merge_next 是真还是假）: ${r.nextSegmentLooksLikeContinuation ? '像 → 真' : '不像（下一段以大写开头）→ **假阳性**'}`);
  });
  if (merge.keepButLooksLikeContinuation.length) {
    L(`  该并却给了 keep 的候选（开头小写/数字）：${merge.keepButLooksLikeContinuation.map(r => `[${r.i}] ${JSON.stringify(r.head)}`).join('　')}`);
  }
  L(`  规则真值候选（回包顺序里"上段尾无句末标点 + 下段首小写/数字"）共 ${merge.adjacentCandidates.length} 对：`);
  merge.adjacentCandidates.forEach(c => {
    L(`    · [${c.prevI}](${c.prevType},${c.prevAction}) → [${c.nextI}](${c.nextType},${c.nextAction})　模型标了 merge_next=${c.modelMarkedMergeNext}`);
    L(`        上段结尾: ${JSON.stringify(c.prevTail)}`);
    L(`        下段开头: ${JSON.stringify(c.nextHead)}`);
  });
  if (!merge.adjacentCandidates.length) L('    （本页没有任何"上段无句末标点 + 下段小写开头"的相邻对）');
  L(`[4] 锚点：共 ${anchors.counts.total}，精确(严格) ${anchors.counts.exactStrict}｜精确(宽松) ${anchors.counts.exactLoose}｜模糊 ${anchors.counts.fuzzy}｜**失败 ${anchors.counts.fail}**（首片无 at ${anchors.counts.absent}）`);
  anchors.rows.filter(r => r.method === 'fail').forEach(f =>
    L(`  ! i=${f.i} 第${f.partIndex}片 锚点=${JSON.stringify(f.anchor)} 最佳窗口=${JSON.stringify(f.bestGuessWindow)} score=${f.fuzzyScore}`));
  L(`[5] inline：${inline.total} 条，命中 ${inline.found}，超 ${INLINE_MAX} 字 ${inline.overLimit} 条；长度 min/中位/max = ${inline.lenMin}/${inline.lenMedian}/${inline.lenMax}`);
  inline.rows.forEach(r => L(`  · i=${r.i} len=${r.len}${r.overLimit ? '(超限!)' : ''} find=${JSON.stringify(r.find)} → ${r.inCleanText ? '命中' : '未命中'}`));
  L(`\n结果已存：${path.relative(process.cwd(), OUT_JSON)}`);
})().catch(e => {
  console.error('探针失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
