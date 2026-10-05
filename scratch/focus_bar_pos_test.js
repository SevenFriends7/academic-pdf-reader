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

/** 一份"典型宽屏"几何：PDF 栏 0~1328，右侧面板 1328 起；句子在栏内偏右 */
const base = {
  anchorLeft: 300, anchorWidth: 400, anchorHeight: 16,
  pageLeft: 60, viewTop: 400,
  paneLeft: 0, paneRight: 1328, paneRightLimit: 1328,
  barW: 280, barH: 34, winW: 1858, winH: 900
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
  // 句子明显偏右（anchorMid 离右边界更近）→ 停右侧边缘
  const r = API.computeFocusBarPlacement({ ...base, anchorLeft: 560, anchorWidth: 400 });
  check('句子偏右时贴到可用右边界', r.left + base.barW + 12 === base.paneRightLimit, `left=${r.left} 右边界=${base.paneRightLimit}`);
}
{
  /*
   * 句子居中（两侧一样宽）→ 取左侧。
   * 理由：左边缘是**页面左侧页边距**（纯空白）；右边缘在窄窗口下会顶到译文面板，
   * 靠左更稳。要改这条行为必须同时改测试，不能让"压在正上方"那种位置悄悄回来。
   */
  const r = API.computeFocusBarPlacement(base);
  check('句子居中时取左侧页边距', r.left === base.paneLeft + 12, `left=${r.left}`);
}
{
  // 句子偏左 → 贴左边缘
  const r = API.computeFocusBarPlacement({ ...base, anchorLeft: 10, anchorWidth: 120 });
  check('句子偏左时贴到左边缘', r.left === 12, `left=${r.left}`);
}
{
  // 右侧面板占掉一大块 → 可用右边界要收缩到面板左边缘，不能压面板
  const r = API.computeFocusBarPlacement({ ...base, paneRight: 1858, paneRightLimit: 1328 });
  check('右侧面板不被压住（右边界收缩到面板左缘）', r.left + base.barW <= 1328, `left=${r.left}`);
}
{
  // 可用宽度不够放整条 → 靠左，保证整条可见
  const r = API.computeFocusBarPlacement({ ...base, paneRightLimit: 200, anchorLeft: 150, anchorWidth: 40 });
  check('可用宽度不足时仍保证整条可见', r.left >= 12 && r.left + base.barW <= base.winW, `left=${r.left}`);
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
  check('窄窗口下整条仍在窗口内', r.left >= 12 && r.left + base.barW <= 420, `left=${r.left}`);
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
