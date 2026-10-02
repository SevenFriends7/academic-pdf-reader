/**
 * 抽出 STM.pdf 第 3 页的文字块，按 y / x 排列，
 * 用来看清楚"被当成正文翻译的图表文字"到底长什么样。
 */
const fs = require('fs');
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(__dirname, '..', 'test-papers');
const path = require('path');

const pdfPath = path.join(PAPERS_DIR, 'STM.pdf');
const PAGE = Number(process.argv[2] || 3);

(async () => {
  // pdfjs-dist 3.11 是 CJS 构建
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise;
  const page = await doc.getPage(PAGE);
  const viewport = page.getViewport({ scale: 1.0 });
  console.log(`第 ${PAGE} 页  页面尺寸 ${viewport.width.toFixed(1)} x ${viewport.height.toFixed(1)} pt`);
  console.log(`分栏线(49.5%) = ${(viewport.width * 0.495).toFixed(1)}`);
  console.log('');

  const tc = await page.getTextContent();
  // 按 y 分行（y 是 PDF 坐标，原点左下）
  const items = tc.items
    .filter(it => it.str && it.str.trim())
    .map(it => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height
    }));
  items.sort((a, b) => (Math.abs(a.y - b.y) > 3.5 ? b.y - a.y : a.x - b.x));

  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!cur || Math.abs(cur.y - it.y) > 3.5) {
      cur = { y: it.y, x: it.x, maxX: it.x + it.w, parts: [it.str] };
      lines.push(cur);
    } else {
      cur.parts.push(it.str);
      cur.maxX = Math.max(cur.maxX, it.x + it.w);
    }
  }

  console.log(`共 ${lines.length} 行。格式：[序号] y=.. x=..→..  文本`);
  lines.forEach((l, i) => {
    const text = l.parts.join('').replace(/\s+/g, ' ').trim();
    const len = text.length;
    const hasPunct = /[.!?]/.test(text);
    const flags = [];
    if (!hasPunct) flags.push('无句末标点');
    if (l.maxX - l.x > viewport.width * 0.55) flags.push('通栏');
    if (text.length < 50) flags.push('短');
    console.log(
      `[${String(i + 1).padStart(2)}] y=${l.y.toFixed(0).padStart(3)} x=${l.x.toFixed(0)}→${l.maxX.toFixed(0)} len=${String(len).padStart(4)} ${flags.join(' ')}`
    );
    console.log(`      ${text.slice(0, 150)}`);
  });
})();
