const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function testPage1Ideal() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;
  const page = await doc.getPage(1);
  const textContent = await page.getTextContent();

  const rawSpans = textContent.items.map((it, idx) => ({
    text: it.str,
    x: it.transform[4],
    y: it.transform[5],
    w: it.width,
    h: it.height,
    idx
  })).filter(s => s.text.trim());

  // 1. 过滤页眉页脚
  const spans = rawSpans.filter(s => {
    if (s.y < 35 || s.y > 755) return false;
    const t = s.text.trim();
    if (t.startsWith('PNAS 2021') || t.startsWith('https://doi.org') || t === 'NEUROSCIENCE' || /^\d+ of \d+$/.test(t)) {
      return false;
    }
    return true;
  });

  const gutterX = 288;

  // 分流：
  // - Title (Page 1, y > 660, 大号字 h > 15)
  // - Author/Affiliation header (Page 1, 600 <= y <= 660) -> 论文作者信息，不作为正文翻译
  // - Col1 (左栏: x < gutterX, y < 600)
  // - Col2 (右栏: x >= gutterX, y < 600)
  // - Footnotes (y < 160 && h <= 6.5)
  const titleSpans = [];
  const authorSpans = [];
  const col1Spans = [];
  const col2Spans = [];
  const footnoteSpans = [];

  spans.forEach(s => {
    if (s.y > 660 && s.h > 15) {
      titleSpans.push(s);
    } else if (s.y >= 595) {
      // 论文作者、机构、收稿信息 (记录但默认不建正文翻译卡片)
      authorSpans.push(s);
    } else if (s.h <= 6.5 && s.y < 160) {
      footnoteSpans.push(s);
    } else if (s.x < gutterX) {
      col1Spans.push(s);
    } else {
      col2Spans.push(s);
    }
  });

  function spansToLines(spanList) {
    const sorted = [...spanList].sort((a, b) => {
      const effYa = (a.h > 18 && a.text.trim().length === 1) ? a.y + a.h - 9 : a.y;
      const effYb = (b.h > 18 && b.text.trim().length === 1) ? b.y + b.h - 9 : b.y;
      if (Math.abs(effYa - effYb) > 3.5) return effYb - effYa;
      return a.x - b.x;
    });

    const lines = [];
    let curLine = null;
    for (const span of sorted) {
      if (!curLine || Math.abs(curLine.y - span.y) > 3.5) {
        curLine = { y: span.y, h: span.h, minX: span.x, maxX: span.x + span.w, spans: [span] };
        lines.push(curLine);
      } else {
        curLine.spans.push(span);
        curLine.minX = Math.min(curLine.minX, span.x);
        curLine.maxX = Math.max(curLine.maxX, span.x + span.w);
        curLine.h = Math.max(curLine.h, span.h);
      }
    }
    return lines;
  }

  const titleLines = spansToLines(titleSpans);
  const col1Lines = spansToLines(col1Spans);
  const col2Lines = spansToLines(col2Spans);

  console.log(`Title lines: ${titleLines.length}`);
  console.log(`Col 1 lines: ${col1Lines.length}`);
  console.log(`Col 2 lines: ${col2Lines.length}`);

  // 拼接段落
  const paras = [];
  
  // 1. 标题
  let titleText = titleLines.map(l => l.spans.map(s => s.text).join(' ')).join(' ');
  paras.push({ type: 'title', text: titleText });

  // 2. 左栏和右栏的正文行
  const bodyLines = [...col1Lines, ...col2Lines];
  let curParaLines = [];
  let curType = 'body';

  function commit() {
    if (curParaLines.length === 0) return;
    let text = '';
    curParaLines.forEach(l => {
      l.spans.forEach(s => {
        let str = s.text;
        if (text.length > 0) {
          const last = text[text.length - 1];
          if (last === '-' || last === '‐') {
            text = text.slice(0, -1);
          } else if (!/\s$/.test(last) && !/^\s/.test(str) && !/^[,.;:!?’”')\]]/.test(str)) {
            text += ' ';
          }
        }
        text += str;
      });
    });
    text = text.trim();
    if (text) {
      paras.push({ type: curType, text });
    }
    curParaLines = [];
    curType = 'body';
  }

  let prevLine = null;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const text = line.spans.map(s => s.text).join(' ').trim();
    if (!text) continue;

    const isAbstract = i === 0 || text.startsWith('Daily life requires');
    const isKeywords = text.includes('|') || text.startsWith('Keywords') || text.startsWith('Index Terms');
    const isSignificance = text === 'Significance' || text.startsWith('Significance');
    const isHeading = line.h > 12 || /^[0-9]\.\s+[A-Z]/.test(text) || text === 'Results' || text === 'Discussion';

    const prevEnded = curParaLines.length > 0 && /[.!?。！？]["'”)]?\s*$/.test(curParaLines[curParaLines.length - 1].spans.map(s => s.text).join(' ').trim());
    const isIndented = prevLine && (line.minX > prevLine.minX + 6);
    const largeGap = prevLine && Math.abs(prevLine.y - line.y) > 13;

    let shouldStart = false;
    let nextType = 'body';

    if (isAbstract) {
      shouldStart = true; nextType = 'abstract';
    } else if (isKeywords) {
      shouldStart = true; nextType = 'keywords';
    } else if (isSignificance) {
      shouldStart = true; nextType = 'significance';
    } else if (isHeading) {
      shouldStart = true; nextType = 'heading';
    } else if (largeGap || (prevEnded && isIndented)) {
      shouldStart = true; nextType = 'body';
    }

    if (shouldStart) {
      commit();
      curType = nextType;
    }

    curParaLines.push(line);
    prevLine = line;
  }
  commit();

  console.log(`\n================ Ideal Page 1 Cards (${paras.length}) ================`);
  paras.forEach((p, idx) => {
    console.log(`\nCard [${idx + 1}] (${p.type}):`);
    console.log(`  "${p.text.slice(0, 110)}..."`);
  });
}

testPage1Ideal().catch(console.error);
