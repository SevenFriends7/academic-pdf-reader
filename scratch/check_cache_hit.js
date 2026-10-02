/**
 * 校验：修复段落切分后，某页某段的缓存键是否正好命中已有的好译文。
 * 用途：确认"重载后立刻显示正确译文、不需要重新调 API"。
 *
 * 用法：PAPERS_DIR=<论文目录> node scratch/check_cache_hit.js <页码> <段落开头关键词> [文件名]
 */
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(ROOT, 'test-papers');
const PAGE = Number(process.argv[2] || 8);
const NEEDLE = process.argv[3] || 'We have presented';
const FILE = process.argv[4] || 'STM.pdf';

const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');
const layoutStart = code.indexOf('const detectColumnStructure = (spanList, pageW) => {');
const layoutEnd = code.indexOf('// 9. 段落聚合并构建字符级精确映射表');
const paraStart = code.indexOf('    function commitParagraph() {');
const paraEnd = code.indexOf('    let bodyCount = 0;', paraStart);
if (layoutStart < 0 || layoutEnd < 0 || paraStart < 0 || paraEnd < 0) {
  console.error('代码抽取失败');
  process.exit(1);
}

const layout = new Function(
  'spans',
  'pagePdfW',
  'pagePdfH',
  'pageNum',
  'console',
  `${code.slice(layoutStart, layoutEnd)}\n return { orderedLines, gutterX, isSingleColumnPage, captionLabelRegex };`
);
const paragraphize = new Function(
  'orderedLines',
  'captionLabelRegex',
  'pageNum',
  'splitEnglishSentencesSmart',
  'isSingleColumnPage',
  'gutterX',
  'console',
  `let paras = []; let curParaLines = []; let curParaType = 'body';
   ${code.slice(paraStart, paraEnd)}
   return paras;`
);

/** 与 viewer.js 的 getParaSig 完全一致的指纹 */
function paraSig(text) {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${s.length}`;
}

(async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(PAPERS_DIR, FILE))), useSystemFonts: false }).promise;
  const page = await doc.getPage(PAGE);
  const vp = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent();
  const spans = tc.items
    .filter(i => i.str && i.str.trim())
    .map(i => ({ textContent: i.str, _pdfX: i.transform[4], _pdfY: i.transform[5], _pdfH: i.height, _pdfW: i.width, setAttribute() {} }));

  const r = layout(spans, vp.width, vp.height, PAGE, { log() {} });
  const paras = paragraphize(r.orderedLines, r.captionLabelRegex, PAGE, t => (t || '').split(/(?<=[.!?])\s+/).filter(Boolean), r.isSingleColumnPage, r.gutterX, { log() {} });

  const hit = paras.find(p => (p.cleanText || '').includes(NEEDLE));
  if (!hit) {
    console.log(`第 ${PAGE} 页找不到含「${NEEDLE}」的段落`);
    return;
  }
  console.log(`第 ${PAGE} 页匹配段落：${hit.type}，${hit.cleanText.length} 字`);
  console.log(`开头：${hit.cleanText.slice(0, 90)}…`);
  const sig = paraSig(hit.cleanText);
  console.log(`\n当前代码算出的指纹：${sig}`);

  // 在所有 IDE 的存储里找这个指纹
  const roots = [
    path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader'),
    path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader'),
    path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'academic-tools.academic-pdf-reader')
  ];
  let foundRoot = null;
  let cache = null;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const f of fs.readdirSync(root).filter(x => x.endsWith('.json'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
        if (j && j.translations && Object.keys(j.translations).some(k => k.startsWith(`${PAGE}_`))) {
          foundRoot = `${root}\\${f}`;
          cache = j;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (cache) break;
  }
  if (!cache) {
    console.log('未找到含该页缓存的存储文件');
    return;
  }
  console.log(`缓存文件：${foundRoot}\n`);

  const keys = Object.keys(cache.translations).filter(k => k.startsWith(`${PAGE}_`));
  const exact = keys.filter(k => k.endsWith(sig));
  console.log(`该页缓存条目 ${keys.length} 条，其中指纹完全匹配当前段落的：${exact.length} 条`);
  if (exact.length > 0) {
    exact.forEach(k => {
      console.log(`  ✅ ${k}`);
      console.log(`     译文：${String(cache.translations[k]).slice(0, 160)}…`);
      const sents = (cache.sentenceTranslations || {})[k];
      console.log(`     逐句译文：${sents ? sents.length + ' 条' : '无'}`);
    });
  } else {
    console.log('  ⚠️ 没有完全匹配的条目——重载后该段会被重新翻译（会消耗一次 API 调用）。');
  }

  // ---- 整页统计：修复后的段落结构能命中多少条已有译文 ----
  console.log('\n=== 整页命中情况（判断重载后是否需要重新花钱翻译） ===');
  let hitCount = 0;
  const misses = [];
  for (const p of paras) {
    const s = paraSig(p.cleanText);
    const ok = s && keys.some(k => k.endsWith(s));
    if (ok) hitCount++;
    else misses.push(`${p.type}(${(p.cleanText || '').length}字) ${(p.cleanText || '').slice(0, 46)}…`);
  }
  console.log(`  命中 ${hitCount} / ${paras.length} 段`);
  if (misses.length) {
    console.log('  未命中（重载后会重新翻译）：');
    misses.forEach(m => console.log(`    · ${m}`));
  } else {
    console.log('  ✅ 整页全部命中：重载后立刻显示已有译文，不产生任何 API 花费');
  }
})();
