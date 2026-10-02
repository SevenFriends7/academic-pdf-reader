const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

function splitEnglishSentencesSmart(text) {
  if (!text) return [];
  const rawSentences = [];
  let start = 0;
  const endRegex = /([.?!]["'”)]?)\s+(?=[A-Z0-9“"'(])/g;
  let match;

  while ((match = endRegex.exec(text)) !== null) {
    const endPos = match.index + match[1].length;
    const candidate = text.slice(start, endPos).trim();
    if (/\b(et al|e\.g|i\.e|fig|figs|ref|refs|vol|no|pp|dr|mr|mrs|ms|vs|approx|min|sec|ca)\.$/i.test(candidate) || /\b[A-Z]\.$/.test(candidate)) {
      continue;
    }
    if (candidate) {
      rawSentences.push({
        text: candidate,
        startIdx: start,
        endIdx: endPos
      });
    }
    start = match.index + match[0].length;
  }

  const remaining = text.slice(start).trim();
  if (remaining) {
    rawSentences.push({
      text: remaining,
      startIdx: start,
      endIdx: text.length
    });
  }

  return rawSentences;
}

async function testPerfect() {
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
  const spans = rawSpans.filter(span => {
    const sy = span.y;
    if (sy < 35 || sy > 755) return false;
    const t = span.text.trim();
    if (t.startsWith('PNAS 2021') || t.startsWith('https://doi.org') || t === 'NEUROSCIENCE' || /^\d+ of \d+$/.test(t)) {
      return false;
    }
    return true;
  });

  const gutterX = 288;
  const topHeaders = [];
  const col1Spans = [];
  const col2Spans = [];
  const captionSpans = [];
  const footnoteSpans = [];

  spans.forEach(span => {
    const sx = span.x;
    const sy = span.y;
    const sh = span.h;

    if (sy > 660 && sh > 15) {
      // 第一页大标题
      topHeaders.push(span);
    } else if (sy >= 595) {
      // 第一页作者、单位、收稿日期等论文头信息（不提取为正文翻译卡片）
    } else if (sh <= 6.5 && sy < 160) {
      footnoteSpans.push(span);
    } else if (sx < gutterX) {
      col1Spans.push(span);
    } else {
      col2Spans.push(span);
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

  const headerLines = spansToLines(topHeaders);
  const col1Lines = spansToLines(col1Spans);
  const col2Lines = spansToLines(col2Spans);
  const orderedLines = [...headerLines, ...col1Lines, ...col2Lines];

  const paras = [];
  let curParaLines = [];
  let curParaType = 'body';

  function commitParagraph() {
    if (curParaLines.length === 0) return;
    let cleanText = '';
    curParaLines.forEach(line => {
      line.spans.forEach(span => {
        const spanText = span.text || '';
        let needSpace = false;
        if (cleanText.length > 0) {
          const lastChar = cleanText[cleanText.length - 1];
          if (lastChar === '-' || lastChar === '‐') {
            cleanText = cleanText.slice(0, -1);
            needSpace = false;
          } else if (!/\s$/.test(lastChar) && !/^\s/.test(spanText) && !/^[,.;:!?’”')\]]/.test(spanText) && !/[“'(\[]$/.test(lastChar)) {
            needSpace = true;
          }
        }
        if (needSpace) cleanText += ' ';
        cleanText += spanText;
      });
    });

    cleanText = cleanText.trim();
    if (cleanText.length > 0) {
      paras.push({
        id: paras.length,
        type: curParaType,
        text: cleanText,
        sents: splitEnglishSentencesSmart(cleanText)
      });
    }

    curParaLines = [];
    curParaType = 'body';
  }

  let prevLine = null;
  const normalLineHeight = 9.5;

  for (let i = 0; i < orderedLines.length; i++) {
    const line = orderedLines[i];
    const text = line.spans.map(s => s.text).join(' ').trim();
    if (!text) continue;

    const isTitleLine = i < 3 && line.h > 15;
    const isAbstractStart = text.startsWith('Daily life requires');
    const isKeywordLine = text.includes('|') || text.startsWith('Keywords');
    const isSignificance = text === 'Significance' || text.startsWith('Significance');
    const isCaption = text.startsWith('Fig.') || text.startsWith('Figure') || text.startsWith('Table');
    const isHeading = (line.h > normalLineHeight * 1.3 && line.spans.length <= 4) || /^[0-9]\.\s+[A-Z]/.test(text) || text === 'Results' || text === 'Discussion';

    const isIndented = prevLine && (line.minX > prevLine.minX + 6);
    const prevEnded = curParaLines.length > 0 && /[.!?。！？]["'”)]?\s*$/.test(curParaLines[curParaLines.length - 1].spans.map(s => s.text).join(' ').trim());
    const largeVGap = prevLine && Math.abs(prevLine.y - line.y) > normalLineHeight * 1.45;

    let shouldStartNew = false;
    let nextType = 'body';

    if (isTitleLine) {
      if (curParaType !== 'title') { shouldStartNew = true; nextType = 'title'; }
    } else if (isAbstractStart) {
      if (curParaType !== 'abstract') { shouldStartNew = true; nextType = 'abstract'; }
    } else if (isKeywordLine) {
      if (curParaType !== 'keywords') { shouldStartNew = true; nextType = 'keywords'; }
    } else if (isSignificance) {
      if (curParaType !== 'significance') { shouldStartNew = true; nextType = 'significance'; }
    } else if (isCaption) {
      shouldStartNew = true; nextType = 'caption';
    } else if (isHeading) {
      shouldStartNew = true; nextType = 'heading';
    } else if (curParaType === 'keywords' && !isKeywordLine) {
      // 关键词结束，进入正文
      shouldStartNew = true; nextType = 'body';
    } else if (curParaType === 'abstract' && !isAbstractStart && isKeywordLine) {
      shouldStartNew = true; nextType = 'keywords';
    } else if (curParaType === 'significance' && !isSignificance && (prevEnded || largeVGap)) {
      shouldStartNew = true; nextType = 'body';
    } else if (curParaType === 'body' && prevEnded && (isIndented || largeVGap)) {
      shouldStartNew = true; nextType = 'body';
    }

    if (shouldStartNew) {
      commitParagraph();
      curParaType = nextType;
    }

    curParaLines.push(line);
    prevLine = line;
  }
  commitParagraph();

  let bodyIdx = 0;
  paras.forEach(p => {
    if (p.type === 'body') {
      bodyIdx++;
      p.bodyIndex = bodyIdx;
    }
  });

  console.log(`\n================ Page 1 Clean Extracted Paragraphs (${paras.length}) ================`);
  paras.forEach((p, idx) => {
    const label = p.type === 'body' ? `正文 第 ${p.bodyIndex} 段` : p.type;
    console.log(`\n[${label}] (${p.sents.length} 句):`);
    console.log(`  "${p.text.slice(0, 110)}..."`);
  });
}

testPerfect().catch(console.error);
