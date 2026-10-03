/**
 * 视觉手术回放（离屏、0 次 API）：把某页本机存档里的**本地原件 + 视觉回包**喂给真实的
 * `visionSurgery`，打印每一步结果——模型想怎么改、代码实际做了什么、哪些判断被跳过了。
 *
 * 【什么时候用它】用户说"这一页 / 这一段不对"时，先在这里复现：
 * 能看到模型的 index/type/action/parts/inline，以及手术后的段落类型、latex、文本。
 *
 * 用法：
 *   node scratch/vision_replay.js STM 6            # 论文关键词 + 页码
 *   node scratch/vision_replay.js AOT 5 --render   # 额外按真实渲染函数打印原文/译文侧 HTML
 *   VIEWER_SRC=<装进 IDE 的 viewer.js> 可验证"交付物本身"的行为
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(process.env.VIEWER_SRC || path.join(ROOT, 'media', 'viewer.js'), 'utf8');
const wantFile = process.argv[2] || 'STM';
const wantPage = String(process.argv[3] || '6');
const doRender = process.argv.includes('--render');

function extractFn(name) {
  const s = code.indexOf(`  function ${name}(`);
  const e = code.indexOf('\n  }', s);
  if (s < 0 || e < 0) throw new Error(`抽不到 ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(`${code.slice(s, e + 4)}\n return ${name};`)();
}
const splitEnglishSentencesSmart = extractFn('splitEnglishSentencesSmart');
const surgStart = code.indexOf('  function normalizeVisionType(t) {');
const surgEnd = code.indexOf('  function applyVisionSegments(pageNum, result) {');
const htmlStart = code.indexOf('  const RESIDUE_HAT_RE');
const htmlEnd = code.indexOf('\n  function renderInlineMarkdown(');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// eslint-disable-next-line no-new-func
const M = new Function(
  'splitEnglishSentencesSmart',
  'escapeHtml',
  'renderMathSpan',
  'console',
  `${code.slice(surgStart, surgEnd)}
   ${htmlStart > 0 ? code.slice(htmlStart, htmlEnd) : ''}
   return { visionSurgery, renderEnTextHtml };`
)(splitEnglishSentencesSmart, esc, (tex, d) => `<KATEX${d ? '-D' : ''}>${tex}</KATEX>`, { log() {}, warn() {} });

const dir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
fs.readdirSync(dir)
  .filter(f => f.startsWith('paper_') && f.endsWith('.json'))
  .forEach(f => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const name = path.basename(j.pdfPath || j.pdfName || f);
    if (!name.includes(wantFile)) return;
    const vs = (j.visionStructure || {})[wantPage];
    const arch = (j.pageArchive || {})[wantPage];
    if (!vs || !arch) {
      console.log(`（${name} 第 ${wantPage} 页没有存档：vision=${!!vs} archive=${!!arch}）`);
      return;
    }
    console.log(`\n================ ${name} 第 ${wantPage} 页　fixes=${vs.fixes || '(无)'}`);
    console.log('--- 模型回包 segments（index 对应本地段落 id）---');
    (vs.segments || []).forEach(s => {
      console.log(
        `#${s.index} ${s.type} action=${s.action || '-'} order=${s.order === undefined ? '-' : s.order}` +
          `${s.group ? ' group=' + s.group : ''}${s.latex ? ' 顶层latex=' + JSON.stringify(String(s.latex).slice(0, 80)) : ''}`
      );
      if (s.why) console.log(`      why=${JSON.stringify(s.why)}`);
      (s.parts || []).forEach((p, k) =>
        console.log(`      part${k} type=${p.type} at=${JSON.stringify(p.at)} latex=${JSON.stringify(String(p.latex || '').slice(0, 70))}`)
      );
      (s.inline || []).forEach(it => console.log(`      inline find=${JSON.stringify(it.find)} → ${JSON.stringify(it.latex)}`));
    });

    console.log('--- 本地原件段落（手术前）---');
    const local = (Array.isArray(arch) ? arch : Object.values(arch)).map(p => JSON.parse(JSON.stringify(p)));
    local.forEach(p => console.log(`[${p.id}] ${p.type}  ${String(p.cleanText || '').slice(0, 100)}`));

    const stats = M.visionSurgery(local, vs);
    console.log(
      `--- 手术后（split=${stats.split} merged=${stats.merged} anchorMissed=${stats.anchorMissed} ` +
        `typeChanged=${stats.typeChanged} dropped=${stats.dropped}）---`
    );
    local.forEach(p => {
      const warn = p.type === 'formula' && !String(p.visionLatex || '').trim() ? '  ⚠️ 公式段却没有 latex' : '';
      console.log(`[${p.id}] ${p.type}${p.visionLatex ? ' latex=' + JSON.stringify(String(p.visionLatex).slice(0, 70)) : ''}${warn}`);
      console.log(`     ${String(p.cleanText || '').slice(0, 110)}`);
      if (!doRender) return;
      const zh = p.translation || (p.sentenceTranslations || []).join(' ');
      if (p.cleanText) console.log('     EN→ ' + M.renderEnTextHtml(p.cleanText, p.visionInline).slice(0, 220));
      if (zh) console.log('     ZH→ ' + M.renderEnTextHtml(zh, p.visionInline).slice(0, 220));
    });
    (stats.notes || []).forEach(n => console.log('  note: ' + n));
  });
