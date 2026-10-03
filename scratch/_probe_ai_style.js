/**
 * 一次性排查：看 AI 回答里"变量/公式"到底是用 `$...$` 写的还是用反引号 `` ` `` 写的。
 * 用法：node scratch/_probe_ai_style.js [关键词]
 */
const fs = require('fs');
const path = require('path');
const dir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'paper-reader.academic-pdf-reader');
const needle = process.argv[2] || 'AttLT';
let hits = 0;
fs.readdirSync(dir)
  .filter(f => f.startsWith('paper_') && f.endsWith('.json'))
  .forEach(f => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const name = path.basename(j.pdfPath || f);
    const list = Array.isArray(j.aiQa) ? j.aiQa : Object.values(j.aiQa || {});
    list.forEach((qa, i) => {
      const a = String((qa && qa.answer) || '');
      if (!a.includes(needle)) return;
      hits++;
      const codes = (a.match(/`[^`\n]+`/g) || []);
      const maths = (a.match(/\$[^$\n]+\$/g) || []).filter(m => true);
      console.log(`\n==== ${name} #${i}  Q=${JSON.stringify(String(qa.question || '').slice(0, 50))}`);
      console.log(`   反引号代码片段 ${codes.length} 个；$...$ 数学片段 ${maths.length} 个`);
      console.log('   反引号片段样例: ' + JSON.stringify(codes.slice(0, 22)));
      console.log('   $ 片段样例: ' + JSON.stringify(maths.slice(0, 10)));
      // 反引号内容里"像数学"的比例
      const mathLike = codes.filter(c => /^`[A-Za-z][A-Za-z0-9]*(?:[_^][A-Za-z0-9{}]+)*[A-Za-z0-9]*`$/.test(c) || /[_^]/.test(c));
      console.log(`   其中"像变量/公式"的 ${mathLike.length} 个: ${JSON.stringify(mathLike.slice(0, 22))}`);
      console.log('   ---- 回答前 600 字 ----\n' + a.slice(0, 600).replace(/\n/g, '\n   '));
    });
  });
console.log(`\n命中 ${hits} 条回答`);
