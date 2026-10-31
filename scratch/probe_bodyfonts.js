/** 鍘熷瀷锛氭寜椤电粺璁″瓧浣撴槸鍚﹁姝ｆ枃浣跨敤锛堢敤浜庤璁?CM 姝ｆ枃瀛椾綋璇嗗埆瑙勫垯锛夈€?*/
'use strict';
const fs = require('fs');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const MATH_FONT_RE = /(^|[+\-])(CM(MI|SY|R|EX|BX|SS|TT|TI|U|Sans)|MS(AM|BM)|LatinModern(M|Math)?|LMMath|STIX|XITS|CambriaMath|AsanaMath|TeXGyre(Math|Pagella|Termes|Bonum|Schola)|EulerMath|MathJax|Symbol|MTExtra|MathematicalPi)/i;
const isMathFontName = n => MATH_FONT_RE.test(String(n || '').replace(/^[A-Z]{6}\+/, ''));

function analyse(items) {
  const stats = new Map();
  let allChars = 0;
  const sizeVotes = new Map();
  for (const it of items) {
    const t = String(it.str || '');
    if (!t.trim()) continue;
    const nonSpace = t.replace(/\s+/g, '').length;
    allChars += nonSpace;
    const size = Math.abs((it.transform && it.transform[3]) || it.height || 0);
    if (!isMathFontName(it.font)) continue;
    const rec = stats.get(it.font) || { font: it.font, letters: 0, chars: 0, multiWord: 0, minSize: Infinity, samples: [] };
    const words = t.match(/[A-Za-z]{2,}/g) || [];
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    rec.letters += letters;
    rec.chars += nonSpace;
    if (words.length >= 2) rec.multiWord += 1;
    if (size > 0) rec.minSize = Math.min(rec.minSize, size);
    if (rec.samples.length < 2 && words.length >= 2) rec.samples.push(t.slice(0, 40));
    stats.set(it.font, rec);
    if (size > 0 && /[A-Za-z]/.test(t)) {
      const key = Math.round(size * 2) / 2;
      sizeVotes.set(key, (sizeVotes.get(key) || 0) + nonSpace);
    }
  }
  let bodySize = 0, best = -1;
  sizeVotes.forEach((v, k) => { if (v > best) { best = v; bodySize = k; } });
  return [...stats.values()].map(r => ({ ...r, share: r.chars / Math.max(1, allChars), bodySize }));
}

(async () => {
  const pdf = process.argv[2];
  const pages = process.argv.slice(3).map(Number);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), useSystemFonts: false }).promise;
  for (const pg of pages) {
    const page = await doc.getPage(pg);
    const tc = await page.getTextContent();
    await page.getOperatorList();
    const real = {};
    for (const it of tc.items) {
      if (!it.fontName || real[it.fontName]) continue;
      try { real[it.fontName] = page.commonObjs.get(it.fontName).name || it.fontName; } catch { real[it.fontName] = it.fontName; }
    }
    const mapped = tc.items.map(it => ({ str: it.str, transform: it.transform, height: it.height, font: real[it.fontName] })); const rows = analyse(mapped).map(r => ({ ...r, name: real[r.font] || r.font }));
    console.log(`\n== page ${pg} ==`);
    rows.sort((a, b) => b.chars - a.chars).forEach(r => {
      const share = r.share >= 0.22;
      const prose = r.letters >= 24 && r.multiWord >= 1;
      const tt = /CMTT/i.test(r.name) && r.letters >= 6 && r.multiWord >= 1;
      const head = r.bodySize > 0 && r.letters >= 3 && r.minSize >= r.bodySize * 1.1;
      const flag = share ? 'SHARE' : prose ? 'PROSE' : tt ? 'TT' : head ? 'HEAD' : '';
      console.log(`  ${String(r.name).padEnd(24)} chars=${String(r.chars).padStart(5)} share=${(r.share * 100).toFixed(1).padStart(5)}% letters=${String(r.letters).padStart(4)} multi=${String(r.multiWord).padStart(2)} minSz=${String(r.minSize).padStart(5)} bodySz=${r.bodySize} ${flag}`);
    });
  }
})().catch(e => { console.error(e); process.exit(1); });

