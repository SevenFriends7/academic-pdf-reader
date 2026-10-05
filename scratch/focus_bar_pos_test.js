/**
 * 点句子浮出的工具条（#paraFocusBar）定位回归测试。
 *
 * 【为什么测这个】用户反馈"点击句子弹出的卡片还是在上方"——
 * 旧规则 `top = 句子顶部 - 条高 - 10` 是**故意压在选中句的上一行**上，
 * 工具条宽 280px、含 6 个按钮，必然遮住上面的文字。
 * 这段逻辑只看数字，所以能（也必须）钉死在测试里：真实 DOM 的观感 jsdom 量不出来。
 *
 * 用法：node scratch/focus_bar_pos_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'media', 'viewer.js'), 'utf8');

/** 按"顶层函数结束行恰好是两个空格 + 花括号"抽（viewer.js 的缩进约定） */
function grab(name) {
  const lines = code.split('\n');
  const st = lines.findIndex(l => l.startsWith(`  function ${name}(`));
  if (st < 0) throw new Error(`抽不到 ${name}`);
  for (let i = st + 1; i < lines.length; i++) {
    if (lines[i] === '  }') return lines.slice(st, i + 1).join('\n');
  }
  throw new Error(`${name} 没闭合`);
}

const API = new Function(`${grab('computeFocusBarPlacement')}
  return { computeFocusBarPlacement };`)();

let pass = 0; let fail = 0;
const check = (label, ok, extra) => { if (ok) pass++; else { fail++; console.log(`  ❌ ${label}${extra ? `   ${extra}` : ''}`); } };

/** 一份"典型宽屏"几何：PDF 栏 0~1328，右侧面板 1328 起；1.6.8 起工具条是 96px 竖条 */
const base = {
  anchorLeft: 300, anchorWidth: 400, anchorHeight: 16,
  pageLeft: 60, viewTop: 400,
  paneLeft: 0, paneRight: 1328, paneRightLimit: 1328,
  barW: 96, barH: 210, winW: 1858, winH: 900
};
/** 断言：工具条与选中句之间至少留了 GAP，绝不压字 */
const GAP = 10;
const noOverlap = (r, g) => {
  const aL = g.pageLeft + g.anchorLeft;
  const aR = aL + g.anchorWidth;
  return r.left + g.barW <= aL - GAP + 0.5 || r.left >= aR + GAP - 0.5;
};

console.log('===== 工具条定位 =====');
{
  const r = API.computeFocusBarPlacement(base);
  check('纵向对齐到句子的中间，不再顶到句子正上方',
    Math.abs(r.top - (base.viewTop + base.anchorHeight / 2 - base.barH / 2)) < 1,
    `top=${r.top} 期望≈${base.viewTop + base.anchorHeight / 2 - base.barH / 2}`);
  check('不再出现"句子顶部 - 条高 - 10"那种压在上一行的位置',
    r.top !== base.viewTop - base.barH - 10,
    `top=${r.top}`);
}
{
  // 句子明显偏右 → 停右侧（且必须让开句子，不能压字）
  const g = { ...base, anchorLeft: 560, anchorWidth: 400 };
  const r = API.computeFocusBarPlacement(g);
  check('句子偏右时停右侧', r.left > g.pageLeft + g.anchorLeft, `left=${r.left}`);
  check('偏右时也不压住句子', noOverlap(r, g), `left=${r.left} barW=${g.barW}`);
}
{
  // 句子居中（两侧一样宽）→ 取左侧页边距，且必须让开句子
  const r = API.computeFocusBarPlacement(base);
  check('句子居中时取左侧页边距', r.left === base.paneLeft + 12, `left=${r.left}`);
  check('居中时也不压住句子', noOverlap(r, base), `left=${r.left}`);
}
{
  /*
   * 句子紧贴左边（pageLeft 60 + anchorLeft 10 = 视口 x=70）：页边距只有 70px，
   * 扣掉 GAP 后剩 60px < 96px 条宽 —— **几何上不可能完全让开**。
   * 这时的正确行为是"尽可能靠左（夹角最小）+ 绝不溢出视口"，
   * 而不是硬把条推到句子右边（那会把它甩到半个屏幕外，离用户视线更远）。
   */
  const g = { ...base, anchorLeft: 10, anchorWidth: 400 };
  const r = API.computeFocusBarPlacement(g);
  check('页边距放不下时尽可能靠左且不出视口', r.left >= 4 && r.left <= 10, `left=${r.left}`);
}
{
  // 右侧面板占掉一大块 → 可用右边界要收缩到面板左边缘，不能压面板
  const r = API.computeFocusBarPlacement({ ...base, paneRight: 1858, paneRightLimit: 1328 });
  check('右侧面板不被压住（右边界收缩到面板左缘）', r.left + base.barW <= 1328, `left=${r.left}`);
}
{
  // 可用宽度不够放整条 → 靠左，保证整条可见
  const r = API.computeFocusBarPlacement({ ...base, paneRightLimit: 200, anchorLeft: 150, anchorWidth: 40 });
  check('可用宽度不足时仍保证整条可见', r.left >= 4 && r.left + base.barW <= base.winW, `left=${r.left}`);
}
{
  // 顶部/底部夹取：句子贴近顶栏
  const r = API.computeFocusBarPlacement({ ...base, viewTop: 40 });
  check('句子贴近顶栏时不会跑到顶栏外面', r.top >= 50, `top=${r.top}`);
  const r2 = API.computeFocusBarPlacement({ ...base, viewTop: 880 });
  check('句子贴近底部时不会超出窗口', r2.top + base.barH <= base.winH, `top=${r2.top}`);
}
{
  // 窗口很窄：仍然整条在窗口内
  const r = API.computeFocusBarPlacement({ ...base, winW: 420, paneRight: 420, paneRightLimit: 420, anchorLeft: 200 });
  check('窄窗口下整条仍在窗口内', r.left >= 4 && r.left + base.barW <= 420, `left=${r.left}`);
}
{
  /*
   * 【1.6.8 的硬要求：竖条必须真的窄】
   * 用户反馈"太长了，遮住左右两边的字，弄窄一点、高一点"。
   * 这里直接钉住"窄"这个指标——宽度不得超过 120px。要改宽必须同时改这条测试。
   */
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'media', 'viewer.css'), 'utf8');
  const m = /\.para-focus-bar\s*\{[\s\S]*?width:\s*(\d+)px/.exec(css);
  const w = m ? Number(m[1]) : 0;
  check('工具条是窄竖条（CSS 宽度 ≤120px）', w > 0 && w <= 120, `width=${w}`);
  const col = /\.para-focus-bar\s*\{[\s\S]*?flex-direction:\s*column/.test(css);
  check('工具条是纵向布局（按钮竖排）', col);
}
{
  /*
   * 防回归的关键一条：**任何**几何下都不允许出现旧公式的位置。
   * 旧公式 = 条底边正好落在句子顶边上（top + barH === viewTop - 10）。
   */
  let badCase = null;
  for (const viewTop of [80, 200, 400, 700, 860]) {
    for (const anchorLeft of [10, 100, 300, 700, 1100]) {
      for (const paneRightLimit of [200, 800, 1328, 1858]) {
        const r = API.computeFocusBarPlacement({ ...base, viewTop, anchorLeft, paneRightLimit });
        if (r.top === viewTop - base.barH - 10) badCase = { viewTop, anchorLeft, paneRightLimit, ...r };
      }
    }
  }
  check('穷举 100 组几何都不再出现"压在上一行"的旧位置', !badCase, JSON.stringify(badCase));
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
