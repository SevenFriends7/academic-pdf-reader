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

async function testFullLayoutExtraction() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;

  for (let pageNum = 1; pageNum <= 3; pageNum++) {
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

    // 过滤页眉页脚噪音
    const spans = rawSpans.filter(s => {
      if (s.y < 35 || s.y > 755) return false;
      const t = s.text.trim();
      if (t.startsWith('PNAS 2021') || t.startsWith('https://doi.org') || t === 'NEUROSCIENCE' || /^\d+ of \d+$/.test(t)) {
        return false;
      }
      return true;
    });

    // 检测分栏与分界点
    const midX = viewport.width / 2; // 通常 612 / 2 = 306
    let gutterX = 285;
    
    // 自适应计算 gutterX
    const bodySpans = spans.filter(s => s.w > 60 && s.w < 260);
    const leftCols = bodySpans.filter(s => s.x < midX - 20);
    const rightCols = bodySpans.filter(s => s.x > midX - 20);
    const isTwoCol = leftCols.length > 5 && rightCols.length > 5;

    if (isTwoCol) {
      const maxLeft = Math.max(...leftCols.map(s => s.x + s.w));
      const minRight = Math.min(...rightCols.map(s => s.x));
      if (minRight > maxLeft) {
        gutterX = (maxLeft + minRight) / 2;
      }
    }

    const headerSpans = [];
    const col1Spans = [];
    const col2Spans = [];
    const footerSpans = [];

    spans.forEach(s => {
      // 第一页标题与作者大字 (y >= 600)
      if (pageNum === 1 && s.y >= 600) {
        headerSpans.push(s);
      }
      // 页底作者贡献、利益冲突等小字脚注 (h <= 6.5 && y < 160)
      else if (s.h <= 6.5 && s.y < 160) {
        footerSpans.push(s);
      }
      // 双栏分流
      else if (isTwoCol) {
        if (s.x < gutterX) {
          col1Spans.push(s);
        } else {
          col2Spans.push(s);
        }
      } else {
        col1Spans.push(s);
      }
    });

    // 栏目内组行函数
    function spansToLines(spanList) {
      const sorted = [...spanList].sort((a, b) => {
        if (Math.abs(a.y - b.y) > 3.5) return b.y - a.y; // 从上到下
        return a.x - b.x; // 从左到右
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

    const headerLines = spansToLines(headerSpans);
    const col1Lines = spansToLines(col1Spans);
    const col2Lines = spansToLines(col2Spans);
    const footerLines = spansToLines(footerSpans);

    // 标准双栏阅读顺序：Header -> 左栏 Col1 -> 右栏 Col2 -> Footer
    const orderedLines = [...headerLines, ...col1Lines, ...col2Lines, ...footerLines];

    console.log(`\n================ Page ${pageNum} Ordered Lines: ${orderedLines.length} ================`);

    // 构建段落
    const paras = [];
    let curLines = [];
    let curType = 'body';

    function commitPara() {
      if (curLines.length === 0) return;
      let text = '';
      curLines.forEach(l => {
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
      curLines = [];
      curType = 'body';
    }

    let prevLine = null;
    for (let i = 0; i < orderedLines.length; i++) {
      const line = orderedLines[i];
      const lineText = line.spans.map(s => s.text).join(' ').trim();
      if (!lineText) continue;

      const isTitle = pageNum === 1 && i < 4 && line.h > 15;
      const isAbstractStart = pageNum === 1 && lineText.startsWith('Daily life requires');
      const isKeyword = lineText.includes('|') || lineText.startsWith('Keywords');
      const isSignificance = lineText === 'Significance' || lineText.startsWith('Significance');
      const isFooterStart = line.h <= 6.5 && (lineText.startsWith('Author contributions') || lineText.startsWith('The authors declare'));

      // 缩进检测 (段落首行通常向右缩进 6~12 pt)
      const isIndented = prevLine && (line.minX > prevLine.minX + 6);
      const prevEnded = curLines.length > 0 && /[.!?。！？]["'”)]?\s*$/.test(curLines[curLines.length - 1].spans.map(s => s.text).join(' ').trim());
      const largeGap = prevLine && Math.abs(prevLine.y - line.y) > line.h * 1.6;

      let shouldStartNew = false;
      let nextType = 'body';

      if (isTitle) {
        if (curType !== 'title') { shouldStartNew = true; nextType = 'title'; }
      } else if (isAbstractStart) {
        shouldStartNew = true; nextType = 'abstract';
      } else if (isKeyword) {
        shouldStartNew = true; nextType = 'keywords';
      } else if (isSignificance) {
        shouldStartNew = true; nextType = 'significance';
      } else if (isFooterStart) {
        shouldStartNew = true; nextType = 'metadata';
      } else if (prevEnded && (isIndented || largeGap)) {
        shouldStartNew = true; nextType = 'body';
      }

      if (shouldStartNew) {
        commitPara();
        curType = nextType;
      }

      curLines.push(line);
      prevLine = line;
    }
    commitPara();

    console.log(`Page ${pageNum} detected ${paras.length} paragraphs:`);
    paras.forEach((p, idx) => {
      console.log(`\n[P${idx + 1}] (${p.type}, ${p.sents.length} sents): ${p.text.slice(0, 100)}...`);
    });
  }
}

testFullLayoutExtraction().catch(console.error);
