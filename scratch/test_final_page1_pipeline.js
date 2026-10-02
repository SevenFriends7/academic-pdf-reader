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

async function run() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;

  for (let pageNum = 1; pageNum <= 5; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();

    const rawSpans = textContent.items.map((it, idx) => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height,
      idx
    })).filter(s => s.text.trim());

    // 1. 过滤页眉页脚（如 PNAS 2021..., 顶端页码, 底部 doi, 纯栏名等）
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

    // 通栏图表注检测 (字号在 6.8 到 7.6 之间，或包含 Fig./Table)
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

    const topHeaders = [];
    const col1Spans = [];
    const col2Spans = [];
    const captionSpans = [];
    const footnoteSpans = [];

    spans.forEach(span => {
      const sx = span.x;
      const sy = span.y;
      const sh = span.h;

      if (pageNum === 1 && sy > 660 && sh > 15) {
        // 第一页大标题
        topHeaders.push(span);
      } else if (pageNum === 1 && sy >= 595) {
        // 第一页作者、单位、收稿编辑信息 -> 属于文章头元数据，严格排除在翻译卡片之外！
        return;
      } else if (sh <= 6.5 && sy < 160) {
        // 底部小字脚注、版权声明、作者贡献声明
        footnoteSpans.push(span);
      } else if (hasCaption && sy >= captionMinY && sy <= captionMaxY && sh <= 7.8) {
        captionSpans.push(span);
      } else if (sx < gutterX) {
        col1Spans.push(span);
      } else {
        col2Spans.push(span);
      }
    });

    function spansToLines(spanList) {
      const sorted = [...spanList].sort((a, b) => {
        // 首字下沉巨型大写字母 (Drop Cap, 如 "A", h > 18) 提升其排序 Y 至首行
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
    const captionLines = spansToLines(captionSpans);
    const footnoteLines = spansToLines(footnoteSpans);

    headerLines.forEach(l => l.section = 'header');
    col1Lines.forEach(l => l.section = 'col1');
    col2Lines.forEach(l => l.section = 'col2');
    captionLines.forEach(l => l.section = 'caption');
    footnoteLines.forEach(l => l.section = 'footnote');

    let orderedLines = [];
    if (captionLines.length > 0) {
      const capY = captionLines[0].y;
      const colTopY = Math.max(
        col1Lines.length > 0 ? col1Lines[0].y : 0,
        col2Lines.length > 0 ? col2Lines[0].y : 0
      );
      if (capY > colTopY) {
        orderedLines = [...headerLines, ...captionLines, ...col1Lines, ...col2Lines, ...footnoteLines];
      } else {
        orderedLines = [...headerLines, ...col1Lines, ...col2Lines, ...captionLines, ...footnoteLines];
      }
    } else {
      orderedLines = [...headerLines, ...col1Lines, ...col2Lines, ...footnoteLines];
    }

    // 组合段落
    const paras = [];
    let curParaLines = [];
    let curParaType = 'body';

    function commitParagraph() {
      if (curParaLines.length === 0) return;
      let cleanText = '';
      curParaLines.forEach(l => {
        l.spans.forEach(s => {
          const spanText = s.text || '';
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
          sentencesEn: splitEnglishSentencesSmart(cleanText)
        });
      }
      curParaLines = [];
      curParaType = 'body';
    }

    let prevLine = null;
    let normalLineHeight = 9.5;
    const normalHeights = orderedLines.map(l => l.h).filter(h => h > 5 && h < 13);
    if (normalHeights.length > 0) {
      normalLineHeight = normalHeights.reduce((a, b) => a + b, 0) / normalHeights.length;
    }

    for (let i = 0; i < orderedLines.length; i++) {
      const line = orderedLines[i];
      const text = line.spans.map(s => s.text).join(' ').trim();
      if (!text) continue;

      let shouldStartNew = false;
      let nextType = 'body';

      if (line.section === 'header') {
        nextType = 'title';
        if (curParaType !== 'title') shouldStartNew = true;
      } else if (line.section === 'caption') {
        nextType = 'caption';
        if (curParaType !== 'caption') {
          shouldStartNew = true;
        } else if (text.startsWith('Fig.') || text.startsWith('Figure') || text.startsWith('Table')) {
          shouldStartNew = true;
        }
      } else if (line.section === 'footnote') {
        nextType = 'metadata';
        if (curParaType !== 'metadata') {
          shouldStartNew = true;
        } else if (text.startsWith('The authors declare') || text.startsWith('This article contains')) {
          shouldStartNew = true;
        }
      } else {
        // 正文双栏区 (col1 / col2)
        const isAbstractStart = pageNum === 1 && text.startsWith('Daily life requires');
        const isKeywordLine = text.includes('|') || text.startsWith('Keywords') || text.startsWith('Index Terms');
        const isSignificanceHeading = text === 'Significance';
        const isSignificanceBody = text.startsWith('Many routine, inwardly');

        const hasDropCap = line.spans.some(s => s.h > 18 && s.text.trim().length === 1);
        const isHeading = !hasDropCap && (line.h > normalLineHeight * 1.3 && line.spans.length <= 4) || /^[0-9]\.\s+[A-Z]/.test(text) || text === 'Results' || text === 'Discussion';

        const isIndented = prevLine && (line.minX > prevLine.minX + 6);
        const prevEnded = curParaLines.length > 0 && /[.!?。！？]["'”)]?\s*$/.test(curParaLines[curParaLines.length - 1].spans.map(s => s.text).join(' ').trim());
        const isSameColumn = prevLine && prevLine.section === line.section;
        const largeVGap = isSameColumn && Math.abs(prevLine.y - line.y) > normalLineHeight * 1.45;

        if (isAbstractStart) {
          shouldStartNew = true; nextType = 'abstract';
        } else if (isKeywordLine) {
          if (curParaType !== 'keywords') { shouldStartNew = true; nextType = 'keywords'; }
        } else if (isSignificanceHeading || isSignificanceBody) {
          if (curParaType !== 'significance') { shouldStartNew = true; nextType = 'significance'; }
        } else if (isHeading) {
          shouldStartNew = true; nextType = 'heading';
        } else if (curParaType === 'abstract') {
          // 保持在摘要中，直到遇见关键词或大字下沉正文
          if (isKeywordLine || hasDropCap) {
            shouldStartNew = true;
            nextType = isKeywordLine ? 'keywords' : 'body';
          }
        } else if (curParaType === 'significance') {
          // 保持在意义框中，直到离开 col2 或遇见大间隔
          if (largeVGap && prevEnded) {
            shouldStartNew = true;
            nextType = 'body';
          }
        } else if (curParaType === 'keywords' && !isKeywordLine) {
          shouldStartNew = true; nextType = 'body';
        } else if (curParaType !== 'body') {
          shouldStartNew = true; nextType = 'body';
        } else if (curParaType === 'body') {
          if (isSameColumn && prevEnded && (isIndented || (largeVGap && /^[A-Z“"'(]/.test(text)))) {
            shouldStartNew = true; nextType = 'body';
          } else if (!isSameColumn && prevEnded && isIndented && /^[A-Z“"'(]/.test(text)) {
            shouldStartNew = true; nextType = 'body';
          }
        }
      }

      if (shouldStartNew) {
        commitParagraph();
        curParaType = nextType;
      }

      curParaLines.push(line);
      prevLine = line;
    }
    commitParagraph();

    let bodyCount = 0;
    paras.forEach(p => {
      if (p.type === 'body') {
        bodyCount++;
        p.bodyIndex = bodyCount;
      }
    });

    console.log(`\n================ PAGE ${pageNum} (${paras.length} 段落) ================`);
    paras.forEach((p, idx) => {
      const badge = p.type === 'body' ? `正文 第 ${p.bodyIndex} 段` : p.type;
      console.log(`[${badge}] (${p.sentencesEn.length} 句):`);
      console.log(`  "${p.text.slice(0, 110)}..."`);
    });
  }
}

run().catch(console.error);
