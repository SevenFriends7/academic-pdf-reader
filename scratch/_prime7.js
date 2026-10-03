const fs=require('fs');
const pdfjsLib=require('../node_modules/pdfjs-dist/legacy/build/pdf.js');
let code=fs.readFileSync('media/viewer.js','utf8');
const s=code.indexOf('  const MATH_FONT_RE'), e=code.indexOf('  function buildPageMathModel');
let snip=code.slice(s,code.indexOf('\n  /**',e));
snip=snip.replace("          if (it.isAccent) { host.accent = mathCharToLatex(it.str); return; }",
 "          if (globalThis.__D && String(it.str).indexOf('\\u2032')>=0) console.log('[PRIME]', JSON.stringify({ly:+it.ly.toFixed(2), lx:+it.lx.toFixed(2), hostStr:String(host.str).slice(0,6), hostX:+host.x.toFixed(2), nChars:chars.length}));\n          if (it.isAccent) { host.accent = mathCharToLatex(it.str); return; }");
globalThis.__D=true;
const ML=new Function(snip+'\n return { buildPageMathModel };')();
(async()=>{
const data=new Uint8Array(fs.readFileSync('D:/kx/上海交大/梯度校正测验/梯度校正测验/AOT.pdf'));
const doc=await pdfjsLib.getDocument({data,useSystemFonts:false,disableFontFace:true}).promise;
const page=await doc.getPage(5);const tc=await page.getTextContent();await page.getOperatorList();
const f=k=>{try{const o=page.commonObjs.get(k);return o&&o.name?o.name:String(k)}catch(_){return String(k)}};
ML.buildPageMathModel(tc.items,f,10);
})();
