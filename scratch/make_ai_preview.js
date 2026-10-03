/**
 * 生成一张**静态预览**：用真实宿主 HTML 里的弹窗结构 + 真实的 media/viewer.css，
 * 把回答风格控件按 viewer.js 的 createAiStyleSwitch() 产物填进去。
 *
 * 用途：用户抱怨"改了四次都没有"，重新打开 IDE 之前先看一眼成品到底长什么样。
 * 注意：这只是预览，不能替代真机验证（真机请认准工具栏徽章与弹窗标题旁的 v0.5.11）。
 *
 * 用法：node scratch/make_ai_preview.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const provider = fs.readFileSync(path.join(ROOT, 'src', 'pdfEditorProvider.ts'), 'utf8');
const start = provider.indexOf('return /* html */ `');
const end = provider.indexOf('`;', start);
if (start < 0 || end < 0) throw new Error('抽不到宿主 HTML 模板');
const hostHtml = provider.slice(start + 'return /* html */ `'.length, end);

const mStart = hostHtml.indexOf('<div id="aiAssistantModal"');
const mEnd = hostHtml.indexOf('<!-- 原文高亮批注悬停预览卡片');
if (mStart < 0 || mEnd < 0) throw new Error('抽不到 AI 弹窗结构');
let modal = hostHtml.slice(mStart, mEnd).trim();

// 与 viewer.js 的 AI_STYLES / createAiStyleSwitch() 保持一致（当前档位 = 标准）
const STYLES = [
  { key: 'concise', label: '简洁', tip: '200 字内讲清，最省 token' },
  { key: 'standard', label: '标准', tip: '先解释术语与前置概念，一般 300~700 字（默认）' },
  { key: 'reviewer', label: '审稿', tip: '以审稿人视角质疑论证与实验设计' }
];
const switchHtml =
  '<div class="ai-style-switch" role="group" aria-label="回答风格">' +
  '<span class="ai-style-label">回答风格</span>' +
  STYLES.map(
    s =>
      `<button type="button" class="ai-style-btn${s.key === 'standard' ? ' active' : ''}" data-style="${s.key}" title="${s.tip}">${s.label}</button>`
  ).join('') +
  '</div>';

modal = modal
  .replace('style="display: none;"', '')
  .replace('<div id="aiModalStyleSlot"></div>', `<div id="aiModalStyleSlot">${switchHtml}</div>`)
  .replace('<span class="ai-modal-version" id="aiModalVersion"></span>', '<span class="ai-modal-version" id="aiModalVersion">v0.5.11</span>');

// 这几处是 JS 在打开弹窗时填的，预览里给出示例文本
modal = modal
  .replace('<span class="ai-model-tag" id="aiModalModelTag">未连接</span>', '<span class="ai-model-tag" id="aiModalModelTag">deepseek-chat</span>')
  .replace('<div class="ai-context-text" id="aiModalQuote"></div>', '<div class="ai-context-text" id="aiModalQuote">Among all the VOS scenarios, semi-supervised video object segmentation is the most practical and widely researched.</div>')
  .replace('<div id="aiModalTranscript" class="ai-transcript">', '<div id="aiModalTranscript" class="ai-transcript" style="min-height:90px;">');

const out = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>回答风格切换 —— 弹窗实际长相预览（v0.5.11）</title>
<link rel="stylesheet" href="../media/viewer.css">
<style>
  body { margin: 0; padding: 28px 20px 40px; background: #f3f4f6; font-family: system-ui, "Microsoft YaHei", sans-serif; }
  .preview-note { max-width: 780px; margin: 0 auto 18px; padding: 12px 16px; border-radius: 8px; background: #fff;
                  border: 1px solid #e2e5ea; color: #333; font-size: 13px; line-height: 1.7; }
  .preview-note b { color: #0e639c; }
  .preview-stage { display: flex; justify-content: center; }
  /* 预览里把浮层改成内联摆放，不影响真实样式 */
  .ai-assistant-modal { position: static !important; width: auto !important; height: auto !important;
                        background: transparent !important; backdrop-filter: none !important; }
  .ai-modal-card { max-width: 720px; }
  .ai-modal-header-actions { display: flex; align-items: center; gap: 4px; }
</style>
</head>
<body>
  <div class="preview-note">
    <b>这是预览，不是真机截图。</b>结构取自宿主 HTML（<code>src/pdfEditorProvider.ts</code>），
    样式取自真实的 <code>media/viewer.css</code>，回答风格控件按 <code>viewer.js</code> 的
    <code>createAiStyleSwitch()</code> 产物填入（当前档位＝标准）。<br>
    真机确认方式：弹窗标题旁应显示 <b>v0.5.11</b>，右侧操作区应有
    <b>回答风格：简洁 / 标准 / 审稿</b> 三颗按钮，点一下会弹提示并写回设置。
  </div>
  <div class="preview-stage">
${modal}
  </div>
</body>
</html>
`;

const outPath = path.join(ROOT, 'scratch', 'ai-style-preview.html');
fs.writeFileSync(outPath, out, 'utf8');
console.log(`✅ 已生成预览：${outPath}`);
console.log(`   含回答风格控件：${out.includes('ai-style-btn') ? '是' : '否'}；三档：${STYLES.map(s => s.label).join(' / ')}`);
