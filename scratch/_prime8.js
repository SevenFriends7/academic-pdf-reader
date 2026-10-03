globalThis.__MATH_PRIME_DBG = true;
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
ML.buildPageMathModel(tc.items,f,10);
})();
