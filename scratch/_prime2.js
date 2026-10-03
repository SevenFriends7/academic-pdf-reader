const fs=require('fs');
const pdfjsLib=require('../node_modules/pdfjs-dist/legacy/build/pdf.js');
const code=fs.readFileSync('media/viewer.js','utf8');
const s=code.indexOf('  const MATH_FONT_RE'), e=code.indexOf('  function buildPageMathModel');
const ML=new Function(code.slice(s,code.indexOf('\n  /**',e))+'\n return { buildPageMathModel };')();
(async()=>{
const data=new Uint8Array(fs.readFileSync('D:/kx/上海交大/梯度校正测验/梯度校正测验/AOT.pdf'));
const doc=await pdfjsLib.getDocument({data,useSystemFonts:false,disableFontFace:true}).promise;
const page=await doc.getPage(5);const tc=await page.getTextContent();await page.getOperatorList();
const f=k=>{try{const o=page.commonObjs.get(k);return o&&o.name?o.name:String(k)}catch(_){return String(k)}};
const m=ML.buildPageMathModel(tc.items,f,10);
const r=m.runs.find(x=>/AttID/.test(x.latex));
console.log('latex=', JSON.stringify(r.latex));
console.log('items=', r.items.map(i=>i.str).join(' | '));
const pm = r.items.find(i=>/\u2032/.test(i.str));
console.log('prime item:', JSON.stringify(pm && {str:pm.str, x:pm.x, y:pm.y, size:pm.size, w:pm.width, font:pm.font}));
})();
