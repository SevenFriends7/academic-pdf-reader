/**
 * notesStorage 的"文件搬家后自动认领批注"回归测试（在临时目录里真跑文件读写）。
 *
 * 【为什么必须有】真实事故：扩展的存储键是 **PDF 绝对路径的 MD5**，
 * 用户把 PDF 从 `…\梯度校正测验\梯度校正测验\` 挪到 `…\梯度校正测验\文献\` 之后键就变了，
 * 插件以为是一篇新论文——**STM 36 条 / AOT 26 条 / cycle 27 条批注在界面上全部"消失"**
 * （数据其实还在旧键文件里）。本测试把"移动后必须自动找回"钉死。
 *
 * 用法：node scratch/dstest/notes_migration_test.js
 * 依赖：先 `npx tsc src/notesStorage.ts --outDir scratch/dstest/out-storage --module commonjs --target es2020 --skipLibCheck --esModuleInterop`
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, 'out-storage', 'notesStorage.js');
if (!fs.existsSync(OUT)) {
  console.error(`缺少编译产物 ${OUT}\n请先运行：\n  npx tsc src/notesStorage.ts --outDir scratch/dstest/out-storage --module commonjs --target es2020 --skipLibCheck --esModuleInterop`);
  process.exit(2);
}
const { NotesStorageManager } = require(OUT);

let pass = 0;
let fail = 0;
const check = (label, ok, extra) => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  ❌ ${label}${extra ? `   ${extra}` : ''}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notestore-'));
const storageDir = path.join(tmp, 'globalStorage');
const pdfDirA = path.join(tmp, 'old');
const pdfDirB = path.join(tmp, 'new');
fs.mkdirSync(storageDir, { recursive: true });
fs.mkdirSync(pdfDirA, { recursive: true });
fs.mkdirSync(pdfDirB, { recursive: true });

const fakeContext = { globalStorageUri: { fsPath: storageDir } };
const uriOf = p => ({ fsPath: p });

/** 造一个"内容确定"的假 PDF：字节数稳定，便于身份匹配 */
function makePdf(p, bytes = 4096) {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + bytes) % 251;
  fs.writeFileSync(p, buf);
  return fs.statSync(p).size;
}

(async () => {
  console.log('===== 存储键与文件搬家 =====');

  const pdfA = path.join(pdfDirA, 'cycle.pdf');
  const size = makePdf(pdfA);

  const mgr1 = new NotesStorageManager(fakeContext);
  const uA = uriOf(pdfA);

  // 1) 全新论文：空数据
  const fresh = await mgr1.loadPaperData(uA);
  check('首次打开是空批注', fresh.annotations.length === 0);

  // 2) 写两条批注 + 一条 AI 答疑 + 一段译文，落盘
  fresh.annotations = [
    { id: 'a1', page: 4, text: '第一段', color: 'yellow', note: '要点', timestamp: 1 },
    { id: 'a2', page: 5, text: '第二段', color: 'blue', timestamp: 2 }
  ];
  fresh.aiQa = [{ id: 'q1', page: 4, question: 'Q?', answer: 'A', at: 3 }];
  fresh.translations = { '4_x': '译文一' };
  fresh.pageArchive = { 4: [{ id: 0, cleanText: 'hello' }] };
  await mgr1.savePaperData(uA, fresh);

  const beforeKeyFiles = fs.readdirSync(storageDir).filter(f => f.startsWith('paper_'));
  check('落盘生成了存储文件', beforeKeyFiles.length === 1, beforeKeyFiles.join(','));

  // 3) 模拟"把 PDF 挪到另一个目录"（内容完全不变）
  const pdfB = path.join(pdfDirB, 'cycle.pdf');
  fs.renameSync(pdfA, pdfB);
  const uB = uriOf(pdfB);

  // 4) 用新路径打开：**必须自动认领回旧批注**
  const mgr2 = new NotesStorageManager(fakeContext);
  const afterMove = await mgr2.loadPaperData(uB);
  check('搬家后能读到批注（不再清零）', afterMove.annotations.length === 2, `实际 ${afterMove.annotations.length}`);
  check('搬家后批注内容正确',
    afterMove.annotations.some(a => a.id === 'a1' && a.note === '要点') && afterMove.annotations.some(a => a.id === 'a2'),
    JSON.stringify(afterMove.annotations.map(a => a.id)));
  check('搬家后 AI 答疑一并找回', (afterMove.aiQa || []).length === 1, `实际 ${(afterMove.aiQa || []).length}`);
  check('搬家后译文一并找回', afterMove.translations && afterMove.translations['4_x'] === '译文一');
  check('搬家后段落归档一并找回', !!(afterMove.pageArchive && afterMove.pageArchive['4']));
  check('pdfPath 已更新为新路径', afterMove.pdfPath === pdfB, afterMove.pdfPath);

  // 5) 保存后应写到新键，且旧键不被动
  await mgr2.savePaperData(uB, afterMove);
  const keyFiles = fs.readdirSync(storageDir).filter(f => f.startsWith('paper_'));
  check('新键与旧键同时存在（旧存档不删）', keyFiles.length === 2, keyFiles.join(','));

  const mgr3 = new NotesStorageManager(fakeContext);
  const reopen = await mgr3.loadPaperData(uB);
  check('重开新路径仍然有批注', reopen.annotations.length === 2, `实际 ${reopen.annotations.length}`);

  // 6) 反例：同名的**另一个文件**（字节数不同）绝不能误认领
  const otherDir = path.join(tmp, 'other');
  fs.mkdirSync(otherDir, { recursive: true });
  const otherPdf = path.join(otherDir, 'cycle.pdf');
  makePdf(otherPdf, 8192);
  const mgr4 = new NotesStorageManager(fakeContext);
  const other = await mgr4.loadPaperData(uriOf(otherPdf));
  check('同名的不同文件不会被误认领', other.annotations.length === 0, `实际 ${other.annotations.length}`);

  // 7) 索引文件应当被建出来
  check('生成了身份索引 _paper_index.json', fs.existsSync(path.join(storageDir, '_paper_index.json')));

  // 8) 老用户升级：删掉索引后，也应能从历史存档重建并认领
  fs.unlinkSync(path.join(storageDir, '_paper_index.json'));
  const thirdDir = path.join(tmp, 'third');
  fs.mkdirSync(thirdDir, { recursive: true });
  const pdfC = path.join(thirdDir, 'cycle.pdf');
  fs.renameSync(pdfB, pdfC);
  const mgr5 = new NotesStorageManager(fakeContext);
  const rebuilt = await mgr5.loadPaperData(uriOf(pdfC));
  check('索引丢失后能扫历史存档重建并认领', rebuilt.annotations.length === 2, `实际 ${rebuilt.annotations.length}`);

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  console.log(`（临时目录：${tmp}）`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
