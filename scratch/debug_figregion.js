const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');

const start = code.indexOf('(function markFigureRegions() {');
const end = code.indexOf('})();', start);
const snippet = code.slice(start, end + 5);

const RAW = [
  [706, 113, 488, 'Memory:Past frames with object maskQuery:Current frame'],
  [669, 131, 240, '……'],
  [617, 78, 515, '!"#%!"#%!"#%!"#$&\'#'],
  [611, 427, 467, 'Skip-connections'],
  [606, 306, 364, 'MemoryQuery'],
  [598, 307, 366, 'EncoderEncoder'],
  [591, 514, 537, 'Decoder'],
  [578, 126, 436, 'MemoryQuery'],
  [570, 123, 450, 'embeddingembedding'],
  [561, 72, 407, 'KeyValueKeyValueKeyValueKeyValue'],
  [550, 492, 522, 'Space-time'],
  [540, 175, 526, 'concat.Memory Read'],
  [528, 74, 127, ': Intermediate output'],
  [504, 50, 545, 'Figure 2: Overview of our framework. Our network consists of two encoders'],
  [492, 50, 545, 'space-time memory read block, and a decoder. The memory encoder takes an RGB frame'],
  [480, 50, 545, 'object mask is represented as a probability map used for estimated object masks.'],
  [468, 50, 208, '(EncQ) takes the query image as input.'],
  [434, 50, 545, '3. Space-Time Memory Networks (STM) The keys and values further go through our'],
  [422, 309, 545, 'memory read block. Every pixel on the key feature maps of the query and the'],
  [410, 62, 545, 'In our framework, video frames are sequentially processed starting from the second'],
  [398, 50, 545, 'frame using the ground truth annotation given in the first frame. During the video']
];

const lines = RAW.map(([y, minX, maxX, text]) => ({
  y,
  minX,
  maxX,
  h: 9,
  spans: [{ textContent: text }],
  section: /^Figure 2:/.test(text) ? 'caption' : /^\(EncQ\)/.test(text) ? 'caption' : 'col1'
}));
lines.push({
  y: 386,
  minX: 50,
  maxX: 290,
  h: 9,
  spans: [{ textContent: 'reference body line spanningthewhole column width for calibration purposes' }],
  section: 'col1'
});

const re = /^(?:[(\[](?:[a-h]|\d{1,2})[)\]]\s+)?(?:(?:Extended\s+Data|Supplement(?:ary|al)?|SI)\s+)?(?:Fig(?:\.|ure)?|Tab(?:\.|le)?|Box|Algorithm|Scheme|Chart|Exhibit|TABLE)\s*\.?\s*(?:\d+|[IVXLCDM]+)(?:\s*[.:：)—–-])?/i;

// 复刻产物逻辑，但每步打印
const colMaxExtent = {};
lines.forEach(l => {
  if (l.section !== 'col1' && l.section !== 'col2') return;
  const w = l.maxX - l.minX;
  if (!colMaxExtent[l.section] || w > colMaxExtent[l.section]) colMaxExtent[l.section] = w;
});
console.log('各栏满行基准:', JSON.stringify(colMaxExtent));
const textOf = l => l.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
const definitelyBody = line => {
  const t = textOf(line);
  if (!t) return false;
  if (t.length > 80) return '过长(>80)';
  if (/^(\d+(\.\d+)*\.?|[IVXLC]+\.)\s+[A-Z]/.test(t)) return '章节标题';
  if (/^(abstract|introduction|related work|background|method|methods|methodology|approach|experiments?|results?|discussion|conclusions?|references)\b/i.test(t)) return '章节名';
  if (/[.!?。！？]\s*$/.test(t)) return '句末标点';
  const w = line.maxX - line.minX;
  const m = colMaxExtent[line.section];
  if (m && w >= 150 && w >= m * 0.8) return `满行(w=${w},阈值=${(m * 0.8).toFixed(0)})`;
  return false;
};

const cap = lines.find(l => l.section === 'caption' && re.test(textOf(l)));
console.log('图注基准行 y=', cap.y, '|', textOf(cap).slice(0, 40));
const above = lines
  .filter(l => l !== cap && l.y > cap.y && l.y - cap.y <= 320)
  .filter(l => !(l.maxX < cap.minX - 20 || l.minX > cap.maxX + 20))
  .sort((a, b) => a.y - b.y);
console.log('');
console.log('向上扫描顺序与判定：');
for (const l of above) {
  const d = definitelyBody(l);
  console.log(
    `  y=${String(l.y).padStart(3)} w=${String(l.maxX - l.minX).padStart(3)} ${d ? '【停止: ' + d + '】' : '标记为图表标签'}  ${textOf(l).slice(0, 42)}`
  );
  if (d) break;
}
