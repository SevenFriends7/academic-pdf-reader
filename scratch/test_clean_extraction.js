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

async function testCleanExtraction() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;

  for (let pageNum = 1; pageNum <= 5; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });

    const rawSpans = textContent.items.map((it, idx) => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height,
      idx
    })).filter(s => s.text.trim());

    // 1. 过滤页眉页脚（如 PNAS 2021..., 页码, doi 等）
    const spans = rawSpans.filter(s => {
      if (s.y < 35 || s.y > 755) return false;
      const t = s.text.trim();
      if (t.startsWith('PNAS 2021') || t.startsWith('https://doi.org') || t === 'NEUROSCIENCE' || /^\d+ of \d+$/.test(t)) {
        return false;
      }
      return true;
    });

    const gutterX = 288;

    // 分流容器
    const topHeaders = [];
    const captions = [];
    const footers = [];
    const col1Spans = [];
    const col2Spans = [];

    // 检测是否有通栏图注 (高度在 6.8 到 7.6 之间，或以 Fig 开头)
    const hasCaption = spans.some(s => s.h >= 6.8 && s.h <= 7.6 && (s.text.startsWith('Fig') || s.text.startsWith('Figure') || s.text.startsWith('Table')));
    let captionMinY = 0;
    let captionMaxY = 0;
    if (hasCaption) {
      const capSpans = spans.filter(s => s.h >= 6.8 && s.h <= 7.6 && s.y < 580);
      if (capSpans.length > 0) {
        captionMinY = Math.min(...capSpans.map(s => s.y)) - 4;
        captionMaxY = Math.max(...capSpans.map(s => s.y)) + 4;
      }
    }

    spans.forEach(s => {
      if (pageNum === 1 && s.y >= 600) {
        topHeaders.push(s);
      } else if (s.h <= 6.5 && s.y < 160) {
        footers.push(s);
      } else if (hasCaption && s.y >= captionMinY && s.y <= captionMaxY && s.h <= 7.8) {
        captions.push(s);
      } else if (s.x < gutterX) {
        col1Spans.push(s);
      } else {
        col2Spans.push(s);
      }
    });

    function spansToLines(spanList) {
      const sorted = [...spanList].sort((a, b) => {
        if (Math.abs(a.y - b.y) > 3.5) return b.y - a.y;
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
    const captionLines = spansToLines(captions);
    const footerLines = spansToLines(footers);

    // 标准双栏顺序：顶栏 -> 左栏 -> 右栏 -> 图注 -> 脚注
    // 若图注位于双栏上方 (如 Page 4、5 图在上半部)：图注在双栏上方
    let orderedLines = [];
    if (captionLines.length > 0) {
      const capY = captionLines[0].y;
      const colTopY = Math.max(
        col1Lines.length > 0 ? col1Lines[0].y : 0,
        col2Lines.length > 0 ? col2Lines[0].y : 0
      );
      if (capY > colTopY) {
        orderedLines = [...headerLines, ...captionLines, ...col1Lines, ...col2Lines, ...footerLines];
      } else {
        orderedLines = [...headerLines, ...col1Lines, ...col2Lines, ...captionLines, ...footerLines];
      }
    } else {
      orderedLines = [...headerLines, ...col1Lines, ...col2Lines, ...footerLines];
    }

    // 处理大首字下沉 (如 Page 1 巨型大写字母 'A')
    for (let i = 0; i < orderedLines.length - 1; i++) {
      const cur = orderedLines[i];
      const next = orderedLines[i + 1];
      // 如果当前行是首字大写下沉字母 (如 "A", h > 20, 且长度为 1)
      if (next && next.spans.length === 1 && next.spans[0].text.length === 1 && next.h > 18) {
        // 将下沉大字移到正文前
        cur.spans.unshift(next.spans[0]);
        orderedLines.splice(i + 1, 1);
      }
    }

    // 组合段落
    const paras = [];
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
        paras.push({ type: curType, text, sents: splitEnglishSentencesSmart(text) });
      }
      curParaLines = [];
      curType = 'body';
    }

    let prevLine = null;
    for (let i = 0; i < orderedLines.length; i++) {
      const line = orderedLines[i];
      const text = line.spans.map(s => s.text).join(' ').trim();
      if (!text) continue;

      const isTitle = pageNum === 1 && i < 3 && line.h > 15;
      const isAbstract = pageNum === 1 && text.startsWith('Daily life requires');
      const isKeywords = text.includes('|') || text.startsWith('Keywords') || text.startsWith('Index Terms');
      const isSignificance = text === 'Significance' || text.startsWith('Significance');
      const isCaption = text.startsWith('Fig.') || text.startsWith('Figure') || text.startsWith('Table');
      const isHeading = line.h > 12 || /^[0-9]\.\s+[A-Z]/.test(text) || text === 'Results' || text === 'Discussion';
      const isFootnote = line.h <= 6.5 && (text.startsWith('Author contributions') || text.startsWith('The authors declare'));

      const prevEnded = curParaLines.length > 0 && /[.!?。！？]["'”)]?\s*$/.test(curParaLines[curParaLines.length - 1].spans.map(s => s.text).join(' ').trim());
      const isIndented = prevLine && (line.minX > prevLine.minX + 6);
      const largeGap = prevLine && Math.abs(prevLine.y - line.y) > 13;

      let shouldStart = false;
      let nextType = 'body';

      if (isTitle) {
        if (curType !== 'title') { shouldStart = true; nextType = 'title'; }
      } else if (isAbstract) {
        shouldStart = true; nextType = 'abstract';
      } else if (isKeywords) {
        shouldStart = true; nextType = 'keywords';
      } else if (isSignificance) {
        shouldStart = true; nextType = 'significance';
      } else if (isCaption) {
        shouldStart = true; nextType = 'caption';
      } else if (isHeading) {
        shouldStart = true; nextType = 'heading';
      } else if (isFootnote) {
        shouldStart = true; nextType = 'metadata';
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

    console.log(`\n================ PAGE ${pageNum} (${paras.length} paras) ================`);
    paras.forEach((p, idx) => {
      console.log(`[P${idx + 1}] (${p.type}, ${p.sents.length} sents): ${p.text.slice(0, 95)}...`);
    });
  }
}

testCleanExtraction().catch(console.error);
