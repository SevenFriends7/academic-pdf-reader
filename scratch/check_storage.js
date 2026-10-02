const fs = require('fs');
const path = require('path');

const dir = 'C:/Users/paroxetine/AppData/Roaming/Antigravity IDE/User/globalStorage/paper-reader.academic-pdf-reader';
if (fs.existsSync(dir)) {
  const files = fs.readdirSync(dir);
  console.log('Files in storage:', files);
  files.forEach(f => {
    if (f.endsWith('.json')) {
      const p = path.join(dir, f);
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      console.log(`\n--- ${f} ---`);
      console.log('pdfPath:', data.pdfPath);
      console.log('translations keys:', Object.keys(data.translations || {}));
      Object.keys(data.translations || {}).forEach(k => {
        console.log(`  [${k}]: ${String(data.translations[k]).slice(0, 80)}...`);
      });
    }
  });
} else {
  console.log('Dir does not exist:', dir);
}
