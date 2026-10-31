const fs = require('fs');
const readline = require('readline');

async function searchTranscript() {
  const p = 'C:/Users/frog/.gemini/antigravity/brain/553a2790-9509-4ceb-b857-f61743ebb7a8/.system_generated/logs/transcript_full.jsonl';
  if (!fs.existsSync(p)) return;
  const fileStream = fs.createReadStream(p);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const idx = line.indexOf('"annotations":[');
    if (idx !== -1) {
      const slice = line.slice(idx, idx + 80);
      if (!slice.startsWith('"annotations":[]')) {
        console.log('Line', lineNo, slice);
      }
    }
  }
  console.log('Finished.');
}
searchTranscript();
