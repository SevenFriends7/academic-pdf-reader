const fs = require('fs');
const p = 'C:/Users/frog/AppData/Roaming/Code/User/globalStorage/paper-reader.academic-pdf-reader/paper_c99198c2f0d2dc556fc6b47f7945fb5f.json';
const data = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('Item [23] on page 4:');
console.log(JSON.stringify(data.pageArchive['4'][23], null, 2));
