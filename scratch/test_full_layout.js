const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

function splitEnglishSentencesSmart(text) {
  if (!text) return [];
  const abbrRegex = /\b(e\.g|i\.e|et al|fig|figs|ref|refs|vol|no|pp|dr|mr|mrs|ms|vs|approx|min|sec|ca)\.$/i;
  const rawSentences = [];
  let start = 0;
  const endRegex = /([.?!]["'”)]?)\s+(?=[A-Z0-9“"'(])/g;
  let match;
  while ((match = endRegex.exec(text)) !== null) {
    const endPos = match.index + match[1].length;
    const candidate = text.slice(start, endPos).trim();
    const cleanCandidate = candidate.trim();
    if (abbrRegex.test(cleanCandidate) || /\b[A-Z]\.$/.test(cleanCandidate)) {
      continue;
    }
    if (candidate) {
      rawSentences.push({ text: candidate, startIdx: start, endIdx: endPos });
    }
    start = match.index + match[0].length;
  }
  const remaining = text.slice(start).trim();
  if (remaining) {
    rawSentences.push({ text: remaining, startIdx: start, endIdx: text.length });
  }
  return rawSentences;
}

async function testFullPdf() {
  const data = new Uint8Array(fs.readFileSync('林宇祥Ventral pallidum regulates the default mode network,controlling transitions between internally and externally guided behavior.pdf'));
  const doc = await pdfjsLib.getDocument({data}).promise;
  console.log('Doc pages:', doc.numPages);
  
  for (let pageNum = 1; pageNum <= 3; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(it => it.str.trim());
    
    console.log(`\n--- Page ${pageNum} Items: ${items.length} ---`);
    // 测试句子切分
    const fullText = items.map(it => it.str).join(' ');
    const sents = splitEnglishSentencesSmart(fullText);
    console.log(`Page ${pageNum} sentences count: ${sents.length}`);
    for (let s = 0; s < Math.min(3, sents.length); s++) {
      console.log(`  Sent ${s}: ${sents[s].text.slice(0, 50)}...`);
    }
  }
}

testFullPdf().catch(console.error);
