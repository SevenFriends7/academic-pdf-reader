const fs = require('fs');
const p = "C:/Users/paroxetine/AppData/Roaming/Antigravity IDE/User/globalStorage/paper-reader.academic-pdf-reader/paper_bffd2a00e397d6c1cbca9492a9d7b3d9.json";
if (fs.existsSync(p)) {
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  let modified = false;
  if (data.sentenceTranslations) {
    for (const [k, arr] of Object.entries(data.sentenceTranslations)) {
      if (Array.isArray(arr) && arr.some(s => !s || !s.trim())) {
        console.log('Cleaning broken sentenceTranslations key:', k);
        delete data.sentenceTranslations[k];
        modified = true;
      }
    }
  }
  if (modified) {
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    console.log('Successfully repaired paper_bffd2a00e397d6c1cbca9492a9d7b3d9.json on disk.');
  } else {
    console.log('No broken sentence translations found or already cleaned.');
  }
}
