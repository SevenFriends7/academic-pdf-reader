const fs = require('fs');
const path = require('path');
const dir =
  process.env.APPDATA + '\\Antigravity IDE\\User\\globalStorage\\paper-reader.academic-pdf-reader';

const NEW_KEY = /^\d+_[0-9a-f]+-\d+$/; // 新格式：{page}_{fnv十六进制}-{字符数}

for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
  const full = path.join(dir, f);
  const stat = fs.statSync(full);
  const j = JSON.parse(fs.readFileSync(full, 'utf8'));
  const tr = j.translations || {};
  const keys = Object.keys(tr);

  const newKeys = keys.filter(k => NEW_KEY.test(k));
  const cjk = s => ((s || '').match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = s => ((s || '').match(/[A-Za-z]/g) || []).length;

  console.log('='.repeat(70));
  console.log(`${f}   (mtime ${stat.mtime.toLocaleString()})`);
  console.log(`  translations: ${keys.length}  其中新格式指纹键: ${newKeys.length}`);
  console.log(`  最后插入的 6 个键（= 最近写的）:`);
  keys.slice(-6).forEach(k => {
    const v = String(tr[k] || '');
    const ratio = cjk(v) + latin(v) > 0 ? cjk(v) / (cjk(v) + latin(v)) : 0;
    const flag = NEW_KEY.test(k) ? '[新]' : '[旧]';
    const warn = latin(v) > 20 && ratio < 0.3 ? '  <== 疑似照搬英文' : '';
    console.log(`    ${flag} ${k}  →  中文字符占比 ${(ratio * 100).toFixed(0)}%  | ${v.slice(0, 46)}${warn}`);
  });

  const englishish = keys.filter(k => {
    const v = String(tr[k] || '');
    const l = latin(v);
    const c = cjk(v);
    return l > 20 && c / (l + c) < 0.3;
  });
  if (englishish.length) {
    console.log(`  疑似照搬英文的条目 ${englishish.length} 个：`);
    englishish.slice(0, 5).forEach(k => {
      console.log(`    ${k} → ${String(tr[k]).slice(0, 100)}`);
    });
  }
}
