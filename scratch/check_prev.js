const fs = require('fs');
const readline = require('readline');

async function main() {
  const fileStream = fs.createReadStream('C:\\Users\\paroxetine\\.gemini\\antigravity-ide\\brain\\b2ff1737-eb96-4bb8-a1f8-7f589a549207\\.system_generated\\logs\\transcript.jsonl');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  
  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'USER_INPUT') {
        console.log('USER:', obj.content);
      }
    } catch(e) {}
  }
}
main();
