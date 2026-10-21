/**
 * 端到端：裁图 → Python sidecar 识别 → 字符守恒校验 → 采纳/拒绝。
 *
 * 【它回答的问题】校验阈值（覆盖率 0.7 / 多余率 0.6）在**真实模型输出**上到底拦住了什么、放过了什么。
 * 单测只能证明逻辑自洽；真正要确认的是"会不会把识别对的丢掉、把编造的放进来"。
 *
 * 数据源用 formula_model_probe/out 下的真实裁图与它对应的文本层原文（boxes.json 里的 text），
 * 这两样都是 probe 阶段从真实论文里取出来的，不是造的。
 *
 * 用法：node scratch/formula_sidecar_e2e.js [--model PP-FormulaNet_plus-S] [--limit 20]
 *      需要先确认 python 环境里有 paddleocr（见 py/formula_sidecar.py 顶部说明）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

// 抽校验函数（与 formula_conservation_test.js 同一锚点）
const start = CODE.indexOf('  const LATEX_CHAR_CMD = {');
const end = CODE.indexOf('  /** 3× PDF 点 ≈ 216dpi', start);
if (start < 0 || end <= start) {
  console.error('❌ viewer.js 里找不到字符守恒校验（锚点失效）');
  process.exit(1);
}
// 同测试：必须带上 mathAlnumBase，否则 PDF 文本层的 U+1D400 段数学字母无法归一化
const mbStart = CODE.indexOf('  function mathAlnumBase(');
const mbEnd = CODE.indexOf('  /** 转义"不是数学语义"', mbStart);
if (mbStart < 0 || mbEnd <= mbStart) {
  console.error('❌ viewer.js 里找不到 mathAlnumBase（锚点失效）');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const V = new Function(`${CODE.slice(mbStart, mbEnd)}${CODE.slice(start, end)}
  return { latexVisibleChars, verifyLatexAgainstText };`)();

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const MODEL = argOf('--model', 'PP-FormulaNet_plus-S');
const LIMIT = Number(argOf('--limit', '0')) || 0;
const PY = argOf('--python', process.env.FORMULA_PYTHON || 'D:/python/python3.13/python.exe');
const OUT = path.join(ROOT, '..', 'formula_model_probe', 'out');

function main() {
  const casesFile = argOf('--cases', '');
  const samples = [];
  if (casesFile) {
    /*
     * 手工框 + 完整原文（由 formula_model_probe/10_manual_cases.py 生成）。
     * 这一组才是"框对了、原文完整"下的真实表现；boxes.json 那批是按 run 切碎的，
     * 拿它评校验会把"原文本来就不全"误判成"校验太严"。
     */
    const dir = path.dirname(path.resolve(casesFile));
    const list = JSON.parse(fs.readFileSync(path.resolve(casesFile), 'utf8'));
    for (const c of list) {
      const crop = path.join(dir, c.crop || '');
      if (!fs.existsSync(crop)) continue;
      samples.push({ key: c.name, kind: 'manual', text: String(c.text || ''), crop });
    }
  } else {
    const boxesFiles = fs.readdirSync(OUT).filter(f => f.endsWith('_boxes.json'));
    for (const f of boxesFiles) {
      const list = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
      for (const b of list) {
        const crop = path.join(OUT, b.crop || '');
        if (!b.crop || !fs.existsSync(crop)) continue;
        samples.push({ key: b.id, kind: b.kind, text: String(b.text || ''), crop });
      }
    }
  }
  const picked = LIMIT > 0 ? samples.slice(0, LIMIT) : samples;
  console.log(`样本 ${picked.length} 条，模型 ${MODEL}\n`);

  const proc = spawn(PY, [path.join(ROOT, 'py', 'formula_sidecar.py'), '--model', MODEL], {
    cwd: ROOT,
    env: { ...process.env, PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  });
  const rl = readline.createInterface({ input: proc.stdout });
  const waiters = new Map();
  let nextId = 1;

  rl.on('line', line => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.event === 'alive') {
      console.log(`[sidecar] 已启动，等模型加载…`);
      return;
    }
    if (m.event === 'ready') {
      console.log(`[sidecar] 就绪：${m.model} 加载 ${m.loadMs}ms\n`);
      ready();
      return;
    }
    if (m.event === 'fatal') {
      console.error('[sidecar] 初始化失败:', m.error, m.trace || '');
      process.exit(1);
    }
    const w = waiters.get(m.id);
    if (w) {
      waiters.delete(m.id);
      w(m);
    }
  });
  proc.stderr.on('data', () => {});

  const send = payload =>
    new Promise(resolve => {
      const id = nextId++;
      waiters.set(id, resolve);
      proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });

  async function ready() {
    let adopted = 0;
    let rejected = 0;
    let failed = 0;
    const rows = [];
    const t0 = Date.now();

    for (const s of picked) {
      const b64 = fs.readFileSync(s.crop).toString('base64');
      const r = await send({ cmd: 'recognize', key: s.key, image_b64: b64 });
      if (!r || !r.ok || !r.latex) {
        failed += 1;
        rows.push({ s, latex: r && r.error ? `ERR ${r.error}` : '(空)', verdict: 'skip' });
        continue;
      }
      const v = V.verifyLatexAgainstText(r.latex, s.text);
      if (v.ok) adopted += 1;
      else rejected += 1;
      rows.push({ s, latex: r.latex, ms: r.ms, verdict: v.ok ? 'ADOPT' : `REJECT(${v.reason})`, v });
    }

    console.log('判定   原文（文本层）                          → 模型输出');
    console.log('-'.repeat(110));
    for (const row of rows) {
      const head = row.verdict.padEnd(18);
      const src = (row.s.text || '').replace(/\s+/g, ' ').slice(0, 30).padEnd(32);
      const out = String(row.latex || '').replace(/\s+/g, ' ').slice(0, 52);
      const nums = row.v ? ` [cov=${row.v.coverage.toFixed(2)} extra=${row.v.extra.toFixed(2)}]` : '';
      console.log(`${head}${src}→ ${out}${nums}`);
    }

    const total = picked.length;
    console.log('-'.repeat(110));
    console.log(
      `合计 ${total}：采纳 ${adopted}（${((adopted / total) * 100).toFixed(0)}%）、拒绝 ${rejected}、无输出 ${failed}；耗时 ${(
        (Date.now() - t0) / 1000
      ).toFixed(1)}s`
    );
    console.log('\n【怎么看这份表】');
    console.log('  · REJECT 里如果是"原图本来就不是一条完整公式"（probe 的几何分组切碎了），拒绝是对的；');
    console.log('  · REJECT 里如果有明显正确的式子，说明阈值偏严，要把 coverage 门槛调低；');
    console.log('  · ADOPT 里如果有张冠李戴的，说明阈值偏松 —— 这一类比漏判危险，优先收紧。');

    const htmlOut = argOf('--html', '');
    if (htmlOut) {
      fs.writeFileSync(path.resolve(htmlOut), renderHtml(rows, { model: MODEL, dir: path.dirname(path.resolve(casesFile || 'x')) }), 'utf8');
      console.log(`\nHTML 报告：${path.resolve(htmlOut)}`);
    }

    proc.stdin.write(JSON.stringify({ id: 99999, cmd: 'shutdown' }) + '\n');
    setTimeout(() => proc.kill(), 800);
  }
}

/**
 * 生成对照报告。
 * 目的只有一个：让人能**一眼判断**"这条被采纳的结果到底对不对"——
 * 所以裁图、原文、模型输出必须并排，缺一样都得靠想象。
 */
function renderHtml(rows, meta) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cards = rows
    .map((row, i) => {
      const ok = row.verdict === 'ADOPT';
      const kind = ok ? 'ok' : row.verdict === 'skip' ? 'skip' : 'bad';
      const b64 = (() => {
        try {
          return fs.readFileSync(row.s.crop).toString('base64');
        } catch {
          return '';
        }
      })();
      const nums = row.v ? `cov ${row.v.coverage.toFixed(2)} · extra ${row.v.extra.toFixed(2)}` : '';
      return `<article class="card ${kind}">
  <header><span class="idx">${i + 1}</span><span class="name">${esc(row.s.key)}</span><span class="tag">${esc(row.verdict)}</span></header>
  <div class="row">
    <div class="pane"><div class="lbl">裁图（模型看到的输入）</div><img src="data:image/png;base64,${b64}" alt=""></div>
    <div class="pane"><div class="lbl">PDF 文本层原文</div><pre>${esc(row.s.text || '（无）')}</pre>
      <div class="lbl mt">模型输出</div><pre class="tex">${esc(row.latex || '（无）')}</pre>
      <div class="meta">${esc(nums)}${row.ms ? ` · ${row.ms}ms` : ''}</div></div>
  </div>
</article>`;
    })
    .join('\n');

  const okN = rows.filter(r => r.verdict === 'ADOPT').length;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>本地公式识别 · 校验对照</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#e5e7eb;--ok:#0f7b3f;--okbg:#f0fdf4;--bad:#b42318;--badbg:#fef3f2;--skip:#8a6d3b;--skipbg:#fffaeb}
*{box-sizing:border-box}
body{margin:0;padding:28px;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1{font-size:20px;margin:0 0 6px}
.sub{color:var(--mut);font-size:13px;margin-bottom:22px}
.sum{display:flex;gap:24px;margin-bottom:24px;padding:14px 18px;border:1px solid var(--line);border-radius:10px;background:#fafafa}
.sum b{font-size:20px;display:block}
.card{border:1px solid var(--line);border-radius:10px;margin-bottom:16px;overflow:hidden}
.card.ok{border-left:3px solid var(--ok)}
.card.bad{border-left:3px solid var(--bad)}
.card.skip{border-left:3px solid var(--skip)}
header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#fafafa;border-bottom:1px solid var(--line)}
.idx{width:20px;height:20px;border-radius:50%;background:#e5e7eb;font-size:12px;display:grid;place-items:center;color:#555}
.name{font-family:ui-monospace,Consolas,monospace;font-size:13px}
.tag{margin-left:auto;font-size:12px;padding:2px 9px;border-radius:99px;font-weight:600}
.ok .tag{background:var(--okbg);color:var(--ok)}
.bad .tag{background:var(--badbg);color:var(--bad)}
.skip .tag{background:var(--skipbg);color:var(--skip)}
.row{display:grid;grid-template-columns:minmax(200px,38%) 1fr;gap:0}
.pane{padding:14px}
.pane:first-child{border-right:1px solid var(--line);background:#fcfcfc}
.lbl{font-size:11px;letter-spacing:.04em;color:var(--mut);text-transform:uppercase;margin-bottom:6px}
.lbl.mt{margin-top:14px}
img{max-width:100%;border:1px solid var(--line);border-radius:6px;background:#fff}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.65 ui-monospace,Consolas,monospace;background:#f6f7f9;padding:9px 11px;border-radius:6px}
pre.tex{background:#f4f6fb}
.meta{margin-top:8px;font-size:11.5px;color:var(--mut);font-family:ui-monospace,Consolas,monospace}
footer{margin-top:26px;padding-top:16px;border-top:1px solid var(--line);color:var(--mut);font-size:12.5px}
</style></head><body>
<h1>本地公式识别 · 字符守恒校验对照</h1>
<div class="sub">模型 ${esc(meta.model)} · 6 个手工核对过 bbox 的案例 · 裁图是模型真实看到的输入</div>
<div class="sum"><div><b>${okN}/${rows.length}</b><span class="sub">采纳</span></div>
<div><b>${rows.filter(r => r.verdict !== 'ADOPT' && r.verdict !== 'skip').length}</b><span class="sub">拒绝</span></div></div>
${cards}
<footer>
<b>怎么读：</b>「采纳」= 通过了字符守恒 + 结构自检，会被写进精读稿与问 AI 的上下文；「拒绝」= 模型输出被判定不可信，前端保持原样（行间显示裁图、行内保留本地 LaTeX）。<br>
拒绝不等于识别失败 —— 这份样本里绝大多数拒绝是因为<b>框本身裁歪了</b>（手工框刻意留了 8pt 上标余量，吃进了上下行正文），
模型于是"忠实地"把正文也转写了进去。插件里行内公式的框来自 PDF 文本层的数学字体 span，不会这么大。
</footer>
</body></html>`;
}

main();
