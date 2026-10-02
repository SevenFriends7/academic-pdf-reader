const fs = require('fs');
const content = fs.readFileSync('src/pdfEditorProvider.ts', 'utf8');
const startIdx = content.indexOf('<!DOCTYPE html>');
const endIdx = content.lastIndexOf('</html>') + 7;
const html = content.slice(startIdx, endIdx);

const regex = /<\/?([a-zA-Z0-9\-]+)[^>]*>/g;
let m;
const stack = [];
const errors = [];
while ((m = regex.exec(html)) !== null) {
  const full = m[0];
  const tag = m[1].toLowerCase();
  if (full.endsWith('/>') || ['link', 'meta', 'br', 'hr', 'img', 'input', 'circle', 'path', 'rect', 'line', 'polyline'].includes(tag)) continue;
  if (full.startsWith('</')) {
    const last = stack.pop();
    if (last !== tag) {
      errors.push(`Mismatch! expected </${last}> but got ${full} at offset ${m.index}`);
    }
  } else {
    stack.push(tag);
  }
}
console.log('Errors:', errors);
console.log('Unclosed tags:', stack);
