const fs = require('fs');
const p = 'C:/Users/frog/AppData/Roaming/Code/User/globalStorage/paper-reader.academic-pdf-reader/paper_c99198c2f0d2dc556fc6b47f7945fb5f.json';
if (!fs.existsSync(p)) {
  console.log('File does not exist:', p);
  process.exit(0);
}
const data = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('Top keys:', Object.keys(data));
if (data.pageArchive) {
  console.log('pageArchive pages:', Object.keys(data.pageArchive));
  if (data.pageArchive['4']) {
    console.log('page 4 count:', data.pageArchive['4'].length);
    data.pageArchive['4'].forEach((it, i) => {
      if (it.type === 'formula' || (it.cleanText && it.cleanText.includes('B('))) {
        console.log(`[${i}] type=${it.type}, len=${(it.cleanText||'').length}`);
        console.log('cleanText:', (it.cleanText||'').slice(0, 150));
        console.log('raw:', (it.raw||'').slice(0, 150));
      }
    });
  }
}
