const fs=require('fs');
const pdfjsLib=require('../node_modules/pdfjs-dist/legacy/build/pdf.js');
const code=fs.readFileSync('media/viewer.js','utf8');
const s=code.indexOf('  const MATH_FONT_RE'), e=code.indexOf('  function buildPageMathModel');
const ML=new Function(code.slice(s,code.indexOf('\n  /**',e))+'\n return { buildPageMathModel, mathItemsToLatex };')();
(async()=>{
const data=new Uint8Array(fs.readFileSync('D:/kx/上海交大/梯度校正测验/梯度校正测验/AOT.pdf'));
const doc=await pdfjsLib.getDocument({data,useSystemFonts:false,disableFontFace:true}).promise;
const page=await doc.getPage(5);const tc=await page.getTextContent();await page.getOperatorList();
const f=k=>{try{const o=page.commonObjs.get(k);return o&&o.name?o.name:String(k)}catch(_){return String(k)}};
const m=ML.buildPageMathModel(tc.items,f,10);
const r=m.runs.find(x=>/AttID/.test(x.latex));
const its=r.items.map(i=>({str:i.str,x:+i.x.toFixed(2),y:+i.y.toFixed(2),size:+i.size.toFixed(2),w:+i.width.toFixed(2)}));
console.log('n=',its.length);
console.log(JSON.stringify(its.slice(0,6)));
console.log('direct=', JSON.stringify(ML.mathItemsToLatex(r.items.map(i=>({str:i.str,transform:[1,0,0,1,i.x,i.y],width:i.width,height:i.size})))));
})();
