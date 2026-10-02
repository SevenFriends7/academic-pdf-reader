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
    const lastWord = candidate.split(/\s+/).pop() || '';
    if (abbrRegex.test(lastWord) || /\b[A-Z]\.$/.test(lastWord)) {
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

const testText = 'Daily life requires transitions between performance of well-practiced, automatized behaviors reliant upon internalized representations and behaviors requiring external focus. Such transitions involve differential activation of the default mode network (DMN), a group of brain areas associated with inward focus. We asked how optogenetic modulation of the ventral pallidum (VP), a subcortical DMN node, impacts task switching between internally to externally guided lever-pressing behavior in the rat. Excitation of the VP dramatically compromised acquisition of an auditory discrimination task, trapping animals in a DMN state of automatized internally focused behavior and impairing their ability to direct attention to external sensory stimuli. VP inhibition, on the other hand, facilitated task acquisition, expediting escape from the DMN brain state, thereby allowing rats to incorporate the contingency changes associated with the auditory stimuli. We suggest that VP, instant by instant, regulates the DMN and plays a deterministic role in transitions between internally and externally guided behaviors.';

const sents = splitEnglishSentencesSmart(testText);
console.log('Total sentences:', sents.length);
sents.forEach((s, idx) => console.log(idx, JSON.stringify(s.text.slice(0, 45))));
