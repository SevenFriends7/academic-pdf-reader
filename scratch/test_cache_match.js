const fs = require('fs');
const path = require('path');

const storagePath = 'C:/Users/paroxetine/AppData/Roaming/Antigravity IDE/User/globalStorage/paper-reader.academic-pdf-reader/paper_d4aafa09d44ec2a8cce2468ec0ba2e77.json';
const paperData = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));

function findCachedTranslation(pageNum, text) {
  const sig = text.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  if (!sig) return '';
  const directKey = `${pageNum}_${sig}`;
  if (paperData.translations[directKey]) return paperData.translations[directKey];

  for (const k of Object.keys(paperData.translations || {})) {
    if (k.startsWith(`${pageNum}_`) && k.includes(sig) && sig.length >= 10) {
      return paperData.translations[k];
    }
  }
  return '';
}

const page1Paras = [
  { type: 'title', text: "Ventral pallidum regulates the default mode network, controlling transitions between internally and externally guided behavior" },
  { type: 'abstract', text: "Daily life requires transitions between performance of well-practiced, automatized behaviors reliant upon internalized representations and behaviors requiring external focus." },
  { type: 'keywords', text: "default mode network | ventral pallidum | basal forebrain | anterior cingulate cortex | operant behavior" },
  { type: 'body 1', text: "A considerable amount of our time is spent performing automatic or habitual behaviors that are based on acquired knowledge about our environment." },
  { type: 'body 2', text: "Recently, it has been suggested that the rapid performance of learned responses in a stable behavioral context is associated with activation of the default mode network (DMN)" },
  { type: 'body 3', text: "The DMN encompasses significant portions of the medial frontal and medial parietal cortex, but recent tractography work in humans has revealed that some subcortical brain structures also represent important DMN nodes" },
  { type: 'significance', text: "Significance Many routine, inwardly focused behaviors require little attention and can be carried out automatically." }
];

console.log('Testing resolution for Page 1 paragraphs:');
page1Paras.forEach(p => {
  const trans = findCachedTranslation(1, p.text);
  console.log(`\n[${p.type}] -> ${trans ? 'FOUND: ' + trans.slice(0, 50) + '...' : 'NOT FOUND'}`);
});
