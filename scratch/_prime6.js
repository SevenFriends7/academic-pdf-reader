const fs=require('fs');
let code=fs.readFileSync('media/viewer.js','utf8');
const s=code.indexOf('  const MATH_FONT_RE'), e=code.indexOf('  function buildPageMathModel');
let snip=code.slice(s,code.indexOf('\n  /**',e));
snip=snip.replace("      if (chars.length === 0) return '';", "      if (chars.length === 0) return '';\n      if (globalThis.__D && baseRow.length && baseRow[0].str === 'V' && allItems.length > 10) console.log('[BASE]', JSON.stringify({n:baseRow.length, all:allItems.length, chars:chars.map(c=>[c.str,+c.x.toFixed(2)]), scripts:allItems.filter(x=>!baseRow.includes(x)).map(x=>[x.str,+x.x.toFixed(2),+x.size.toFixed(2)])}));");
globalThis.__D=true;
const ML=new Function(snip+'\n return { mathItemsToLatex };')();
const mk=(str,x,y,size,w)=>({str,width:w,height:size,transform:[size,0,0,size,x,y]});
// 用真实 24 项的前 6 项 + 假尾巴凑数，验证 baseRow / chars 结构
const items=[mk('V',141.22,425.35,9.96,5.81),mk('′',149.24,429.46,6.97,2.30),mk('=',154.80,425.35,9.96,7.75),mk('AttID',165.32,425.35,9.96,28.08),mk('(',193.67,425.35,9.96,3.87),mk('Q, K, V, Y',197.55,425.35,9.96,41.92),
mk('|',241.69,425.35,9.96,2.77),mk('D',244.46,425.35,9.96,8.25),mk(')=',252.71,425.35,9.96,7.00),mk('Att',259.71,425.35,9.96,12.00),mk('(',271.71,425.35,9.96,3.87)];
console.log(JSON.stringify(ML.mathItemsToLatex(items)));
