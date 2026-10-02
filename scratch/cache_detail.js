const fs = require('fs');
const path = require('path');
const APP = process.env.APPDATA + '\\Antigravity IDE\\User';
const dir = APP + '\\globalStorage\\paper-reader.academic-pdf-reader';

const settingsMtime = fs.statSync(APP + '\\settings.json').mtime;
console.log('settings.json 最后修改:', settingsMtime.toLocaleString());
const s = JSON.parse(fs.readFileSync(APP + '\\settings.json', 'utf8'));
console.log('  translationService =', s['academicReader.translationService']);
console.log('  modelName          =', s['academicReader.modelName']);
console.log('  apiEndpoint        =', s['academicReader.apiEndpoint']);
console.log('  geminiModel        =', s['academicReader.geminiModel'] || '(未设置，用默认)');
console.log('');

const NEW_KEY = /^\d+_[0-9a-f]+-\d+$/;
const cjk = x => ((x || '').match(/[\u4e00-\u9fff]/g) || []).length;
const latin = x => ((x || '').match(/[A-Za-z]/g) || []).length;

for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
  const full = path.join(dir, f);
  const j = JSON.parse(fs.readFileSync(full, 'utf8'));
  const tr = j.translations || {};
  const st = j.sentenceTranslations || {};
  const al = j.alignment || {};

  const newKeys = Object.keys(tr).filter(k => NEW_KEY.test(k));
  if (newKeys.length === 0) continue; // 只分析新代码写的

  console.log('='.repeat(74));
  console.log(`${f}  (mtime ${fs.statSync(full).mtime.toLocaleString()})`);
  console.log(`  新格式翻译条目: ${newKeys.length}`);

  const byPage = {};
  newKeys.forEach(k => {
    const p = Number(k.split('_')[0]);
    (byPage[p] = byPage[p] || []).push(k);
  });

  for (const p of Object.keys(byPage).sort((a, b) => a - b)) {
    const keys = byPage[p];
    console.log(`\n  ---- 第 ${p} 页：${keys.length} 段有译文 ----`);
    keys.forEach(k => {
      const v = String(tr[k] || '');
      const c = cjk(v);
      const l = latin(v);
      const ratio = c + l > 0 ? c / (c + l) : 0;
      const sent = st[k];
      const sentInfo = Array.isArray(sent) ? `逐句 ${sent.length} 条` : '无逐句';
      const a = al[k] || {};
      const flags = [];
      if (l > 20 && ratio < 0.3) flags.push('⚠照搬英文');
      if (v.length < 12) flags.push('⚠过短');
      if (ratio >= 0.3 && ratio < 0.6) flags.push('中英混杂');
      if (a.aligned === false) flags.push(`未对齐(${a.mode || '?'})`);
      console.log(
        `    ${k.padEnd(18)} 中文${(ratio * 100).toFixed(0).padStart(3)}%  长度${String(v.length).padStart(4)}  ${sentInfo.padEnd(10)} ${flags.join(' ')}`
      );
      if (flags.length) console.log(`        内容: ${v.slice(0, 110)}`);
      if (a.note) console.log(`        备注: ${String(a.note).slice(0, 110)}`);
    });
  }
}
