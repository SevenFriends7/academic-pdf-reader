/**
 * 「模型给的 LaTeX 到底是不是这条公式」——字符守恒校验的回归测试。
 *
 * 【为什么这道校验必须被测】`formula_model_probe/FINDINGS.md` 的实测结论是：
 * 识别器在框裁对时 4/4 全对，框裁错时 3/3 全错，而且**不是拒绝，是编造**
 * （把邻行正文塞进 `\begin{array}` 一本正经地输出）。也就是说：
 *
 *   没有校验时 —— 裁框偏一点，用户就得到一条"能渲染、但内容不是这条公式"的式子，
 *                 比原来的残渣更危险（残渣至少看着可疑）；
 *   校验太松   —— 等于没有；
 *   校验太严   —— 明明识别对了却被丢掉，白跑 400ms。
 *
 * 所以这里用**实测案例**（真实的模型输出 / 真实的裁歪输出）把边界钉住。
 *
 * 用法：node scratch/formula_conservation_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  ❌ ${label}${extra ? `   ${extra}` : ''}`);
  }
}

// ---------------------------------------------------------------- 切出校验层
const start = code.indexOf('  const LATEX_CHAR_CMD = {');
const end = code.indexOf('  /** 3× PDF 点 ≈ 216dpi', start);
if (start < 0 || end < 0 || end <= start) {
  console.error('❌ viewer.js 里找不到字符守恒校验（锚点失效）');
  process.exit(1);
}
/*
 * 还要把 mathAlnumBase 一起切进来：PDF 文本层里的数学字母是 U+1D400 段的斜体字符
 * （`𝑯×𝑾×𝑵`），校验必须先还原成基字母才能和 LaTeX 的 `H×W×N` 对上。
 * 漏掉这一步的后果是**正确的识别被全量误杀**（实测过）。
 */
const mbStart = code.indexOf('  function mathAlnumBase(');
const mbEnd = code.indexOf('  /** 转义"不是数学语义"', mbStart);
if (mbStart < 0 || mbEnd <= mbStart) {
  console.error('❌ viewer.js 里找不到 mathAlnumBase（锚点失效）');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const V = new Function(`${code.slice(mbStart, mbEnd)}${code.slice(start, end)}
  return { latexVisibleChars, verifyLatexAgainstText, textCharBag, mathAlnumBase };`)();

// ---------------------------------------------------------------- 字符反解
console.log('\n--- latexVisibleChars：命令不能被算成字母 ---');
{
  const bag = s => (V.latexVisibleChars(s) || []).join('');
  check('\\frac 不产生字符', bag('\\frac{a}{b}') === 'ab', bag('\\frac{a}{b}'));
  check('\\sqrt 不产生字符', bag('\\sqrt{C}') === 'C', bag('\\sqrt{C}'));
  check('\\mathbb{R} → R', bag('\\mathbb{R}') === 'R', bag('\\mathbb{R}'));
  check('\\alpha → α', bag('\\alpha') === 'α', bag('\\alpha'));
  check('\\times → ×', bag('a\\times b') === 'a×b', bag('a\\times b'));
  check('\\text{softmax} 保留字母', bag('\\text{softmax}') === 'softmax', bag('\\text{softmax}'));
  check('上下标花括号不算字符', bag('X_{l}^{n}') === 'Xln', bag('X_{l}^{n}'));
  check('\\\\ 换行不算字符', bag('a\\\\b') === 'ab', bag('a\\\\b'));
  // \begin{array}{l} 的 {l} 是环境参数，不能当成字母 l —— 否则"编造"的判定会被它污染
  check('\\begin 的参数整体丢弃', bag('\\begin{array}{l}a\\end{array}') === 'a', bag('\\begin{array}{l}a\\end{array}'));
}

// ---------------------------------------------------------------- 应当通过
console.log('\n--- 应当通过（模型确实识别对了） ---');
{
  // 实测：AOT p4 式(2)，框裁对时模型给出的就是这条
  const r1 = V.verifyLatexAgainstText('Att(Q,K,V)=Corr(Q,K)V=softmax(\\frac{QK^{tr}}{\\sqrt{C}})V', 'Att(Q,K,V)=Corr(Q,K)V=softmax(QKtrC)V');
  check('整条 Attention 式子', r1.ok, JSON.stringify(r1));

  // 实测：AOT p5，本地层永远给不出的那种（根号里是 C）
  const r2 = V.verifyLatexAgainstText('\\frac{QK^{tr}}{\\sqrt{C}}', 'QKtr√C');
  check('分式套根号', r2.ok, JSON.stringify(r2));

  const r3 = V.verifyLatexAgainstText('X_{l}^{n}', 'X l n');
  check('普通上下标', r3.ok, JSON.stringify(r3));

  const r4 = V.verifyLatexAgainstText('\\hat{Y}_t', 'Y t');
  check('帽子（组合符不计入）', r4.ok, JSON.stringify(r4));

  const r5 = V.verifyLatexAgainstText('\\mathbb{R}^{HW\\times C}', 'R HW×C');
  check('黑板粗体 + 乘号', r5.ok, JSON.stringify(r5));

  const r6 = V.verifyLatexAgainstText('x', 'x');
  check('单字符公式', r6.ok, JSON.stringify(r6));

  /*
   * PDF 文本层里的数学字母是 U+1D400 段的**斜体字符**，不是 ASCII。
   * 实测：AOT 第 5 页的 `H×W×N` 在文本层里是 `𝑯×𝑾×𝑵`，而同一条式子模型给出的是普通的
   * `\begin{array}{c}{\overrightarrow{H\times W\times N}}` —— 不还原基字母就会把**完全正确**的
   * 识别判成"字符缺失"（这正是第一轮端到端里 17/18 全被拒的主因之一）。
   */
  const r7 = V.verifyLatexAgainstText('\\begin{array}{c}{\\overrightarrow{H\\times W\\times N}}\\end{array}', '𝑯×𝑾×𝑵');
  check('Unicode 数学斜体归一化', r7.ok, JSON.stringify(r7));

  // 算子名在 \operatorname 里是合法的，不能当成"吞正文"
  const r8 = V.verifyLatexAgainstText('\\operatorname{softmax}(x)', 'softmax(x)');
  check('\\operatorname{softmax} 放行', r8.ok, JSON.stringify(r8));

  // U+1D46F 落在"粗斜体 A"区段（0x1D468 起），偏移 7 → H
  check('mathAlnumBase 本身正常', V.mathAlnumBase(0x1d46f) === 'H', String(V.mathAlnumBase(0x1d46f)));
}

// ---------------------------------------------------------------- 应当拒绝
console.log('\n--- 应当拒绝（框裁歪 / 模型编造） ---');
{
  // 实测：裁图吞进上一行正文时，模型把这个当公式片段输出
  const b1 = V.verifyLatexAgainstText('\\begin{array}{l}{\\operatorname{ming}N}', 'X l n');
  check('吞邻行 → 拒绝', !b1.ok, JSON.stringify(b1));

  // 实测：AOT p4 的垃圾框（原图根本不是这条式子）
  const b2 = V.verifyLatexAgainstText('\\frac{1}{_t{_{^{t}}}}', 'x i t');
  check('垃圾框 → 拒绝', !b2.ok, JSON.stringify(b2));

  const b3 = V.verifyLatexAgainstText('', 'X l n');
  check('空结果 → 拒绝', !b3.ok, JSON.stringify(b3));

  const b4 = V.verifyLatexAgainstText('y', 'x');
  check('短公式字符不符 → 拒绝', !b4.ok, JSON.stringify(b4));

  const b5 = V.verifyLatexAgainstText('abcdefgh', 'x');
  check('短原文 + 长输出 → 拒绝', !b5.ok, JSON.stringify(b5));
}

// ---------------------------------------------------------------- 结构自检
console.log('\n--- 结构自检：字符对得上，但 LaTeX 本身是坏的 ---');
{
  /*
   * 实测 AOT_p4_attn_full：模型把 `\begin{aligned}{` 写成了 `Abegint}{`。
   * 字符几乎没少（cov=0.98），字符守恒完全放行 —— 但 KaTeX 渲染不出来。
   */
  const s1 = V.verifyLatexAgainstText('Abegint}{Att(Q,K,V)=Corr(Q,K)V', 'Att(Q, K, V) = Corr(Q, K)V');
  check('花括号不配对 → 拒绝', !s1.ok && s1.reason === 'unbalanced-brace', JSON.stringify(s1));

  const s2 = V.verifyLatexAgainstText('\\begin{array}{l}{x}', 'x');
  check('\\begin 没有 \\end → 拒绝', !s2.ok && s2.reason === 'unbalanced-env', JSON.stringify(s2));

  /*
   * 实测 AOT_p5_Yprime_01：框偏大，模型把框里的正文也忠实地转写了
   * （`\mathrm{probability}` `\mathrm{logits}`），字符守恒到 0.97。
   * 这类最危险：看起来完全像模像样，实际是把两行正文拼成了一条"公式"。
   */
  const s3 = V.verifyLatexAgainstText('\\mathrm{probability}~\\mathrm{logits}', "ies' probability logits");
  check('吞正文（非算子词）→ 拒绝', !s3.ok && s3.reason === 'prose-in-math', JSON.stringify(s3));

  const s4 = V.verifyLatexAgainstText('\\text{where}~x>0', 'where x>0');
  check('\\text{where} 也算吞正文', !s4.ok && s4.reason === 'prose-in-math', JSON.stringify(s4));
}

// ---------------------------------------------------------------- 边界：不能过严
console.log('\n--- 边界：识别对了但写法不同，不能误杀 ---');
{
  // 模型常把连字符写成 -，原文是 Unicode 减号
  const e1 = V.verifyLatexAgainstText('a-b', 'a−b');
  check('减号归一化', e1.ok, JSON.stringify(e1));

  // 模型有时多一个不可见间距命令
  const e2 = V.verifyLatexAgainstText('a\\,b', 'ab');
  check('\\, 间距命令被忽略', e2.ok, JSON.stringify(e2));

  // 分式会改变字符顺序，但多重集不变
  const e3 = V.verifyLatexAgainstText('\\frac{a+b}{c}', 'a+b c');
  check('分式重排不误杀', e3.ok, JSON.stringify(e3));
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
