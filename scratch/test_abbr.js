
const textWithAbbr = "Smith et al. (2020) demonstrated that optogenetic stimulation (e.g., 20 Hz) enhances learning. As shown in Fig. 1, this effect was significant (p < 0.01). Furthermore, Klaassen et al. confirmed the findings.";

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
    if (/\b(et al|e\.g|i\.e|fig|figs|ref|refs|vol|no|pp|dr|mr|mrs|ms|vs|approx|min|sec|ca)\.$/i.test(cleanCandidate) || /\b[A-Z]\.$/.test(cleanCandidate)) {
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

const res = splitEnglishSentencesSmart(textWithAbbr);
console.log('Result count:', res.length);
res.forEach((r, i) => console.log(i, r.text));
