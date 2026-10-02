const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

function testCompleteParser() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  return pdfjsLib.getDocument({data}).promise.then(async (doc) => {
    console.log(`Document loaded: ${doc.numPages} pages.`);

    for (let pageNum = 1; pageNum <= Math.min(5, doc.numPages); pageNum++) {
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

      // 2. 检测双栏分界线
      const midX = viewport.width / 2;
      let gutterX = 285;
      const bodySpans = spans.filter(s => s.w > 60 && s.w < 260 && s.y < 580);
      const leftSpans = bodySpans.filter(s => s.x < midX - 20);
      const rightSpans = bodySpans.filter(s => s.x > midX - 20);
      const isTwoCol = leftSpans.length > 5 && rightSpans.length > 5;

      if (isTwoCol) {
        const maxLeft = Math.max(...leftSpans.map(s => s.x + s.w));
        const minRight = Math.min(...rightSpans.map(s => s.x));
        if (minRight > maxLeft) {
          gutterX = (maxLeft + minRight) / 2;
        }
      }

      // 3. 将 Spans 按区域分流 (Header -> Col1 -> Col2 -> Captions -> Footnotes)
      const headerSpans = [];
      const col1Spans = [];
      const col2Spans = [];
      const captionSpans = [];
      const footnoteSpans = [];

      spans.forEach(s => {
        if (pageNum === 1 && s.y >= 600) {
          headerSpans.push(s);
        } else if (s.h <= 6.5 && s.y < 160) {
          footnoteSpans.push(s);
        } else if (s.w > 320 && s.x < 150) {
          // 跨双栏通栏大图/表格标题 (如 Page 2 图注)
          captionSpans.push(s);
        } else if (isTwoCol) {
          if (s.x < gutterX) {
            col1Spans.push(s);
          } else {
            col2Spans.push(s);
          }
        } else {
          col1Spans.push(s);
        }
      });

      // 4. 每个区域内部独立行排序 (绝对不会把左栏和右栏合并为同一行！)
      function spansToLines(spanList) {
        const sorted = [...spanList].sort((a, b) => {
          if (Math.abs(a.y - b.y) > 3.5) return b.y - a.y; // 物理坐标 Y 递减为向下
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
      const captionLines = spansToLines(captionSpans);
      const footnoteLines = spansToLines(footnoteSpans);

      // 顺序：顶栏 -> 左栏完整流 -> 右栏完整流 -> 通栏图表注 -> 尾注
      const orderedLines = [...headerLines, ...col1Lines, ...col2Lines, ...captionLines, ...footnoteLines];

      console.log(`\n================================================================`);
      console.log(`PAGE ${pageNum} (Total Lines: ${orderedLines.length}):`);
      console.log(`  Header: ${headerLines.length}, Col1: ${col1Lines.length}, Col2: ${col2Lines.length}, Captions: ${captionLines.length}, Footnotes: ${footnoteLines.length}`);
      
      // 提取段落
      const paras = [];
      let curParaLines = [];
      let curParaType = 'body';

      function commit() {
        if (curParaLines.length === 0) return;
        let cleanText = '';
        curParaLines.forEach(l => {
          l.spans.forEach(s => {
            let str = s.text;
            if (cleanText.length > 0) {
              const last = cleanText[cleanText.length - 1];
              if (last === '-' || last === '‐') {
                cleanText = cleanText.slice(0, -1);
              } else if (!/\s$/.test(last) && !/^\s/.test(str) && !/^[,.;:!?’”')\]]/.test(str)) {
                cleanText += ' ';
              }
            }
            cleanText += str;
          });
        });
        cleanText = cleanText.trim();
        if (cleanText) {
          paras.push({ type: curParaType, text: cleanText });
        }
        curParaLines = [];
        curParaType = 'body';
      }

      let prevLine = null;
      for (let i = 0; i < orderedLines.length; i++) {
        const line = orderedLines[i];
        const text = line.spans.map(s => s.text).join(' ').trim();
        if (!text) continue;

        const isTitle = pageNum === 1 && i < 4 && line.h > 15;
        const isAbstract = pageNum === 1 && text.startsWith('Daily life requires');
        const isKeywords = text.includes('|') || text.startsWith('Keywords') || text.startsWith('Index Terms');
        const isSignificance = text === 'Significance' || text.startsWith('Significance');
        const isHeading = line.h > 12 || /^[0-9]\.\s+[A-Z]/.test(text) || text === 'Results' || text === 'Discussion';
        const isFootnote = line.h <= 6.5 && (text.startsWith('Author contributions') || text.startsWith('The authors declare'));

        const prevEnded = curParaLines.length > 0 && /[.!?。！？]["'”)]?\s*$/.test(curParaLines[curParaLines.length - 1].spans.map(s => s.text).join(' ').trim());
        const isIndented = prevLine && (line.minX > prevLine.minX + 6);
        const largeGap = prevLine && Math.abs(prevLine.y - line.y) > 13;

        let shouldStart = false;
        let nextType = 'body';

        if (isTitle) {
          if (curParaType !== 'title') { shouldStart = true; nextType = 'title'; }
        } else if (isAbstract) {
          shouldStart = true; nextType = 'abstract';
        } else if (isKeywords) {
          shouldStart = true; nextType = 'keywords';
        } else if (isSignificance) {
          shouldStart = true; nextType = 'significance';
        } else if (isHeading) {
          shouldStart = true; nextType = 'body';
        } else if (isFootnote) {
          shouldStart = true; nextType = 'metadata';
        } else if (largeGap || (prevEnded && isIndented)) {
          shouldStart = true; nextType = 'body';
        }

        if (shouldStart) {
          commit();
          curParaType = nextType;
        }

        curParaLines.push(line);
        prevLine = line;
      }
      commit();

      console.log(`Detected ${paras.length} paragraphs on Page ${pageNum}:`);
      paras.forEach((p, idx) => {
        console.log(`  [P${idx + 1}] (${p.type}): ${p.text.slice(0, 90)}...`);
      });
    }
  });
}

testCompleteParser().catch(console.error);
