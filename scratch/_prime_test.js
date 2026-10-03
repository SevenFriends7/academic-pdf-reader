const fs=require('fs'),path=require('path');
const pdfjsLib=require('../node_modules/pdfjs-dist/legacy/build/pdf.js');
const code=fs.readFileSync('media/viewer.js','utf8');
const s=code.indexOf('  const MATH_FONT_RE'), e=code.indexOf('  function buildPageMathModel');
const ML=new Function(code.slice(s,code.indexOf('\n  /**',e))+'\n return { mathItemsToLatex, mathCharToLatex };')();
const mk=(str,x,y,size,w,font)=>({str,width:w,height:size,transform:[size,0,0,size,x,y],font});
const items=[
 mk('V',141.22,425.35,9.96,5.81,'CMMI10'),
 mk('\u2032',149.24,429.46,6.97,2.30,'CMSY7'),
 mk('=',154.80,425.35,9.96,7.75,'CMR10'),
 mk('AttID',165.32,425.35,9.96,28.08,'CMMI10')
];
console.log('latex=', JSON.stringify(ML.mathItemsToLatex(items)));
console.log('prime maps to:', JSON.stringify(ML.mathCharToLatex('\u2032')));
