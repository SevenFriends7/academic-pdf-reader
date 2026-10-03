// 学术文献双栏阅读器客户端主交互逻辑 (高精度数学矢量高光 + 纸质级荧光笔质感 + 句子级双向对齐)
(function () {
  const vscode = acquireVsCodeApi();

  // ====================== 最外层错误可视化（必须放在最前面） ======================
  // 初始化一旦抛异常，用户看到的只是"PDF 空白"，而开发者拿不到任何信息——
  // 我们为此反复猜了好几轮。这里在任何业务代码之前注册兜底：
  // 把错误直接画在界面上，同时回报给扩展侧写进日志。
  function reportFatalError(kind, err) {
    try {
      const msg = (err && (err.message || (err.reason && err.reason.message))) || String(err);
      const stack = (err && err.stack) || '';
      let box = document.getElementById('fatalErrorBox');
      if (!box) {
        box = document.createElement('div');
        box.id = 'fatalErrorBox';
        box.style.cssText =
          'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;' +
          'background:#5a1d1d;color:#fff;border:1px solid #ff6b6b;border-radius:8px;padding:12px 14px;' +
          'font:12px/1.6 Consolas,Menlo,monospace;white-space:pre-wrap;max-height:40vh;overflow:auto;' +
          'box-shadow:0 8px 30px rgba(0,0,0,.45)';
        (document.body || document.documentElement).appendChild(box);
      }
      box.textContent =
        `[${kind}] ${msg}\n\n${stack}\n\n` +
        '请把上面这段内容发给开发者。\n' +
        '也可以在命令面板运行「Developer: Open Webview Developer Tools」查看 Console。';
      try {
        vscode.postMessage({ type: 'webviewFatal', message: `${kind}: ${msg}\n${stack}` });
      } catch {
        /* 极端情况下 vscode 可能还没准备好，忽略即可 */
      }
    } catch {
      /* 兜底里再出错就放弃，绝不因此再抛一次 */
    }
  }
  window.addEventListener('error', e => reportFatalError('error', e.error || e.message));
  window.addEventListener('unhandledrejection', e => reportFatalError('promise', e.reason));

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = window.PDF_WORKER_URL || './pdfjs/pdf.worker.min.js';
  }

  // 状态变量
  let pdfDoc = null;
  let currentPage = 1;
  let totalPages = 0;
  let currentScale = 1.25;
  let renderedScale = 1.25;
  let currentViewport = null;
  /**
   * 自动适应窗口宽度。
   * true  = 每次渲染都按左栏当前宽度贴合（默认）
   * false = 用户手动缩放过了，保持用户的比例，直到点「适合宽度」
   * 手动优先是关键：否则用户刚放大，窗口一变化就被自动比例冲掉。
   */
  let autoFitEnabled = true;
  /** 最近渲染的那一页在 scale=1 时的宽度，用于同步推算适应比例（避免每次 await getPage） */
  let renderedUnscaledWidth = 0;
  let autoFitResizeTimer = null;
  let currentTextContent = null;
  let paperData = { annotations: [], translations: {}, sentenceTranslations: {} };
  let currentParagraphs = [];

  /**
   * 每页段落快照 —— 「导出全文双语精读稿」的数据源。
   *
   * 为什么必须单独留一份：`currentParagraphs` 只保存**当前页**，一翻页就被整段替换。
   * 而导出要按页把「原文段 → 译文 → 我的批注 → AI 答疑」交织成一篇可读文稿，
   * 所以翻过的每一页都得留住。
   *
   * 只取轻量字段：**绝不保存 rawSpans / charMap**——那里是 DOM 元素，
   * 留着会把已经销毁页面的节点全部钉在内存里（读几十页就是明显的内存泄漏）。
   * 译文在快照时可能还没到，收到后由 updateArchivedParagraph() 回填。
   */
  const pageParaArchive = new Map();
  /** 正在等视觉结果的页（避免同一页重复发请求） */
  const visionPending = new Set();
  /**
   * 版面分割引擎：vision（每页问视觉）/ auto（只在本地可疑时问）/ local（从不问）。
   * 由宿主通过 initPdfData 与 modelInfo 下发。
   *
   * 【初值必须是 local】配置到达之前不许花钱：初值给 vision 的话，
   * 把引擎设成 local 的用户也会在首屏被发一次视觉请求（真实会踩到）。
   */
  let visionEngine = 'local';
  /**
   * 宿主当前配置的**视觉模型名**（academicReader.visionModel，可能为空 = 沿用问答模型）。
   *
   * 它的作用是给"想重判某一页"留一条干净的路：把名字记进每页的视觉缓存，
   * **换模型后该页缓存自动判废、下次渲染重新问一次**。
   * 之所以要这条，是因为移除了「视觉重排」按钮——否则遇到判歪的一页就再无手段重判。
   */
  let configuredVisionModel = '';
  /**
   * 是否允许视觉结果**真的改写分段**（合并/拆分），由宿主下发 academicReader.visionSurgery。
   * 关掉就退化成 1.2.0 的行为：只改类型/顺序/丢弃。
   */
  let visionSurgeryAllowed = true;
  /**
   * 当前页**本地代码切出来的原件**（还没做过视觉手术的那一份）。
   *
   * 为什么必须留着它：视觉结果永远在它之上重放，所以翻页回来、缩放重渲染、
   * 手动点「视觉重排」都是幂等的 —— 否则第二次会把同一处合并/拆分再叠加一遍。
   */
  let localParagraphsSnapshot = null;
  let localParagraphsPage = 0;
  /** 待同步给宿主的段落快照（按页合并 + 节流，见 syncPageArchive） */
  const pendingArchiveSync = new Map();
  let archiveSyncTimer = null;
  let activeHighlightCard = null;
  let selectedHighlightColor = 'yellow';
  let currentSelectionInfo = null;
  let isRendering = false;
  let pendingRenderPage = null;
  let activeFocusPara = null;
  let activeFocusSentIdx = undefined;
  // 段落聚焦条的锚点上下文：记住"它跟着哪句话/哪一段"，滚动时重新定位
  let activeFocusAnchor = null;
  let focusBarRaf = 0;
  let focusFollowBound = false;
  // 右下角提示条：自动消失，鼠标悬停暂停计时
  let readerToastTimer = null;

  /**
   * 笔记卡片悬停提示的延时器。
   *
   * 【曾经是一个隐藏很久的 bug】这里一直**没有声明**：在非严格模式下
   * `hoverTooltipTimer = setTimeout(...)` 会隐式创建全局变量，于是"看起来能用"；
   * 一旦代码在严格模式下执行（ES module 或 'use strict'），
   * 赋值与读取都会抛 `ReferenceError: hoverTooltipTimer is not defined`。
   * 现在显式声明，并加入 eslint no-undef 静态检查防止同类问题再现。
   */
  let hoverTooltipTimer = null;

  /**
   * 回答风格三档的定义。
   *
   * 【必须放在最前面】这里是 const（存在暂时性死区），而创建批注卡片时会调用
   * createAiStyleSwitch() 读它——若把定义写在文件后部，初始化阶段就会抛
   * "Cannot access 'AI_STYLES' before initialization"，导致后续的 PDF 加载、
   * 翻译、主题应用全部中断（用户看到的现象：PDF 空白 + 无译文 + 主题错乱）。
   */
  const AI_STYLES = [
    { key: 'concise', label: '简洁', tip: '200 字内讲清，最省 token' },
    { key: 'standard', label: '标准', tip: '先解释术语与前置概念，一般 300~700 字（默认）' },
    { key: 'reviewer', label: '审稿', tip: '以审稿人视角质疑论证与实验设计' }
  ];

  /**
   * 当前回答风格（由设置同步进来）。
   *
   * 【同样必须放在最前面】初始化阶段创建批注卡片时会调用 createAiStyleSwitch()，
   * 其中的 syncAiStyleButtons() 会读这个变量；若声明晚于调用点就会抛
   * "Cannot access 'aiStyle' before initialization"，
   * 与 AI_STYLES 那次一样会让整个初始化中断（PDF 空白 / 无译文 / 主题错乱）。
   *
   * 取空串表示"由扩展侧读取 academicReader.aiAnswerStyle 设置"（用户设置优先）。
   */
  let aiStyle = '';
  let activeContextAnnot = null;
  let currentEditingAnnot = null;
  let currentNotesSearchQuery = '';
  let currentNotesColorFilter = 'all';
  // ====================== 自愈与强制补全工具栏 DOM 机制 (防止 Webview 历史缓存导致丢失工具栏) ======================
  /**
   * 补齐 AI 问答弹窗里"后来才加上的控制件"。
   *
   * 【真机的坑，四次修复都栽在这里】
   * `#aiAssistantModal` 本来就写在**宿主 HTML**（src/pdfEditorProvider.ts 的 getHtmlForWebview）里，
   * 于是 ensureAllToolbarsExist() 里 `if (!document.getElementById('aiAssistantModal'))`
   * 这个创建分支在真机上**从来不执行**：0.5.6 / 0.5.7 / 0.5.8 / 0.5.10 为
   * "回答风格切换 / 版本号 / 开始分析" 做的所有改动，全都落在死分支里，
   * 用户在界面上一个都看不到 —— 这正是"改了四次都没添加成功"的真正原因。
   * （本地冒烟测试当时故意让弹窗缺失，测的恰好是那条死分支，所以一路绿灯。）
   *
   * 现在无论弹窗由谁创建，缺什么补什么：
   *   · 标题旁的扩展版本号 #aiModalVersion（截图即可确认跑的是哪一版）
   *   · **固定头部**里的回答风格控件槽 #aiModalStyleSlot（头部不滚动，永远看得见）
   * 回归护栏：scratch/host_html_smoke.js 直接用宿主 HTML 跑真实路径。
   */
  function ensureAiModalControls(modal) {
    if (!modal) return;

    // 1) 标题旁的版本号（不等任何消息，打开即显示；取不到显示 v?）
    let verEl = modal.querySelector('#aiModalVersion');
    if (!verEl) {
      const titleEl = modal.querySelector('.ai-modal-title');
      if (titleEl) {
        verEl = document.createElement('span');
        verEl.className = 'ai-modal-version';
        verEl.id = 'aiModalVersion';
        titleEl.appendChild(verEl);
      }
    }
    if (verEl) {
      verEl.textContent =
        typeof window.__EXT_VERSION__ === 'string' && window.__EXT_VERSION__
          ? `v${window.__EXT_VERSION__}`
          : 'v?';
    }

    // 2) 回答风格切换：必须落在**固定头部**里（放主体里会被长对话滚出视野）
    let slot = modal.querySelector('#aiModalStyleSlot');
    if (!slot) {
      const headerActions = modal.querySelector('.ai-modal-header-actions');
      if (headerActions) {
        slot = document.createElement('div');
        slot.id = 'aiModalStyleSlot';
        headerActions.insertBefore(slot, headerActions.firstChild);
      }
    }
    if (slot && !slot.querySelector('.ai-style-switch')) {
      slot.appendChild(createAiStyleSwitch());
    }

    // 3) 老版本（≤0.5.17）的「开始分析」按钮：直接删掉。
    //    它和「发送」功能重叠——预设问题是**预填进输入框**的，点「发送」发的就是它；
    //    而且它会无视用户在输入框里的修改（照样发原始预设），是个坑。
    //    现在预设问题改成快捷提问芯片（见 renderPresetChip）。
    const legacyAnalyzeBtn = modal.querySelector('#btnAnalyzeAiModal');
    if (legacyAnalyzeBtn) legacyAnalyzeBtn.remove();
  }

  function ensureAllToolbarsExist() {
    // 1. 确保 Header 护眼纸张胶囊存在
    const headerCenter = document.querySelector('.header-center');
    if (headerCenter && !document.querySelector('.theme-pill-group')) {
      const divider = document.createElement('div');
      divider.className = 'toolbar-divider';
      headerCenter.appendChild(divider);

      const pillGroup = document.createElement('div');
      pillGroup.className = 'theme-pill-group';
      pillGroup.title = '切换文献纸张护眼底色';
      pillGroup.innerHTML = `
        <span class="theme-pill-title">护眼纸张:</span>
        <button class="btn-theme-pill active" data-theme="default" title="默认白纸">白纸</button>
        <button class="btn-theme-pill" data-theme="sepia" title="护眼暖色">羊皮</button>
        <button class="btn-theme-pill" data-theme="green" title="冷色防眩光">竹青</button>
        <button class="btn-theme-pill" data-theme="dark" title="夜读黑底">暗夜</button>
      `;
      headerCenter.appendChild(pillGroup);
    }

    // 2. 彻底清理可能残留在 PDF 视图上的旧常驻工具栏 (pdfActionBar)
    const existingActionBar = document.getElementById('pdfActionBar');
    if (existingActionBar) {
      existingActionBar.remove();
    }

    // 3. 确保划词悬浮菜单存在 (Selection Floating Bar)
    if (!document.getElementById('selectionToolbar')) {
      const selBar = document.createElement('div');
      selBar.id = 'selectionToolbar';
      selBar.className = 'selection-floating-bar';
      selBar.style.display = 'none';
      selBar.innerHTML = `
        <div class="color-picker" title="选择高亮荧光笔颜色">
          <span class="color-dot yellow active" data-color="yellow" title="核心要点 (黄色)"></span>
          <span class="color-dot green" data-color="green" title="论据数据 (绿色)"></span>
          <span class="color-dot blue" data-color="blue" title="公式方法 (蓝色)"></span>
          <span class="color-dot pink" data-color="pink" title="疑难待查 (粉色)"></span>
        </div>
        <button id="btnHighlight" class="action-btn" title="划线高亮 (快捷键: H)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L15 4a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8z"/></svg>
          高亮
          <kbd class="kbd-badge">H</kbd>
        </button>
        <button id="btnAddNote" class="action-btn" title="添加批注便签 (快捷键: N)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          批注
          <kbd class="kbd-badge">N</kbd>
        </button>
        <button id="btnSelectionAi" class="action-btn" style="color: #6366f1;" title="针对选中文本向AI学术导师提问 (快捷键: Q)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><rect width="18" height="12" x="3" y="6" rx="2"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M9 15h6"/></svg>
          问AI
          <kbd class="kbd-badge">Q</kbd>
        </button>
        <button id="btnQuickTranslate" class="action-btn" title="精细划词翻译 (快捷键: T)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
          译句
          <kbd class="kbd-badge">T</kbd>
        </button>
        <button id="btnQuickCopy" class="action-btn" title="复制选中文本 (快捷键: C)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          复制
          <kbd class="kbd-badge">C</kbd>
        </button>
      `;
      document.body.appendChild(selBar);
    }

    // 4. 确保段落聚焦快捷条存在 (Para Focus Bar)
    if (!document.getElementById('paraFocusBar')) {
      const focusBar = document.createElement('div');
      focusBar.id = 'paraFocusBar';
      focusBar.className = 'para-focus-bar';
      focusBar.style.display = 'none';
      focusBar.innerHTML = `
        <span class="focus-bar-label" id="focusBarLabel">当前段落</span>
        <button id="btnFocusHighlight" class="focus-action-btn" title="为此段落/句子添加高亮 (快捷键: H)">高亮</button>
        <button id="btnFocusNote" class="focus-action-btn" title="为此段落添加批注心得 (快捷键: N)">批注</button>
        <button id="btnFocusTranslate" class="focus-action-btn" title="查看对应中文译文 (快捷键: T)">翻译</button>
        <button id="btnFocusCopy" class="focus-action-btn" title="复制当前段落文本 (快捷键: C)">复制</button>
        <button id="btnFocusAi" class="focus-action-btn focus-ai-btn" title="就当前段落向AI导师提问 (快捷键: Q)">问AI</button>
        <button id="btnCloseFocusBar" class="focus-close-btn" title="关闭">&times;</button>
      `;
      document.body.appendChild(focusBar);
    }

    // 5. 确保就近批注便签编辑气泡存在 (Annotation Editor Popover)
    if (!document.getElementById('annotationPopover')) {
      const annotPop = document.createElement('div');
      annotPop.id = 'annotationPopover';
      annotPop.className = 'annotation-editor-popover';
      annotPop.style.display = 'none';
      annotPop.innerHTML = `
        <div class="annot-popover-header">
          <div class="annot-popover-title">
                <span id="annotPopoverTitle">文献研读批注</span>
            <span class="annot-page-badge" id="annotPopoverPageBadge">第 1 页</span>
          </div>
          <div class="annot-color-picker">
            <span class="annot-color-btn yellow active" data-color="yellow" title="核心要点 (黄色)"></span>
            <span class="annot-color-btn green" data-color="green" title="论据数据 (绿色)"></span>
            <span class="annot-color-btn blue" data-color="blue" title="公式方法 (蓝色)"></span>
            <span class="annot-color-btn pink" data-color="pink" title="疑难待查 (粉色)"></span>
          </div>
          <button id="closeAnnotPopoverBtn" class="btn-close-mini" title="关闭 (Esc)">&times;</button>
        </div>
        <div class="annot-popover-quote">
          <span class="quote-tag">原文摘录</span>
          <p id="annotQuoteText"></p>
        </div>
        <div class="annot-quick-tags">
          <span class="quick-tag-label">快捷标签:</span>
          <button type="button" class="quick-tag-chip" data-tag="#核心结论">#核心结论</button>
          <button type="button" class="quick-tag-chip" data-tag="#实验数据">#实验数据</button>
          <button type="button" class="quick-tag-chip" data-tag="#研究方法">#研究方法</button>
          <button type="button" class="quick-tag-chip" data-tag="#疑点待查">#疑点待查</button>
          <button type="button" class="quick-tag-chip" data-tag="#灵感启发">#灵感启发</button>
        </div>
        <div class="annot-ai-bar">
          <button type="button" id="btnAskAiPopover" class="btn-ask-ai" title="结合选句与段落上下文向 AI 提问">AI 提问</button>
          <span class="annot-ai-hint" id="annotAiStatusHint"></span>
        </div>
        <div class="annot-ai-answer-box" id="annotAiAnswerBox" style="display: none;">
          <div class="annot-ai-answer-header">
            <span class="annot-ai-answer-title">AI 解答</span>
            <div class="annot-ai-actions">
              <button type="button" id="btnAdoptAiToNote" class="btn-adopt-ai" title="将 AI 解答追加到下方批注框">采纳进批注</button>
              <button type="button" id="btnCloseAiAnswer" class="btn-close-mini">&times;</button>
            </div>
          </div>
          <div class="annot-ai-answer-content markdown-body" id="annotAiAnswerContent"></div>
        </div>
        <div class="annot-input-wrapper">
          <textarea id="annotTextInput" placeholder="记录你的文献理解、公式推导、实验疑点或创新灵感..." rows="4"></textarea>
        </div>
        <div class="annot-popover-footer">
          <div class="annot-footer-hints">
            <span class="shortcut-tip">Ctrl+Enter 保存</span>
          </div>
          <div class="annot-footer-actions">
            <button id="deleteAnnotBtn" class="btn-mini-danger" style="display: none;" title="删除这条批注">删除</button>
            <button id="cancelAnnotBtn" class="btn-mini-secondary">取消</button>
            <button id="saveAnnotBtn" class="btn-mini-primary">保存批注</button>
          </div>
        </div>
      `;
      document.body.appendChild(annotPop);
    }

    // 批注卡片的「AI 提问」栏也要有回答风格切换：
    // 之前只把按钮硬编码在问答弹窗里，从批注入口点进去就没有这个控件。
    //
    // 【去重必须查 .annot-ai-bar 的**父节点**】控件是插在 .annot-ai-bar 的兄弟位置（不是内部），
    // 原先用 `!annotAiBar.querySelector('.ai-style-switch')` 判断永远为真：
    // ensureAllToolbarsExist() 每次打开问答弹窗都会被调用一次（见 openAiAssistantModal），
    // 于是每点一次「问AI」就往批注气泡里多塞一行风格切换。
    const annotAiBar = document.querySelector('.annot-ai-bar');
    const annotHost = annotAiBar && annotAiBar.parentNode;
    if (annotHost && !annotHost.querySelector('.ai-style-switch-annot')) {
      const switchEl = createAiStyleSwitch();
      switchEl.classList.add('ai-style-switch-annot');
      annotHost.insertBefore(switchEl, annotAiBar.nextSibling);
    }

    // 6. 确保 AI 学术问答助手弹窗存在 (AI Assistant Modal)
    if (!document.getElementById('aiAssistantModal')) {
      const aiModal = document.createElement('div');
      aiModal.id = 'aiAssistantModal';
      aiModal.className = 'ai-assistant-modal';
      aiModal.style.display = 'none';
      aiModal.innerHTML = `
        <div class="ai-modal-card">
          <div class="ai-modal-header">
            <div class="ai-modal-title">
              <span>AI 学术文献导师</span>
              <span class="ai-model-tag" id="aiModalModelTag">未连接</span>
              <span class="ai-modal-version" id="aiModalVersion"></span>
            </div>
            <div class="ai-modal-header-actions">
              <!-- 回答风格切换放在**固定头部**里：弹窗主体是滚动区域，
                   此前放在主体内（先在底部、后在输入框上方）都会被滚出视野，
                   用户反馈"代码在但看不见"。头部永不滚动，放这里必然可见。 -->
              <div id="aiModalStyleSlot"></div>
              <button id="btnClearAiConversation" class="ai-text-btn" type="button" title="清空对话，另起一个话题">新话题</button>
              <button id="btnCloseAiModal" class="btn-close-mini" title="关闭 (Esc)">&times;</button>
            </div>
          </div>
          <div class="ai-modal-body">
            <div class="ai-modal-context">
              <div class="ai-context-text" id="aiModalQuote"></div>
            </div>
            <div class="ai-prompt-chips">
              <button type="button" class="ai-chip" data-q="这句话的真实技术意图与核心动机是什么？请用通俗中文讲透。">核心动机</button>
              <button type="button" class="ai-chip" data-q="作者在此处与以往前人方法有何本质区别？优势在哪里？">与前人区别</button>
              <button type="button" class="ai-chip" data-q="这句话里涉及的术语、公式或方法背后的数学原理是什么？">术语与公式</button>
              <button type="button" class="ai-chip" data-q="我对这里的结论存有疑难，请结合上下文帮我深度剖析推导过程。">推导过程</button>
            </div>
            <div id="aiModalTranscript" class="ai-transcript">
              <div class="ai-transcript-empty">可直接提问，或点上面的快捷提问。有预设分析时已替你填进输入框，点「发送」才开始——打开本窗口不会自动发起提问。</div>
            </div>
            <div id="aiModalLoading" class="ai-modal-loading" style="display: none;">
              <span class="ai-loading-text">正在连接...</span>
            </div>
            <div class="ai-question-input-wrapper">
              <textarea id="aiModalQuestionInput" placeholder="输入你的疑问，回车发送（Shift+回车换行）；可继续追问" rows="2"></textarea>
              <div class="ai-send-group">
                <button id="btnStopAiModalQuestion" class="btn-stop-ai" type="button" style="display: none;">停止</button>
                <button id="btnSendAiModalQuestion" class="btn-send-ai">发送</button>
              </div>
            </div>
            <div class="ai-scope-hint">问本论文的内容会严格依据原文（查不到就说查不到）；问概念、术语或临时想到的问题，会直接用通用知识回答并标明不是论文结论。</div>
          </div>
        </div>
      `;
      document.body.appendChild(aiModal);
    }

    // 【必做】宿主 HTML 里本来就有 #aiAssistantModal，上面那个创建分支在真机上是死代码，
    // 所以对"已经存在的弹窗"也要补齐控制件，否则回答风格切换永远不出现。
    ensureAiModalControls(document.getElementById('aiAssistantModal'));
  }
  ensureAllToolbarsExist();

  // DOM 元素引用
  const dom = {
    paperTitle: document.getElementById('paperTitle'),
    prevPageBtn: document.getElementById('prevPageBtn'),
    nextPageBtn: document.getElementById('nextPageBtn'),
    pageNumberInput: document.getElementById('pageNumberInput'),
    pageCount: document.getElementById('pageCount'),
    zoomOutBtn: document.getElementById('zoomOutBtn'),
    zoomInBtn: document.getElementById('zoomInBtn'),
    zoomFitBtn: document.getElementById('zoomFitBtn'),
    zoomPercent: document.getElementById('zoomPercent'),
    tabTransBtn: document.getElementById('tabTransBtn'),
    tabNotesBtn: document.getElementById('tabNotesBtn'),
    notesCount: document.getElementById('notesCount'),
    translateAllBtn: document.getElementById('translateAllBtn'),
    exportNotesBtn: document.getElementById('exportNotesBtn'),
    openSettingsBtn: document.getElementById('openSettingsBtn'),
    btnSettingsRightPane: document.getElementById('btnSettingsRightPane'),
    refreshTransBtn: document.getElementById('refreshTransBtn'),

    pdfPane: document.getElementById('pdfPane'),
    pdfViewerContainer: document.getElementById('pdfViewerContainer'),
    loadingOverlay: document.getElementById('loadingOverlay'),
    splitter: document.getElementById('splitter'),
    rightPane: document.getElementById('rightPane'),

    transView: document.getElementById('transView'),
    notesView: document.getElementById('notesView'),
    transListContainer: document.getElementById('transListContainer'),
    notesListContainer: document.getElementById('notesListContainer'),

    // 视图切换与沉浸式阅读
    btnViewCards: document.getElementById('btnViewCards'),
    btnViewArticle: document.getElementById('btnViewArticle'),
    articleFlowContainer: document.getElementById('articleFlowContainer'),

    // 即时划词精译卡片
    instantTranslateCard: document.getElementById('instantTranslateCard'),
    instantOriginalText: document.getElementById('instantOriginalText'),
    instantTranslatedText: document.getElementById('instantTranslatedText'),
    btnCopyInstantZh: document.getElementById('btnCopyInstantZh'),
    btnNoteFromInstant: document.getElementById('btnNoteFromInstant'),
    btnCloseInstant: document.getElementById('btnCloseInstant'),

    // 划词浮条与卡片
    selectionToolbar: document.getElementById('selectionToolbar'),
    btnHighlight: document.getElementById('btnHighlight'),
    btnAddNote: document.getElementById('btnAddNote'),
    btnQuickTranslate: document.getElementById('btnQuickTranslate'),
    btnQuickCopy: document.getElementById('btnQuickCopy'),
    quickTranslatePopover: document.getElementById('quickTranslatePopover'),
    popoverSourceText: document.getElementById('popoverSourceText'),
    popoverResultText: document.getElementById('popoverResultText'),
    closePopoverBtn: document.getElementById('closePopoverBtn'),

    // 就近批注便签编辑气泡
    annotationPopover: document.getElementById('annotationPopover'),
    annotPopoverTitle: document.getElementById('annotPopoverTitle'),
    annotPopoverPageBadge: document.getElementById('annotPopoverPageBadge'),
    closeAnnotPopoverBtn: document.getElementById('closeAnnotPopoverBtn'),
    annotQuoteText: document.getElementById('annotQuoteText'),
    annotTextInput: document.getElementById('annotTextInput'),
    deleteAnnotBtn: document.getElementById('deleteAnnotBtn'),
    cancelAnnotBtn: document.getElementById('cancelAnnotBtn'),
    saveAnnotBtn: document.getElementById('saveAnnotBtn'),

    // 原文高亮批注悬停预览卡片
    noteHoverTooltip: document.getElementById('noteHoverTooltip'),
    tooltipBadge: document.getElementById('tooltipBadge'),
    tooltipTime: document.getElementById('tooltipTime'),
    tooltipQuote: document.getElementById('tooltipQuote'),
    tooltipContent: document.getElementById('tooltipContent'),
    tooltipBtnEdit: document.getElementById('tooltipBtnEdit'),
    tooltipBtnJump: document.getElementById('tooltipBtnJump'),
    tooltipBtnDelete: document.getElementById('tooltipBtnDelete'),

    // 批注笔记库搜索与筛选
    notesSearchInput: document.getElementById('notesSearchInput'),
    clearNotesSearch: document.getElementById('clearNotesSearch'),
    filterCountAll: document.getElementById('filterCountAll'),
    btnAddPageNoteQuick: document.getElementById('btnAddPageNoteQuick'),

    // 自定义学术右键快捷菜单
    pdfContextMenu: document.getElementById('pdfContextMenu'),
    ctxAnnotSection: document.getElementById('ctxAnnotSection'),
    ctxAnnotColorPicker: document.getElementById('ctxAnnotColorPicker'),
    ctxBtnEditAnnot: document.getElementById('ctxBtnEditAnnot'),
    ctxBtnCopyAnnot: document.getElementById('ctxBtnCopyAnnot'),
    ctxBtnFocusAnnot: document.getElementById('ctxBtnFocusAnnot'),
    ctxBtnDeleteAnnot: document.getElementById('ctxBtnDeleteAnnot'),
    ctxTextSection: document.getElementById('ctxTextSection'),
    ctxBtnHighlight: document.getElementById('ctxBtnHighlight'),
    ctxBtnAddNote: document.getElementById('ctxBtnAddNote'),
    ctxBtnAddNoteLabel: document.getElementById('ctxBtnAddNoteLabel'),
    ctxBtnTranslate: document.getElementById('ctxBtnTranslate'),
    ctxBtnCopy: document.getElementById('ctxBtnCopy'),
    ctxBtnLocate: document.getElementById('ctxBtnLocate'),
    ctxBtnAddPageNote: document.getElementById('ctxBtnAddPageNote'),
    ctxBtnTranslatePage: document.getElementById('ctxBtnTranslatePage'),
    ctxBtnFitWidth: document.getElementById('ctxBtnFitWidth'),
    ctxBtnPrevPage: document.getElementById('ctxBtnPrevPage'),
    ctxBtnNextPage: document.getElementById('ctxBtnNextPage'),
    ctxBtnExportNotes: document.getElementById('ctxBtnExportNotes'),

    // 便签模态框
    noteModal: document.getElementById('noteModal'),
    modalQuoteText: document.getElementById('modalQuoteText'),
    modalNoteInput: document.getElementById('modalNoteInput'),
    cancelNoteBtn: document.getElementById('cancelNoteBtn'),
    saveNoteBtn: document.getElementById('saveNoteBtn'),
    closeModalBtn: document.getElementById('closeModalBtn'),

    // 底部常驻智能速照栏
    dockedInspector: document.getElementById('dockedInspector'),
    dockedInspectorBadge: document.getElementById('dockedInspectorBadge'),
    dockedInspectorSub: document.getElementById('dockedInspectorSub'),
    dockedZhText: document.getElementById('dockedZhText'),
    dockedEnText: document.getElementById('dockedEnText'),
    btnCopyDockedZh: document.getElementById('btnCopyDockedZh'),
    btnCopyDockedEn: document.getElementById('btnCopyDockedEn'),
    btnNoteFromDocked: document.getElementById('btnNoteFromDocked'),
    btnCloseDocked: document.getElementById('btnCloseDocked'),
    readingProgressBar: document.getElementById('readingProgressBar'),
    // 段落聚焦快捷浮条
    paraFocusBar: document.getElementById('paraFocusBar'),
    focusBarLabel: document.getElementById('focusBarLabel'),
    btnFocusHighlight: document.getElementById('btnFocusHighlight'),
    btnFocusNote: document.getElementById('btnFocusNote'),
    btnFocusTranslate: document.getElementById('btnFocusTranslate'),
    btnFocusCopy: document.getElementById('btnFocusCopy'),
    btnCloseFocusBar: document.getElementById('btnCloseFocusBar'),
    btnFocusAi: document.getElementById('btnFocusAi'),

    // AI 学术问答元素
    btnAskAiPopover: document.getElementById('btnAskAiPopover'),
    annotAiStatusHint: document.getElementById('annotAiStatusHint'),
    annotAiAnswerBox: document.getElementById('annotAiAnswerBox'),
    annotAiAnswerContent: document.getElementById('annotAiAnswerContent'),
    btnAdoptAiToNote: document.getElementById('btnAdoptAiToNote'),
    btnCloseAiAnswer: document.getElementById('btnCloseAiAnswer'),

    aiAssistantModal: document.getElementById('aiAssistantModal'),
    btnCloseAiModal: document.getElementById('btnCloseAiModal'),
    aiModalQuote: document.getElementById('aiModalQuote'),
    aiModalQuestionInput: document.getElementById('aiModalQuestionInput'),
    btnSendAiModalQuestion: document.getElementById('btnSendAiModalQuestion'),
    btnStopAiModalQuestion: document.getElementById('btnStopAiModalQuestion'),
    btnClearAiConversation: document.getElementById('btnClearAiConversation'),
    aiModalTranscript: document.getElementById('aiModalTranscript'),
    aiModalModelTag: document.getElementById('aiModalModelTag'),
    aiModalLoading: document.getElementById('aiModalLoading')
  };

  // ====================== 护眼底色与夜读纸张主题 ======================
  let currentPaperTheme = 'default';
  try {
    currentPaperTheme = localStorage.getItem('academic_paper_theme') || 'default';
  } catch (e) {}

  function applyPaperTheme(theme) {
    currentPaperTheme = theme;
    document.body.classList.remove('theme-paper-default', 'theme-paper-sepia', 'theme-paper-green', 'theme-paper-dark');
    document.body.classList.add(`theme-paper-${theme}`);
    document.querySelectorAll('.btn-theme-pill').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-theme') === theme);
    });
    try {
      localStorage.setItem('academic_paper_theme', theme);
    } catch (e) {}
  }
  applyPaperTheme(currentPaperTheme);

  document.querySelectorAll('.btn-theme-pill').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const theme = btn.getAttribute('data-theme') || 'default';
      applyPaperTheme(theme);
    });
  });

  // 顶部渐变进度条更新
  function updateReadingProgress() {
    if (dom.readingProgressBar && totalPages > 0) {
      const pct = Math.min(100, Math.max(0, Math.round((currentPage / totalPages) * 100)));
      dom.readingProgressBar.style.width = `${pct}%`;
      dom.readingProgressBar.title = `阅读进度: 第 ${currentPage}/${totalPages} 页 (${pct}%)`;
    }
  }

  vscode.postMessage({ type: 'webviewReady' });

  window.addEventListener('message', async (event) => {
    const msg = event.data;
    switch (msg.type) {
      // 宿主转发来的操作提示：在 webview 内自绘提示条，几秒后自动消失
      case 'showToast': {
        showReaderToast(msg.message, msg.level);
        break;
      }

      /**
       * 宿主请求生成「全文双语精读稿」。
       * 「导出笔记」按钮与命令面板命令都走这里，保证只有一条导出实现。
       */
      case 'buildReadingDoc': {
        let markdown = '';
        let errorText = '';
        try {
          markdown = buildReadingDocMarkdown();
        } catch (e) {
          errorText = (e && e.message) || String(e);
          console.error('[Viewer] 生成双语精读稿失败:', e);
        }
        try {
          vscode.postMessage({
            type: 'saveReadingDoc',
            markdown,
            errorText,
            suggestedName: suggestedReadingDocName()
          });
        } catch (e) {
          console.error('[Viewer] 回传精读稿失败:', e);
        }
        break;
      }
      case 'initPdfData': {
        if (msg.fileName) {
          dom.paperTitle.textContent = msg.fileName;
          dom.paperTitle.title = msg.fileName;
        }
        // 版面分割引擎要在第一次 renderPage 之前就位（renderPage 会据此决定是否请视觉）
        if (msg.segmentationEngine) visionEngine = msg.segmentationEngine;
        // 视觉结果能不能真的改写分段（合并/拆分）：默认允许，宿主可关
        visionSurgeryAllowed = msg.visionSurgery !== false;
        // 视觉模型名（换模型 → 每页视觉缓存判废重判，见 isUsableVisionCache）
        if (msg.visionModel !== undefined) configuredVisionModel = String(msg.visionModel || '');
        if (msg.paperData) {
          paperData = msg.paperData;
          // AI 答疑记录随论文数据一起回来（旧版没有这个字段）
          paperData.aiQa = Array.isArray(paperData.aiQa) ? paperData.aiQa : [];
          // 以往翻过的页的段落也一起回来：导出全文精读稿不依赖"这次翻了哪些页"
          if (paperData.pageArchive && typeof paperData.pageArchive === 'object') {
            Object.keys(paperData.pageArchive).forEach(k => {
              const pageNum = Number(k);
              const archived = paperData.pageArchive[k];
              if (Number.isFinite(pageNum) && Array.isArray(archived) && archived.length > 0) {
                pageParaArchive.set(pageNum, archived);
              }
            });
          }
          // 引擎标识要在任何翻译查找之前就位，否则会命中上一个引擎的缓存
          if (msg.engineTag) currentEngineTag = msg.engineTag;
          updateNotesBadge();
          renderNotesList();
        }

        try {
          const loadingTask = window.pdfjsLib.getDocument({
            data: new Uint8Array(msg.data),
            cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
            cMapPacked: true
          });

          pdfDoc = await loadingTask.promise;
          totalPages = pdfDoc.numPages;
          dom.pageCount.textContent = totalPages;
          dom.pageNumberInput.max = totalPages;
          updateReadingProgress();

          // 打开即"适合窗口宽度"，并开始监听左栏尺寸变化
          setupAutoFitResize();
          autoFitEnabled = true;
          updateFitButtonState();
          // 首次渲染前先算出贴合比例，避免先用 1.25 渲染一帧再跳变
          try {
            const firstPage = await pdfDoc.getPage(1);
            const firstWidth = firstPage.getViewport({ scale: 1.0 }).width;
            renderedUnscaledWidth = firstWidth;
            const fit = computeFitScaleFromWidth(firstWidth);
            if (fit !== null) {
              currentScale = fit;
              updateZoomLabel();
            }
          } catch (e) {
            console.warn('[Viewer] 初始适应宽度计算失败，回退默认比例:', e);
          }
          renderPage(1);
        } catch (err) {
          console.error('[Webview] Error loading PDF:', err);
          dom.loadingOverlay.innerHTML = `<p style="color: #ff6b6b;">加载 PDF 文件出错: ${err.message}</p>`;
        }
        break;
      }

      case 'pageStructureResult': {
        handlePageStructureResult(msg);
        break;
      }

      case 'pageStructureError': {
        console.warn('[Webview] Page structure error, keeping local cards:', msg.message);
        break;
      }


      case 'translateResult': {
        handleTranslateResult(msg);
        break;
      }

      case 'selectionTranslateResult': {
        handleSelectionTranslateResult(msg);
        break;
      }

      case 'aiQuestionStart': {
        handleAiQuestionStart(msg);
        break;
      }

      case 'aiQuestionDelta': {
        handleAiQuestionDelta(msg);
        break;
      }

      case 'aiQuestionDone': {
        handleAiQuestionDone(msg);
        break;
      }

      case 'aiQuestionError': {
        handleAiQuestionError(msg);
        break;
      }

      /** 视觉分割结果：把类型/顺序/丢弃应用到当前页（坐标不动） */
      case 'visionSegmentationResult': {
        visionPending.delete(Number(msg.page));
        if (Number(msg.page) !== currentPage) {
          // 用户已经翻页了：结果仍缓存下来（钱已经花了），下次回到这页直接用
          if (msg.result) cacheVisionStructure(Number(msg.page), msg.result);
          break;
        }
        {
          const page = Number(msg.page);
          const result = msg.result || {};
          const model = result.model || '视觉模型';
          const fixes = result.fixes || '';
          // 视觉手术默认开：真的按模型的判断合并/拆分。关掉时退化成"只改类型/顺序/丢弃"。
          let applied;
          try {
            applied = visionSurgeryAllowed ? applyVisionStructure(page, result) : applyVisionSegments(page, result);
          } catch (e) {
            // 手术出任何异常都不能让用户只剩一屏半成品：退回"只改类型"的老路径再试一次
            console.error('[Viewer] 视觉手术失败，回退到只改类型:', e);
            try {
              applied = applyVisionSegments(page, result);
            } catch (e2) {
              showVisionBadge(`视觉结果应用失败：${(e2 && e2.message) || e2}`, 'error');
              break;
            }
          }
          const summary = applied.summary || `校正 ${applied.changed} 处`;
          showVisionBadge(
            `视觉重排完成：${model} 判断 ${applied.applied} 段 · ${summary}${fixes ? ` · ${fixes}` : ''}`
          );
          setTimeout(() => showVisionBadge(''), 8000);
          vscode.postMessage({
            type: 'showToast',
            message: `视觉重排：${summary}（${model}）`,
            level: 'info'
          });
        }
        break;
      }

      case 'visionSegmentationError': {
        visionPending.delete(Number(msg.page));
        showVisionBadge(`视觉重排失败：${msg.errorText || '未知错误'}`, 'error');
        break;
      }

      case 'modelInfo': {
        handleModelInfo(msg);
        break;
      }
    }
  });

  // ====================== 页面渲染逻辑 ======================
  async function renderPage(pageNum) {
    if (!pdfDoc) return;
    if (isRendering) {
      pendingRenderPage = pageNum;
      return;
    }

    isRendering = true;
    currentPage = pageNum;
    dom.pageNumberInput.value = pageNum;
    updateReadingProgress();

    hideSelectionToolbar();
    hideQuickTranslatePopover();

    // 零闪烁渲染架构：先在离线容器构建新页面，待 Canvas 与 TextLayer 完全准备就绪后再一次性无缝替换
    const newPageWrapper = document.createElement('div');
    newPageWrapper.className = 'pdf-page-wrapper';
    newPageWrapper.id = `pageWrapper_${pageNum}`;

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    newPageWrapper.appendChild(canvas);

    // 覆盖在 Canvas 上的高精度荧光高光层
    const focusHighlightLayer = document.createElement('div');
    focusHighlightLayer.className = 'precision-highlight-overlay';
    focusHighlightLayer.id = `focusHighlightLayer_${pageNum}`;
    newPageWrapper.appendChild(focusHighlightLayer);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer textLayer';
    textLayerDiv.id = `textLayer_${pageNum}`;
    newPageWrapper.appendChild(textLayerDiv);

    const annotLayerDiv = document.createElement('div');
    annotLayerDiv.className = 'annotation-layer-overlay';
    annotLayerDiv.id = `annotLayer_${pageNum}`;
    newPageWrapper.appendChild(annotLayerDiv);

    try {
      const page = await pdfDoc.getPage(pageNum);
      let viewport = page.getViewport({ scale: currentScale });

      // 自动适应：只要处于自动模式，每次渲染都按左栏当前宽度重算比例。
      // 放在渲染入口（而不是只挂在 resize 上）有个好处——翻页遇到不同尺寸的页面
      // （例如横向大图页）时也会自动贴合，不会横向溢出。
      const unscaledWidth = viewport.width / (currentScale || 1);
      if (autoFitEnabled && unscaledWidth > 0) {
        const fit = computeFitScaleFromWidth(unscaledWidth);
        if (fit !== null && Math.abs(fit - currentScale) > 0.003) {
          currentScale = fit;
          viewport = page.getViewport({ scale: currentScale });
          updateZoomLabel();
        }
      }
      renderedUnscaledWidth = unscaledWidth;
      currentViewport = viewport;

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      newPageWrapper.style.width = `${Math.floor(viewport.width)}px`;
      newPageWrapper.style.height = `${Math.floor(viewport.height)}px`;
      newPageWrapper.style.setProperty('--scale-factor', `${viewport.scale}`);

      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      const textContent = await page.getTextContent();
      currentTextContent = textContent;
      textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
      textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;
      textLayerDiv.style.setProperty('--scale-factor', `${viewport.scale}`);

      const textDivs = [];
      if (window.pdfjsLib.renderTextLayer) {
        await window.pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport: viewport,
          textDivs: textDivs
        }).promise;
      }

      // 将 PDF 几何点阵物理坐标准确绑定至每个 textDiv
      if (textContent && textContent.items && textDivs.length > 0) {
        textContent.items.forEach((it, i) => {
          const div = textDivs[i];
          if (div) {
            div._pdfX = it.transform[4];
            div._pdfY = it.transform[5];
            div._pdfH = it.height;
            div._pdfW = it.width;
            div._pdfIdx = i;
          }
        });
      }

      // 一次性无缝装载至主视口容器（彻底告别缩放与翻页白屏闪烁！）
      dom.pdfViewerContainer.innerHTML = '';
      dom.pdfViewerContainer.appendChild(newPageWrapper);

      // 提取文献学术段落结构（字符级映射引擎）
      buildAcademicLayout(pageNum, textContent, textDivs, viewport);

      // 绑定 PDF 点击与段落高亮双向联动事件
      bindPdfClickAlignment(textLayerDiv);

      // 渲染用户保存的划线批注
      renderPageAnnotations(pageNum, annotLayerDiv);

      // 若当前已选定高亮段落/句子，在重绘/缩放后依据最新尺寸重新渲染高光矩形
      if (activeFocusPara) {
        const match = currentParagraphs.find(p => p.id === activeFocusPara.id) || currentParagraphs[0];
        if (match) {
          focusParagraphOnPdf(match, activeFocusSentIdx);
        }
      }

      if (currentRightView === 'article') {
        renderArticleFlow(pageNum, currentParagraphs);
      }

      renderedScale = currentScale;
      newPageWrapper.style.transform = 'none';

    } catch (err) {
      console.error('[Webview] Render page error:', err);
    } finally {
      isRendering = false;
      if (pendingRenderPage !== null) {
        const next = pendingRenderPage;
        pendingRenderPage = null;
        renderPage(next);
      }
    }
  }

  // ====================== 核心：学术文献双栏高保真版面解析器 ======================
  function buildAcademicLayout(pageNum, textContent, textDivs, viewport) {
    // 视觉状态条属于"这一帧的这一页"：换页或重渲染时先清掉旧的，
    // 否则翻页后还留着上一页的改动摘要（看起来像本页的结论）。
    // 视觉请求还在飞时保留进度提示；结果回来命中缓存/新结果时会重新显示。
    if (!visionPending.has(pageNum)) showVisionBadge('');

    if (!textContent || !textContent.items) {
      renderTranslationCards(pageNum, []);
      return;
    }

    const rawSpans = Array.from(textDivs).filter(d => (d.textContent || '').trim());
    if (rawSpans.length === 0) {
      renderTranslationCards(pageNum, []);
      return;
    }

    const pagePdfH = (viewport && viewport.viewBox) ? viewport.viewBox[3] : ((viewport && viewport.height) ? viewport.height / (viewport.scale || 1) : 792);
    const pagePdfW = (viewport && viewport.viewBox) ? viewport.viewBox[2] : ((viewport && viewport.width) ? viewport.width / (viewport.scale || 1) : 612);

    // 1. 深度动态过滤页眉与页脚（彻底消除页码、DOI、出版版权及页底栏线串入正文）
    const spans = rawSpans.filter(span => {
      const sy = span._pdfY !== undefined ? span._pdfY : 0;
      const sh = span._pdfH !== undefined ? span._pdfH : 9;
      const t = (span.textContent || '').trim();

      // 页底绝对过滤阈值：标准学术文献底边距通常在 36~52 pt
      if (sy < 52) return false;
      // 页眉绝对过滤阈值：通常在页面顶端 45 pt 内
      if (sy > pagePdfH - 45) return false;

      // 智能识别页脚常见模式（页码数字、DOI、期刊/会议版权信息、下载授权信息）
      if (sy < 65) {
        if (/^\d+(\s+of\s+\d+)?$/i.test(t)) return false;
        if (/^[-—–]\s*\d+\s*[-—–]$/.test(t)) return false;
        if (/^(https?:\/\/|doi:|10\.\d{4,}\/)/i.test(t)) return false;
        if (/^(IEEE|ACM|PNAS|Springer|Elsevier|Nature|Science|arXiv|CVPR|ICCV|ECCV|NeurIPS|ICML|AAAI)/i.test(t)) return false;
        if (/^(\d{4}[-—–]\d{4}|\d{3}[-—–]\d[-—–]\d+)/.test(t)) return false;
        if (/^(Authorized licensed use|Downloaded on|Copyright|All rights reserved|©)/i.test(t)) return false;
      }

      // 顶部特定栏名或标题过滤
      if (sy > pagePdfH - 60) {
        if (t === 'NEUROSCIENCE' || /^\d+\s*\|\s*www\.pnas/i.test(t) || /www\.pnas\.org/i.test(t)) return false;
        if (/^\d+$/.test(t) && sh < 12) return false;
      }

      return true;
    });

    // 2. 版面结构判定：**从数据里检测分栏结构**，而不是写死"页宽 49.5%"。
    //
    // 判据用"行首 x 的聚类"（经典做法，比覆盖率直方图稳健）：
    //   双栏页面的文字行，行首会聚成两簇（左栏左边距、右栏左边距）；
    //   单栏页面只有一簇。通栏行（标题、大图注）的行首在左边界，只会加强左簇，不会干扰判定。
    // 分栏线取"左栏行右边缘的中位数"与"右栏行左边距"的中点——这是真正的沟槽位置，
    // 因此非对称双栏、A4/Letter/其它页宽都能自适应。
    const detectColumnStructure = (spanList, pageW) => {
      const FALLBACK = { twoColumn: false, gutterX: pageW * 0.495 };
      const SEG_GAP = Math.max(4, pageW * 0.01); // 行内片段切分间隙（约 6pt）

      // 1) 按 y 聚成视觉行，并在行内按横向间隙切成「片段」。
      // 关键：双栏论文左右两栏的文字**共享同一个 y**，如果只看整行行首，
      // 右栏行会被并进左栏行里、右栏行首直接消失 → 聚类失效。
      // 切成片段后，左栏片段行首在左边距、右栏片段行首在右栏左边距，两簇清晰可见。
      const rows = [];
      spanList.forEach(s => {
        const y = s._pdfY !== undefined ? s._pdfY : 0;
        const x = s._pdfX !== undefined ? s._pdfX : 0;
        const w = s._pdfW !== undefined ? s._pdfW : 0;
        const len = (s.textContent || '').trim().length;
        let r = null;
        for (const it of rows) {
          if (Math.abs(it.y - y) <= 3.5) {
            r = it;
            break;
          }
        }
        if (!r) {
          r = { y, segs: [], textLen: 0 };
          rows.push(r);
        }
        r.textLen += len;
        // 就近并入已有片段（间隙足够小）
        let placed = false;
        for (const sg of r.segs) {
          if (Math.min(sg.maxX, x + w) - Math.max(sg.minX, x) >= -SEG_GAP) {
            sg.minX = Math.min(sg.minX, x);
            sg.maxX = Math.max(sg.maxX, x + w);
            placed = true;
            break;
          }
        }
        if (!placed) r.segs.push({ minX: x, maxX: x + w });
      });
      if (rows.length < 10) return FALLBACK;

      // 2) 片段行首 x 直方图 → 合并成簇
      const BIN = 4;
      const hist = new Map();
      rows.forEach(r => {
        r.segs.forEach(sg => {
          const b = Math.round(sg.minX / BIN) * BIN;
          hist.set(b, (hist.get(b) || 0) + 1);
        });
      });
      const peaks = [...hist.entries()]
        .filter(([, n]) => n >= Math.max(3, rows.length * 0.08))
        .sort((a, b) => a[0] - b[0]);
      const clusters = [];
      peaks.forEach(([x, n]) => {
        const last = clusters[clusters.length - 1];
        if (last && x - last.max <= BIN * 3) {
          last.max = x;
          last.count += n;
        } else {
          clusters.push({ min: x, max: x, count: n });
        }
      });
      if (clusters.length < 2) return FALLBACK;

      // 3) 枚举所有候选分割缝，选"最像双栏"的那一个。
      // 不能用"最大间隔"：以图/表为主的页面上，标签之间会出现比真正的沟槽更大的空隙
      // （实测 STM 第 7 页真正沟槽 24pt，而标签区空隙 64pt），最大间隔会把分栏线选错位置。
      const tightFraction = arr => {
        if (arr.length < 5) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const med = s[Math.floor(s.length / 2)];
        if (!(med > 0)) return 0;
        return arr.filter(e => Math.abs(e - med) <= med * 0.08).length / arr.length;
      };
      const median = arr => {
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };

      let best = null;
      for (let i = 1; i < clusters.length; i++) {
        const leftClusterEnd = clusters[i - 1].max;
        const rightStart = clusters[i].min;
        const gap = rightStart - leftClusterEnd;
        if (gap < pageW * 0.02) continue; // 太窄，不可能是沟槽
        if (rightStart < pageW * 0.2 || leftClusterEnd > pageW * 0.8) continue; // 沟槽应在页面中段

        const leftEnds = [];
        const rightEnds = [];
        const leftWidths = [];
        const rightWidths = [];
        let leftN = 0;
        let rightN = 0;
        rows.forEach(r => {
          let leftMost = -1;
          let leftMin = Infinity;
          let rightMost = -1;
          let rightMin = Infinity;
          r.segs.forEach(sg => {
            if (sg.minX <= leftClusterEnd + 8 && sg.maxX < rightStart - 10) {
              leftMost = Math.max(leftMost, sg.maxX);
              leftMin = Math.min(leftMin, sg.minX);
            }
            if (sg.minX >= rightStart - 8) {
              rightMost = Math.max(rightMost, sg.maxX);
              rightMin = Math.min(rightMin, sg.minX);
            }
          });
          if (leftMost > 0) {
            leftN++;
            if (r.textLen >= 10) {
              leftEnds.push(leftMost);
              leftWidths.push(leftMost - leftMin);
            }
          }
          if (rightMost > 0) {
            rightN++;
            if (r.textLen >= 10) {
              rightEnds.push(rightMost);
              rightWidths.push(rightMost - rightMin);
            }
          }
        });

        if (leftN < 6 || rightN < 6) continue;
        // 两侧都要"像正文"：两端对齐的正文行外边缘高度集中，图内零散标签则不然
        if (tightFraction(leftEnds) < 0.5) continue;
        if (tightFraction(rightEnds) < 0.5) continue;

        // 两侧都必须存在"接近满栏宽的长行"。
        // 这一条专门挡掉"表格单元格被切成片段"造成的假双栏——那些片段都是短行，
        // 一旦误判成双栏，整页文字会被拆成"先左栏全部、再右栏全部"，读序彻底乱掉。
        const colWidth = rightStart - clusters[0].min;
        const longLine = w => w >= colWidth * 0.55;
        if (leftWidths.filter(longLine).length < 6) continue;
        if (rightWidths.filter(longLine).length < 6) continue;

        // 两侧正文行越均衡，越像真正的双栏
        const score = Math.min(leftN, rightN);
        if (!best || score > best.score) {
          best = { score, gutterX: (median(leftEnds) + rightStart) / 2, leftN, rightN };
        }
      }

      if (!best) return FALLBACK;
      return { twoColumn: true, gutterX: best.gutterX, leftN: best.leftN, rightN: best.rightN };
    };

    const colStruct = detectColumnStructure(spans, pagePdfW);
    const gutterX = colStruct.gutterX;
    const isTwoColumnPage = colStruct.twoColumn;
    const isSingleColumnPage = !isTwoColumnPage;
    // 单栏时把"分栏线"推到页面之外，使所有 span 都归入同一栏
    const effectiveGutterX = isSingleColumnPage ? pagePdfW * 2 : gutterX;
    console.log(
      `[Viewer] 版面：${isSingleColumnPage ? '单栏' : `双栏(分栏线 x=${gutterX.toFixed(0)})`}` +
        `  左${colStruct.leftN || 0}/右${colStruct.rightN || 0}  页宽${pagePdfW.toFixed(0)}`
    );

    // 2.2 先把 span 聚成「物理行」(run)，再算每行的横向跨度。
    // 【关键修复】判断"是否通栏"和"属于哪一栏"必须看**整行**跨度，而不是单个 span。
    // PDF 常把一条图注拆成多个窄 span（"Figure 3." + "Overview of the" + "framework."），
    // 逐个 span 判断会把同一行文字劈进左右两栏——这正是图注被切成左右两截的原因。
    //
    // 【陷阱一】双栏论文里左右两栏的文字常常共享同一个 y 坐标！
    // 所以"同一 y"绝不等于"同一行"：还必须要求横向间隙足够小，
    // 且该间隙不能是那条分栏沟槽——否则左右栏会被并成整页宽的一行，
    // 每行都变成"通栏"，整页正文会被判成图表注并合并成一个巨大段落。
    // 【陷阱二】单栏页**没有沟槽**，此时必须关掉沟槽间隔规则，否则一行正文会被从中间劈成两段。
    const RUN_Y_TOL = 3.5; // 同一行的 y 容差（pt）
    const RUN_GAP_TOL = pagePdfW * 0.041; // 同一行内两个片段允许的最大横向间隙
    const GUTTER_GAP_MIN = pagePdfW * 0.02; // 间隙大于此值且跨越分栏线 → 认定为沟槽，不许并成一行

    const lineGroups = [];
    spans.forEach(s => {
      const y = s._pdfY !== undefined ? s._pdfY : 0;
      const x = s._pdfX !== undefined ? s._pdfX : 0;
      const w = s._pdfW !== undefined ? s._pdfW : 0;
      const sMin = x;
      const sMax = x + w;

      let host = null;
      for (const g of lineGroups) {
        if (Math.abs(g.y - y) > RUN_Y_TOL) continue;
        const adjacent = g.spans.some(o => {
          const oMin = o._pdfX !== undefined ? o._pdfX : 0;
          const oMax = oMin + (o._pdfW !== undefined ? o._pdfW : 0);
          const gapStart = Math.min(oMax, sMax);
          const gapEnd = Math.max(oMin, sMin);
          const gap = gapEnd - gapStart;
          if (gap > RUN_GAP_TOL) return false;
          // 用 effectiveGutterX：单栏页时它被推到页面之外，沟槽规则自动失效
          if (gap > GUTTER_GAP_MIN && gapStart < effectiveGutterX && gapEnd > effectiveGutterX) return false;
          return true;
        });
        if (adjacent) {
          host = g;
          break;
        }
      }

      if (!host) {
        host = { y, minX: sMin, maxX: sMax, spans: [] };
        lineGroups.push(host);
      }
      if (sMin < host.minX) host.minX = sMin;
      if (sMax > host.maxX) host.maxX = sMax;
      host.spans.push(s);
    });
    const lineGroupOf = new Map();
    lineGroups.forEach(g => g.spans.forEach(s => lineGroupOf.set(s, g)));

    // 3. 通用学术图表注起始标签正则
    // 覆盖更多期刊写法：Figure/Fig./FIGURE、Table/Tab./TABLE、Extended Data、Supplementary、
    // Box/Algorithm/Scheme/Chart，以及 "(a) Figure 2:" 这种带子图编号前缀的写法。
    // 注意：必须锚定在行首（正文里的 "as shown in Fig. 2" 不会命中，避免把正文误判成图注）。
    const captionLabelRegex =
      /^(?:[(\[](?:[a-h]|\d{1,2})[)\]]\s+)?(?:(?:Extended\s+Data|Supplement(?:ary|al)?|SI)\s+)?(?:Fig(?:\.|ure)?|Tab(?:\.|le)?|Box|Algorithm|Scheme|Chart|Exhibit|TABLE)\s*\.?\s*(?:\d+|[IVXLCDM]+)(?:\s*[.:：)—–-])?/i;

    // 4. 将 spans 严格按物理分栏分流（先分栏！绝对禁止跨栏同行排序！）
    const topHeaders = [];
    const metadataSpans = [];
    const col1Spans = [];
    const col2Spans = [];
    const crossColumnCaptionSpans = [];
    const footnoteSpans = [];

    /** 分栏线两侧各需越过多少 pt 才算"通栏"（沟槽通常 15~25pt 宽） */
    const GUTTER_CLEARANCE = 15;

    spans.forEach(span => {
      const sx = span._pdfX !== undefined ? span._pdfX : 0;
      const sy = span._pdfY !== undefined ? span._pdfY : 0;
      const sh = span._pdfH !== undefined ? span._pdfH : 9;
      const sw = span._pdfW !== undefined ? span._pdfW : 0;
      const text = (span.textContent || '').trim();

      // 用「整行」的跨度来判定，保证同一行的所有 span 一定进同一栏
      const g = lineGroupOf.get(span);
      const lineMinX = g ? g.minX : sx;
      const lineMaxX = g ? g.maxX : sx + sw;
      const lineWidth = lineMaxX - lineMinX;
      const lineCenterX = (lineMinX + lineMaxX) / 2;

      // 判断是否为通栏大元素（整行横跨左右两栏）
      // 单栏版式下禁用该判定，否则整页正文都会被当成图表注
      const isCrossColumn =
        !isSingleColumnPage &&
        (lineWidth > 320 ||
          (lineMinX < gutterX - GUTTER_CLEARANCE && lineMaxX > gutterX + GUTTER_CLEARANCE));

      if (pageNum === 1 && sy > 660 && (sh > 14 || isCrossColumn)) {
        // 第一页大标题
        topHeaders.push(span);
      } else if (pageNum === 1 && sy >= 600 && (isCrossColumn || (sy > 610 && sh >= 11) || (sy > 620 && text === '*'))) {
        // 第一页作者姓名、所属机构、通栏居中元数据
        metadataSpans.push(span);
      } else if (((sh <= 6.8 && sy < 160) || (sy < 100 && (text.startsWith('*') || text.includes('internship') || text.includes('supported') || text.includes('Corresponding')))) && pageNum === 1) {
        // 第一页底部作者脚注 (Corresponding author / Equal contribution)
        footnoteSpans.push(span);
      } else if (isCrossColumn) {
        // 通栏跨双栏大图表注
        crossColumnCaptionSpans.push(span);
      } else if (lineCenterX < effectiveGutterX) {
        // 100% 纯左栏 (Column 1) - 绝不与右栏混淆！(单栏版式下即"唯一一栏")
        col1Spans.push(span);
      } else {
        // 100% 纯右栏 (Column 2) - 绝不与左栏混淆！
        col2Spans.push(span);
      }
    });

    // 5. 栏内单行组装函数 (按 Y 降序自上而下，同一行按 X 升序自左向右)
    function spansToLines(spanList) {
      const sorted = [...spanList].sort((a, b) => {
        const ya = a._pdfY !== undefined ? a._pdfY : 0;
        const yb = b._pdfY !== undefined ? b._pdfY : 0;
        const ha = a._pdfH !== undefined ? a._pdfH : 9;
        const hb = b._pdfH !== undefined ? b._pdfH : 9;
        const effYa = (ha > 18 && (a.textContent || '').trim().length === 1) ? ya + ha - 9 : ya;
        const effYb = (hb > 18 && (b.textContent || '').trim().length === 1) ? yb + hb - 9 : yb;

        if (Math.abs(effYa - effYb) > 3.5) return effYb - effYa;
        const xa = a._pdfX !== undefined ? a._pdfX : 0;
        const xb = b._pdfX !== undefined ? b._pdfX : 0;
        return xa - xb;
      });

      const lines = [];
      let curLine = null;
      for (const span of sorted) {
        const sy = span._pdfY !== undefined ? span._pdfY : 0;
        const sx = span._pdfX !== undefined ? span._pdfX : 0;
        const sh = span._pdfH !== undefined ? span._pdfH : 9;
        const sw = span._pdfW !== undefined ? span._pdfW : 0;

        if (!curLine || Math.abs(curLine.y - sy) > 3.5) {
          curLine = { y: sy, h: sh, minX: sx, maxX: sx + sw, spans: [span] };
          lines.push(curLine);
        } else {
          curLine.spans.push(span);
          curLine.minX = Math.min(curLine.minX, sx);
          curLine.maxX = Math.max(curLine.maxX, sx + sw);
          curLine.h = Math.max(curLine.h, sh);
        }
      }
      return lines;
    }

    // 6. 分别独立对左栏和右栏组行（彻底杜绝左右栏同行被捏成一句话！）
    const headerLines = spansToLines(topHeaders);
    const metadataLines = spansToLines(metadataSpans);
    const col1LinesRaw = spansToLines(col1Spans);
    const col2LinesRaw = spansToLines(col2Spans);
    const crossCaptionLines = spansToLines(crossColumnCaptionSpans);
    const footnoteLines = spansToLines(footnoteSpans);

    headerLines.forEach(l => l.section = 'header');
    metadataLines.forEach(l => l.section = 'metadata');
    footnoteLines.forEach(l => l.section = 'footnote');

    // 通栏行不能一律当图注！
    // 旧版 `crossCaptionLines.forEach(l => l.section = 'caption')` 把整个通栏桶当成图注，
    // 于是通栏的图表内部文字（框架图里的 "Memory:Past frames…"、箭头乱码等）全被当成图注翻译了。
    // 现在只有"以图注标签开头"的行及其紧跟折行才算图注，其余先留作中性 'cross'，
    // 之后由图表区域后处理决定是图表标签还是正文。
    (function markCrossCaptionBlocks() {
      let inCaption = false;
      let lastY = null;
      let capH = 9;
      crossCaptionLines.forEach(line => {
        const text = line.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
        if (captionLabelRegex.test(text)) {
          line.section = 'caption';
          inCaption = true;
          lastY = line.y;
          capH = line.h;
          return;
        }
        if (inCaption && lastY !== null && Math.abs(lastY - line.y) <= Math.max(capH, 9) * 1.8) {
          line.section = 'caption';
          lastY = line.y;
          return;
        }
        inCaption = false;
        line.section = 'cross';
      });
    })();

    // 7. 在各自栏目内部，智能识别属于该栏的图表注与图表绘图标签
    function processColumnLines(linesRaw, colName) {
      const processed = [];
      for (let i = 0; i < linesRaw.length; i++) {
        const line = linesRaw[i];
        const lineText = line.spans.map(s => (s.textContent || '').trim()).join(' ').trim();

        if (captionLabelRegex.test(lineText)) {
          // 发现栏内图表注首行 (如 Figure 1: ...)
          line.section = 'caption';
          processed.push(line);

          // 检查该图注上方的若干行是否为图表内部标签 (如 (d), Memory, Read, First 等)
          for (let prevIdx = processed.length - 2; prevIdx >= 0; prevIdx--) {
            const pLine = processed[prevIdx];
            if (pLine.section === 'caption' || pLine.section === 'figure-label') continue;
            const vDist = Math.abs(pLine.y - line.y);
            if (vDist > 260) break;
            const pText = pLine.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
            const isSubfig = /^\(?[a-zA-Z0-9]\)?$/.test(pText);
            const isShortLabel = pText.length <= 50 && !/[.!?。！？]$/.test(pText);
            if (isSubfig || isShortLabel) {
              pLine.section = 'figure-label';
            } else {
              break;
            }
          }

          // 收集后续紧跟的图注折行 (字号相近且行距紧凑)
          const capFontH = line.h;
          let lastCapY = line.y;
          while (i + 1 < linesRaw.length) {
            const nextL = linesRaw[i + 1];
            const nextText = nextL.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
            const vGap = Math.abs(lastCapY - nextL.y);

            if (captionLabelRegex.test(nextText)) break;
            if (vGap > Math.max(capFontH, 9) * 1.8) break;
            if (Math.abs(nextL.h - capFontH) > 2.0 && nextL.h > capFontH + 1.0) break;

            nextL.section = 'caption';
            processed.push(nextL);
            lastCapY = nextL.y;
            i++;
          }
        } else {
          line.section = colName;
          processed.push(line);
        }
      }
      return processed;
    }

    const col1Lines = processColumnLines(col1LinesRaw, 'col1');
    const col2Lines = processColumnLines(col2LinesRaw, 'col2');

    // 8. 绝对学术双栏阅读顺序：
    // Top Headers -> 作者元信息 (Metadata) -> 通栏大图注 (如果有且靠顶) ->
    // 左栏全部内容从上到下 (Col1) ->
    // 右栏全部内容从上到下 (Col2) ->
    // 脚注与通栏注 (Footnotes)
    let orderedLines = [];
    if (crossCaptionLines.length > 0) {
      const crossY = crossCaptionLines[0].y;
      const colTopY = Math.max(
        col1Lines.length > 0 ? col1Lines[0].y : 0,
        col2Lines.length > 0 ? col2Lines[0].y : 0
      );
      if (crossY > colTopY) {
        orderedLines = [...headerLines, ...metadataLines, ...crossCaptionLines, ...col1Lines, ...col2Lines, ...footnoteLines];
      } else {
        orderedLines = [...headerLines, ...metadataLines, ...col1Lines, ...col2Lines, ...crossCaptionLines, ...footnoteLines];
      }
    } else {
      orderedLines = [...headerLines, ...metadataLines, ...col1Lines, ...col2Lines, ...footnoteLines];
    }

    // 8.4 图注折行补齐。
    // 图注的**最后一行**通常比前几行窄，会被分栏逻辑分进某一栏里，
    // 于是图注尾巴留在正文里（表现为"正文第一段其实是图注的一部分"）。
    // 这里从图注块往下按行距继续吸收折行，遇到行距变大或章节标题就停。
    (function extendCaptionBlocks() {
      const textOf = line => line.spans.map(s => (s.textContent || '').trim()).join(' ').trim();
      const heads = orderedLines.filter(l => l.section === 'caption' && captionLabelRegex.test(textOf(l)));
      heads.forEach(head => {
        const below = orderedLines.filter(l => l !== head && l.y < head.y).sort((a, b) => b.y - a.y);
        let lastY = head.y;
        let capH = head.h;
        let prevGap = null; // 图注自身的行距（自适应基准）
        for (const line of below) {
          const gap = lastY - line.y;
          // 行距上限用"图注已有行距"的 1.6 倍相对判断，而不是靠字号：
          // 字号偏大时 1.8×字号 会松到把下一张表的数据行也吞进来。
          const limit = prevGap !== null ? prevGap * 1.6 : Math.max(capH, 9) * 1.8;
          if (gap > limit) break;
          if (line.section === 'caption') {
            prevGap = gap > 0 ? gap : prevGap;
            lastY = line.y;
            capH = line.h;
            continue;
          }
          if (line.section === 'header' || line.section === 'metadata') continue;
          // 横向要在图注的范围内
          if (line.maxX < head.minX - 10 || line.minX > head.maxX + 10) continue;
          const t = textOf(line);
          if (!t) continue;
          if (/^(\d+(\.\d+)*\.?|[IVXLC]+\.)\s+[A-Z]/.test(t)) break; // 章节标题 → 图注结束
          // 表格数据行（一行里三个以上数字）不是图注文字
          const numCount = (t.match(/(?:^|[^\w.])\d+(?:\.\d+)?/g) || []).length;
          if (numCount >= 3) break;
          line.section = 'caption';
          prevGap = gap > 0 ? gap : prevGap;
          lastY = line.y;
          capH = line.h;
        }
      });
    })();

    // 8.5 图表区域后处理：把图注上方的图表内部内容整片标成 figure-label。
    //
    // 为什么必须在这里做：图注往往是**通栏**的，上面那套 processColumnLines 只在单栏的
    // 行列表里跑，遇不到通栏图注；而图表标签（轴标签、图例、子图编号、乃至 PDF 提取出的
    // 箭头乱码）分散在各栏里，结果全留在正文里被翻译。
    //
    // 做法：以"以图注标签开头"的那一行为基准，往上扫一段带状区域，整片标为图表标签，
    // 一遇到"确定是正文"的行就停下——用"满行宽度"来识别正文，因为正文行是两端对齐的满行，
    // 而图表标签是零散的短行。这样既能整片吃掉图表区域，又不会误伤图注上方的正文段落。
    (function markFigureRegions() {
      const FIG_BAND = 320; // 从图注往上扫多远（pt）

      const textOf = line => line.spans.map(s => (s.textContent || '').trim()).join(' ').trim();

      // 各栏的"满行宽度"基准：只用**确定是正文**的行（以句末标点收尾）来标定，
      // 否则图表里那些宽行会把基准抬高，反而让判定失效。
      const colMaxExtent = {};
      orderedLines.forEach(l => {
        if (l.section !== 'col1' && l.section !== 'col2') return;
        const t = textOf(l);
        if (!/[.!?。！？]\s*$/.test(t)) return;
        const w = l.maxX - l.minX;
        if (!colMaxExtent[l.section] || w > colMaxExtent[l.section]) colMaxExtent[l.section] = w;
      });

      /** 这一行能不能确定是正文？（能确定就停止向上扩展图表区域） */
      const definitelyBody = line => {
        const t = textOf(line);
        if (!t) return false;
        if (t.length > 80) return true; // 长行必是正文
        if (/^(\d+(\.\d+)*\.?|[IVXLC]+\.)\s+[A-Z]/.test(t)) return true; // 章节标题
        if (
          /^(abstract|introduction|related work|background|method|methods|methodology|approach|experiments?|results?|discussion|conclusions?|references)\b/i.test(
            t
          )
        ) {
          return true;
        }
        const letters = (t.match(/[A-Za-z]/g) || []).length;
        const words = (t.match(/[A-Za-z][A-Za-z'\-]*/g) || []).length;
        // 以句末标点收尾 **且确实像句子** 才算正文。
        // 不能只看标点：图表标签里常有 "concat." 这种以句号结尾的短标签，
        // 一旦被当成正文就会让向上扫描提前中断，图表内容又漏回正文里。
        if (/[.!?。！？]\s*$/.test(t) && (t.length >= 30 || words >= 5)) return true;
        // 满行（两端对齐的正文行）→ 正文；但必须"以字母为主"且用词不重复——
        // 图里的标签行（如 "Key Value Key Value Key Value"）宽度也接近满栏，
        // 只靠几何无法区分，而正文行的用词几乎不重复。
        const w = line.maxX - line.minX;
        const m = colMaxExtent[line.section];
        if (m && w >= 150 && w >= m * 0.8 && letters / Math.max(1, t.length) > 0.5) {
          const wordList = t.toLowerCase().match(/[a-z][a-z'\-]*/g) || [];
          const uniq = new Set(wordList).size;
          const repetitive = wordList.length >= 3 && uniq / wordList.length < 0.7;
          if (!repetitive) return true;
        }
        return false;
      };

      // 只把"图注的首行"当作扫描基准（续行不能当基准，否则会把图注自己吃掉）
      const captionHeads = orderedLines.filter(
        l => l.section === 'caption' && captionLabelRegex.test(textOf(l))
      );

      captionHeads.forEach(cap => {
        const above = orderedLines
          .filter(l => l !== cap && l.y > cap.y && l.y - cap.y <= FIG_BAND)
          .filter(l => !(l.maxX < cap.minX - 20 || l.minX > cap.maxX + 20)) // 横向需与图注范围重叠
          .sort((a, b) => a.y - b.y); // 由近及远向上

        for (const line of above) {
          if (line.section === 'caption') continue; // 绝不把图注本身吃掉
          if (line.section === 'header' || line.section === 'metadata') break;
          if (definitelyBody(line)) break;
          line.section = 'figure-label';
        }
      });
    })();

    // 8.6 最终阅读顺序重排：把"同一条图注/同一张图"的行聚到一起，并按它们的 y 位置摆放。
    //
    // 为什么必须重排：前面是按"桶"拼接顺序的（col1 → col2 → 通栏），
    // 而一条通栏图注常常只有前几行是通栏的、**最后一行较窄会被分进某一栏**——
    // 于是同一条图注被拆到页面两端，变成两张卡片（表现为"第一个图注和最后一个其实是同一段"）。
    // 这里改为按"块"排：图表/图注行聚成块，位于正文之上的排在最前，其余排在正文之后。
    (function reorderFigureBlocks() {
      const isColLine = l => (l.section === 'col1' || l.section === 'col2') && l.section !== 'figure-label';
      const colLines = orderedLines.filter(isColLine);
      const pageLines = orderedLines.filter(
        l => l.section === 'cross' || l.section === 'caption' || l.section === 'figure-label'
      );
      if (colLines.length === 0 || pageLines.length === 0) return;

      const heads = orderedLines.filter(l => l.section === 'header' || l.section === 'metadata');
      const feet = orderedLines.filter(l => l.section === 'footnote');

      // 按 y 相邻性聚成块；类型变化或**横向不重叠**就断开。
      // 横向重叠这一条很关键：左右两栏各有一张表的图注，y 往往彼此交错，
      // 若只按 y 聚块，两栏图注的行会被交错混排成一段（实测 STM 第 6 页 Table 1 / Table 3）。
      const sorted = [...pageLines].sort((a, b) => b.y - a.y);
      const blocks = [];
      sorted.forEach(l => {
        // 与**所有仍开放的块**匹配（不能只比最后一个块：左右两栏的图注 y 交错时，
        // 只比最后一个会让同一栏的残留行另开新块，最终两栏图注仍然交错混排）
        let host = null;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.section !== l.section) continue;
          if (Math.abs(b.bottomY - l.y) > 30) continue;
          if (!(b.minX <= l.maxX + 20 && l.minX <= b.maxX + 20)) continue;
          host = b;
          break;
        }
        if (host) {
          host.lines.push(l);
          host.bottomY = Math.min(host.bottomY, l.y);
          host.minX = Math.min(host.minX, l.minX);
          host.maxX = Math.max(host.maxX, l.maxX);
        } else {
          blocks.push({
            section: l.section,
            lines: [l],
            topY: l.y,
            bottomY: l.y,
            minX: l.minX,
            maxX: l.maxX
          });
        }
      });

      const colTop = Math.max(...colLines.map(l => l.y));
      // 块整体位于正文之上（留 8pt 容差：图注尾行常与正文首行齐平）→ 排在最前
      const topBlocks = blocks.filter(b => b.bottomY > colTop - 8).sort((a, b) => b.bottomY - a.bottomY);
      const restBlocks = blocks.filter(b => b.bottomY <= colTop - 8).sort((a, b) => b.bottomY - a.bottomY);
      const flat = bs => bs.reduce((acc, b) => acc.concat(b.lines.slice().sort((x, y) => y.y - x.y)), []);

      orderedLines = [...heads, ...flat(topBlocks), ...colLines, ...flat(restBlocks), ...feet];
    })();

    // 9. 段落聚合并构建字符级精确映射表 (charMap)
    const paras = [];
    let curParaLines = [];
    let curParaType = 'body';

    function commitParagraph() {
      if (curParaLines.length === 0) return;

      const pId = paras.length;
      const para = {
        id: pId,
        type: curParaType,
        cleanText: '',
        charMap: [],
        rawSpans: [],
        sentencesEn: [],
        translation: '',
        sentenceTranslations: []
      };
      para.minX = Math.min(...curParaLines.map(l => l.minX));
      para.maxX = Math.max(...curParaLines.map(l => l.maxX));

      curParaLines.forEach(line => {
        line.spans.forEach(span => {
          para.rawSpans.push(span);
          span.setAttribute('data-para-id', `${pId}`);

          const spanText = span.textContent || '';
          let needSpace = false;
          if (para.cleanText.length > 0) {
            const lastChar = para.cleanText[para.cleanText.length - 1];
            if (lastChar === '-' || lastChar === '‐') {
              para.cleanText = para.cleanText.slice(0, -1);
              para.charMap.pop();
              needSpace = false;
            } else if (!/\s$/.test(lastChar) && !/^\s/.test(spanText) && !/^[,.;:!?’”')\]]/.test(spanText) && !/[“'(\[]$/.test(lastChar)) {
              needSpace = true;
            }
          }

          if (needSpace) {
            para.cleanText += ' ';
            para.charMap.push({ span, offset: 0 });
          }

          for (let c = 0; c < spanText.length; c++) {
            para.cleanText += spanText[c];
            para.charMap.push({ span, offset: c });
          }
        });
      });

      while (para.cleanText.length > 0 && /\s$/.test(para.cleanText)) {
        para.cleanText = para.cleanText.slice(0, -1);
        para.charMap.pop();
      }
      while (para.cleanText.length > 0 && /^\s/.test(para.cleanText)) {
        para.cleanText = para.cleanText.slice(1);
        para.charMap.shift();
      }

      if (para.cleanText.length > 0) {
        // 纯数字（页码、脚注编号、"8"）不构成可翻译段落：
        // 它们在界面上只会变成一块没意义的噪声卡片（实测 AOT p8 出现了孤立的 "8"）。
        if (/^\d{1,4}$/.test(para.cleanText.trim())) {
          curParaLines = [];
          curParaType = 'body';
          return;
        }
        para.sentencesEn = splitEnglishSentencesSmart(para.cleanText);
        paras.push(para);
      }

      curParaLines = [];
      curParaType = 'body';
    }

    let prevLine = null;
    let normalLineHeight = 9.5;
    const heights = orderedLines.map(l => l.h).filter(h => h > 5 && h < 13);
    if (heights.length > 0) normalLineHeight = heights.reduce((a, b) => a + b, 0) / heights.length;

    for (let i = 0; i < orderedLines.length; i++) {
      const line = orderedLines[i];
      const text = line.spans.map(s => s.textContent || '').join(' ').trim();
      if (!text) continue;

      let shouldStartNew = false;
      let nextType = 'body';

      // 跨区域强制换段 (栏间绝不粘连)
      if (prevLine && prevLine.section !== line.section) {
        shouldStartNew = true;
      }

      if (line.section === 'header') {
        nextType = 'title';
        if (curParaType !== 'title') shouldStartNew = true;
      } else if (line.section === 'metadata') {
        nextType = 'metadata';
        if (curParaType !== 'metadata') {
          shouldStartNew = true;
        } else if (prevLine && Math.abs(prevLine.y - line.y) > normalLineHeight * 1.35) {
          shouldStartNew = true;
        }
      } else if (line.section === 'caption') {
        nextType = 'caption';
        if (curParaType !== 'caption') {
          shouldStartNew = true;
        } else if (captionLabelRegex.test(text)) {
          shouldStartNew = true;
        }
      } else if (line.section === 'figure-label') {
        nextType = 'figure-label';
        if (curParaType !== 'figure-label') shouldStartNew = true;
      } else if (line.section === 'footnote') {
        nextType = 'footnote';
        if (curParaType !== 'footnote') shouldStartNew = true;
      } else {
        // 双栏正文区 (col1 / col2)
        if (curParaType !== 'body' && curParaType !== 'abstract' && curParaType !== 'significance' && curParaType !== 'keywords') {
          shouldStartNew = true;
          nextType = 'body';
        }

        // 通用规则：不再写死某篇论文的句子（旧版有 'Daily life requires' / 'Many routine, inwardly'，
        // 换一篇论文就完全失效，会把正文误判或漏判）
        const isAbstractStart = pageNum === 1 && /^abstract\b/i.test(text);
        const isKeywordLine =
          text.includes('|') ||
          /^(keywords|index terms|key words)\b/i.test(text) ||
          /^(keywords|index terms)\s*[:：]/i.test(text);
        const isSignificanceHeading = /^significance\b/i.test(text);

        const hasDropCap = line.spans.some(s => {
          const sh = s._pdfH !== undefined ? s._pdfH : 9;
          return sh > 18 && (s.textContent || '').trim().length === 1;
        });

        const isIndented = prevLine && (line.minX > prevLine.minX + 6);
        const prevEnded = curParaLines.length > 0 && /[.!?。！？]["'”)]?\s*$/.test(curParaLines[curParaLines.length - 1].spans.map(s => s.textContent || '').join(' ').trim());
        const isSameColumn = prevLine && prevLine.section === line.section;
        const largeVGap = isSameColumn && Math.abs(prevLine.y - line.y) > normalLineHeight * 1.45;

        // 【关键】标题必须同时满足两个条件，缺一不可：
        //   ① 上方是"段落边界"：本栏第一行，或上一行与本行之间有明显的段间空行；
        //   ② 上一行确实结束了一个句子（否则本行只是承接上一行的正文中段）。
        //
        // 为什么必须这么严：双栏排版里"一行的开头"根本不是句子/段落的开头——正文行经常以
        // method / methods / results / 数字+大写 这类词开头（因为它们承接上一行）。
        // 旧规则只看行首文本，于是把这类正文行判成章节标题 → 每行强行另起一段 →
        // 逐行翻译、译文碎片化（实测 STM 第 6 页右栏被切成 6 个单行"标题"、译文断成 7 截）。
        // 只加条件②还不够："2018 DAVIS challenge winner [20]. Our results…" 的上一行确实以句号结尾，
        // 但它与上一行行距正常（12pt，无段间空行）→ 靠条件① 才能挡住。
        const atParagraphBoundary = !isSameColumn || largeVGap;
        const prevEndedSentence = curParaLines.length > 0 && /[.!?。！？]["'”)]?\s*$/.test(curParaLines[curParaLines.length - 1].spans.map(s => s.textContent || '').join(' ').trim());

        // 以连字符结尾 = 这个词被折到下一行，说明本行是**换行后的正文**，不可能是标题。
        // 实测：致谢那一行 "Acknowledgment. This work is supported by the ICT R&D pro-" 长度 58 ≤ 60，
        // 靠行首关键词命中标题 → 把 "pro-gram" 从中间切开，剩下 "gram of MSIT/IITP…" 成了碎片卡片。
        const endsWithHyphen = /[-‐]\s*$/.test(text);

        const isHeading =
          atParagraphBoundary &&
          (curParaLines.length === 0 || prevEndedSentence) &&
          !hasDropCap &&
          !endsWithHyphen &&
          ((line.h > normalLineHeight * 1.28 && line.spans.length <= 5) ||
            (/^[0-9]+(\.[0-9]+)*\.?\s+[A-Z]/.test(text) && text.length <= 60) ||
            (/^(abstract|introduction|related work|background|method|methods|methodology|approach|experiments?|results?|discussion|conclusions?|references|acknowledg(e)?ments?|appendix)\b/i.test(
              text
            ) &&
              text.length <= 60));

        if (isAbstractStart) {
          shouldStartNew = true; nextType = 'abstract';
        } else if (isKeywordLine) {
          if (curParaType !== 'keywords') { shouldStartNew = true; nextType = 'keywords'; }
        } else if (isSignificanceHeading) {
          if (curParaType !== 'significance') { shouldStartNew = true; nextType = 'significance'; }
        } else if (isHeading) {
          shouldStartNew = true; nextType = 'heading';
        } else if (curParaType === 'abstract') {
          if (isKeywordLine || hasDropCap) {
            shouldStartNew = true;
            nextType = isKeywordLine ? 'keywords' : 'body';
          }
        } else if (curParaType === 'significance') {
          if (largeVGap && prevEnded) {
            shouldStartNew = true;
            nextType = 'body';
          }
        } else if (curParaType === 'keywords' && !isKeywordLine) {
          shouldStartNew = true; nextType = 'body';
        } else if (curParaType === 'body') {
          if (isSameColumn && prevEnded && (isIndented || (largeVGap && /^[A-Z“"'(]/.test(text)))) {
            shouldStartNew = true; nextType = 'body';
          } else if (!isSameColumn && prevEnded && isIndented && /^[A-Z“"'(]/.test(text)) {
            shouldStartNew = true; nextType = 'body';
          }
        }
      }

      if (shouldStartNew) {
        commitParagraph();
        curParaType = nextType;
      }

      curParaLines.push(line);
      prevLine = line;
    }
    commitParagraph();

    // 9.5 跨栏续接：双栏论文里一句话常被"栏底 / 栏顶"切断——
    // 左栏最后一段以半句结尾，右栏第一段以半句开头。
    // 不合并的话两半会各自送去翻译，产出让人读不懂的残句
    // （实测 STM 第 2 页右栏首段被译成「在测试时间的目标对象 [2,34,26,14,26,11,18]。」）。
    (function joinAcrossColumnBreak() {
      if (isSingleColumnPage || paras.length < 2) return;
      const endsSentence = t => /[.!?。！？]["'”’)\]]*\s*$/.test(t || '');
      // 续句特征：以小写字母、数字或左括号开头（新句子不会这样开头）
      const looksContinuation = t => /^[a-z0-9(“"'\[]/.test((t || '').trim());
      const colOf = p => ((p.minX + p.maxX) / 2 < gutterX ? 'col1' : 'col2');

      for (let i = 0; i < paras.length - 1; i++) {
        const a = paras[i];
        const b = paras[i + 1];
        if (a.type !== 'body' || b.type !== 'body') continue;
        if (colOf(a) !== 'col1' || colOf(b) !== 'col2') continue;
        if (endsSentence(a.cleanText) || !looksContinuation(b.cleanText)) continue;

        // 合并：左栏尾部 + 右栏开头的续句
        if (/-$/.test(a.cleanText)) {
          a.cleanText = a.cleanText.slice(0, -1) + b.cleanText;
          a.charMap.pop();
        } else {
          a.cleanText = `${a.cleanText} ${b.cleanText}`;
        }
        a.charMap = a.charMap.concat(b.charMap);
        b.rawSpans.forEach(span => {
          a.rawSpans.push(span);
          span.setAttribute('data-para-id', `${a.id}`);
        });
        a.maxX = Math.max(a.maxX, b.maxX);
        a.sentencesEn = splitEnglishSentencesSmart(a.cleanText);
        a.joinedAcrossColumn = true;
        paras.splice(i + 1, 1);
        i--; // 合并后同一位置可能还要继续吃下一段
      }
    })();

    let bodyCount = 0;
    paras.forEach(p => {
      if (p.type === 'body') {
        bodyCount++;
        p.bodyIndex = bodyCount;
      }
    });

    currentParagraphs = paras;
    // 本地原件留档：视觉手术每次都在它之上重放（幂等），所以同一份判断重放多少次结果都一样
    localParagraphsSnapshot = cloneParagraphs(paras);
    localParagraphsPage = pageNum;
    renderTranslationCards(pageNum, currentParagraphs);

    // 视觉分割：本地结果先显示，随后请视觉模型判断版面并校正（坐标不受影响）。
    // **默认每一页都问**（engine=vision）；auto 只在本地判据可疑时问；local 从不问。
    // 这里不再有任何"这一页被撤销过"的短路——撤销功能已移除，历史留下的 disabled 标记一律忽略。
    try {
      const engine = visionEngine;
      if (engine === 'vision' || (engine === 'auto' && looksLowConfidence(paras))) {
        // 用 setTimeout 让本页先画出来，避免请求把首屏拖慢
        setTimeout(() => {
          if (currentPage === pageNum) void requestVisionSegmentation(pageNum);
        }, 60);
      }
    } catch (e) {
      console.warn('[Viewer] 视觉分割调度失败:', e);
    }

    // 【顺序很重要】归档必须在 renderTranslationCards 之后：
    // 卡片渲染时才会把缓存里的译文回填到段落上，先归档就会存下一堆"没有译文"的快照
    // （导出 PDF 时表现为整篇都是"（本段尚未翻译）"）。
    archivePageParagraphs(pageNum, paras);

    // 把本页正文同步给扩展，供 AI 问答做全文检索（旧版问答只能看到一个段落）
    try {
      vscode.postMessage({
        type: 'syncPageText',
        page: pageNum,
        paragraphs: paras
          .filter(p => p.cleanText && p.cleanText.trim().length > 20)
          .map(p => ({ type: p.type, text: p.cleanText }))
      });
    } catch (e) {}
  }

  // 严密保护学术缩写的句子拆分器 (杜绝 et al., e.g., Fig. 1 碎片化错误)
  // startIdx / endIdx 与 cleanText 严格自洽：不再出现「文本已 trim 但下标没跟着挪」的错位。
  function splitEnglishSentencesSmart(text) {
    if (!text) return [];
    const out = [];
    const endRegex = /([.?!]["'”’)\]]?)(\s+|$)/g;
    // 注意：这里**故意不包含** "\b[A-Z]\.$"（单个大写字母 + 句号）。
    // 旧版把它当"作者姓名缩写"，但 ML/数学论文里 "the set S." / "denoted X." / "matrix W."
    // 极其常见，结果是整段被吞成一句、逐句对齐彻底失效。
    // 单字母缩写（J. Smith）在正文里远少于变量名后跟句号，两害相权取其轻。
    const ABBREV_RE = new RegExp(
      '(?:\\b(?:et\\s+al|e\\.g|i\\.e|cf|vs|etc|fig|figs|tab|eq|eqs|ref|refs|no|vol|pp|sec|secs|ch|chap|' +
        'dr|mr|mrs|ms|prof|approx|ca|min|max|avg|std|ed|eds|al|inc|ltd|univ|dept|resp|suppl)\\.)$',
      'i'
    );
    // 纯序号/列表标记："1." "2)" "(3)" "III." "a)" —— 它们不是句子，必须跟后面的文字在一起
    const LIST_MARKER_RE = /^(?:[(\[]?\s*(?:\d{1,2}|[IVXLC]{1,6}|[a-z])\s*[)\].:：]|(?:\d{1,2}|[IVXLC]{1,6})\.\d+[.)])$/;

    let searchFrom = 0;
    let match;
    while ((match = endRegex.exec(text)) !== null) {
      const endPos = match.index + match[1].length;
      const raw = text.slice(searchFrom, endPos);
      const body = raw.trim();

      if (!body) {
        searchFrom = match.index + match[0].length;
        continue;
      }

      // 命中常见学术缩写 → 这里不是句子边界，继续往后找
      if (ABBREV_RE.test(body)) continue;

      // 序号/列表标记（"1." "(2)" "III." "a)"）不能单独成句：
      // 否则会出现"序号"和"句子"被拆成两行、分别翻译的难看结果。
      if (LIST_MARKER_RE.test(body)) continue;

      const lead = raw.length - raw.trimStart().length;
      out.push({ text: body, startIdx: searchFrom + lead, endIdx: endPos });
      searchFrom = match.index + match[0].length;
    }

    const tailRaw = text.slice(searchFrom);
    const tail = tailRaw.trim();
    if (tail) {
      const lead = tailRaw.length - tailRaw.trimStart().length;
      out.push({
        text: tail,
        startIdx: searchFrom + lead,
        endIdx: searchFrom + lead + tail.length
      });
    }

    return out;
  }

  function splitChineseSentences(text) {
    if (!text) return [];
    const parts = text.match(/[^。！？；\n]+[。！？；\n]?/g);
    if (!parts) return [text];
    return parts.map(s => s.trim()).filter(Boolean);
  }

  // ====================== 核心：DOM Range 字符物理级精准高光引擎 ======================
  // 100% 贴合字符边缘，严格止于句号标点，绝不越界，绝不遮挡文字，按 span 隔离杜绝跨栏穿透
  function getSentenceHighlightRects(para, sentIdx, pageWrapper) {
    if (!para.sentencesEn || !para.sentencesEn[sentIdx] || !para.charMap || para.charMap.length === 0) return [];
    const sent = para.sentencesEn[sentIdx];

    const startIdx = Math.max(0, Math.min(sent.startIdx, para.charMap.length - 1));
    const endIdx = Math.max(0, Math.min(sent.endIdx - 1, para.charMap.length - 1));
    if (startIdx > endIdx) return [];

    // 按 span 分组提取每个 span 中该句子所占的真实字符切片
    const spanMap = new Map();
    for (let i = startIdx; i <= endIdx; i++) {
      const charInfo = para.charMap[i];
      if (!charInfo || !charInfo.span) continue;
      const { span, offset } = charInfo;
      if (!spanMap.has(span)) {
        spanMap.set(span, { minOffset: offset, maxOffset: offset });
      } else {
        const item = spanMap.get(span);
        if (offset < item.minOffset) item.minOffset = offset;
        if (offset > item.maxOffset) item.maxOffset = offset;
      }
    }

    const rects = [];
    const wrapperRect = pageWrapper.getBoundingClientRect();

    spanMap.forEach(({ minOffset, maxOffset }, span) => {
      const textNode = span.firstChild || span;
      const nodeLen = textNode.length !== undefined ? textNode.length : (textNode.textContent || '').length;
      if (nodeLen === 0) return;

      const safeStart = Math.min(Math.max(0, minOffset), nodeLen);
      const safeEnd = Math.min(Math.max(safeStart, maxOffset + 1), nodeLen);

      try {
        const range = document.createRange();
        range.setStart(textNode, safeStart);
        range.setEnd(textNode, safeEnd);

        const clientRects = Array.from(range.getClientRects());
        clientRects.forEach(r => {
          if (r.width > 1 && r.height > 1) {
            rects.push({
              left: Math.round(r.left - wrapperRect.left),
              top: Math.round(r.top - wrapperRect.top),
              width: Math.round(r.width),
              height: Math.round(r.height)
            });
          }
        });
      } catch (err) {
        console.warn('[Viewer] Span range rect error:', err);
      }
    });

    return mergeAdjacentLineRects(rects);
  }

  function getParagraphHighlightRects(para, pageWrapper) {
    if (!para.charMap || para.charMap.length === 0) return [];

    const spanMap = new Map();
    for (let i = 0; i < para.charMap.length; i++) {
      const charInfo = para.charMap[i];
      if (!charInfo || !charInfo.span) continue;
      const { span, offset } = charInfo;
      if (!spanMap.has(span)) {
        spanMap.set(span, { minOffset: offset, maxOffset: offset });
      } else {
        const item = spanMap.get(span);
        if (offset < item.minOffset) item.minOffset = offset;
        if (offset > item.maxOffset) item.maxOffset = offset;
      }
    }

    const rects = [];
    const wrapperRect = pageWrapper.getBoundingClientRect();

    spanMap.forEach(({ minOffset, maxOffset }, span) => {
      const textNode = span.firstChild || span;
      const nodeLen = textNode.length !== undefined ? textNode.length : (textNode.textContent || '').length;
      if (nodeLen === 0) return;

      const safeStart = Math.min(Math.max(0, minOffset), nodeLen);
      const safeEnd = Math.min(Math.max(safeStart, maxOffset + 1), nodeLen);

      try {
        const range = document.createRange();
        range.setStart(textNode, safeStart);
        range.setEnd(textNode, safeEnd);

        const clientRects = Array.from(range.getClientRects());
        clientRects.forEach(r => {
          if (r.width > 1 && r.height > 1) {
            rects.push({
              left: Math.round(r.left - wrapperRect.left),
              top: Math.round(r.top - wrapperRect.top),
              width: Math.round(r.width),
              height: Math.round(r.height)
            });
          }
        });
      } catch (err) {
        console.warn('[Viewer] Paragraph span range rect error:', err);
      }
    });

    return mergeAdjacentLineRects(rects);
  }

  // 智能合并同一视觉行内相邻或微重叠的字符碎片，形成连续优雅的荧光高光条
  function mergeAdjacentLineRects(rects) {
    if (rects.length <= 1) return rects;

    const sorted = [...rects].sort((a, b) => {
      if (Math.abs(a.top - b.top) > 4) return a.top - b.top;
      return a.left - b.left;
    });

    const merged = [];
    let cur = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      const sameLine = Math.abs(cur.top - next.top) <= 4 && Math.abs(cur.height - next.height) <= 6;
      const curRight = cur.left + cur.width;
      const horizontalOverlap = next.left <= curRight + 8;

      if (sameLine && horizontalOverlap) {
        const newLeft = Math.min(cur.left, next.left);
        const newRight = Math.max(curRight, next.left + next.width);
        const newTop = Math.min(cur.top, next.top);
        const newBottom = Math.max(cur.top + cur.height, next.top + next.height);

        cur = {
          left: newLeft,
          top: newTop,
          width: newRight - newLeft,
          height: newBottom - newTop
        };
      } else {
        merged.push(cur);
        cur = next;
      }
    }
    merged.push(cur);
    return merged;
  }

  function clearAllHighlights() {
    const overlay = document.getElementById(`focusHighlightLayer_${currentPage}`);
    if (overlay) overlay.innerHTML = '';
  }

  function focusParagraphOnPdf(para, targetSentenceIdx) {
    activeFocusPara = para;
    activeFocusSentIdx = targetSentenceIdx;

    clearAllHighlights();

    const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
    const overlay = document.getElementById(`focusHighlightLayer_${currentPage}`);
    if (!pageWrapper || !overlay) return;

    overlay.innerHTML = '';

    let sentenceRects = [];
    let paraRects = [];

    if (targetSentenceIdx !== undefined && para.sentencesEn && para.sentencesEn[targetSentenceIdx]) {
      // 1. 获取目标句子的精准字符物理视口矩形
      sentenceRects = getSentenceHighlightRects(para, targetSentenceIdx, pageWrapper);
      // 2. 同时获取整个段落的弱背景矩形作为上下文烘托
      paraRects = getParagraphHighlightRects(para, pageWrapper);

      // 绘制段落浅底色
      paraRects.forEach(rect => {
        const bg = document.createElement('div');
        bg.className = 'focus-highlight-rect para-backdrop';
        bg.style.left = `${rect.left}px`;
        bg.style.top = `${rect.top - 1}px`;
        bg.style.width = `${rect.width}px`;
        bg.style.height = `${rect.height + 2}px`;
        overlay.appendChild(bg);
      });

      // 绘制句子的金黄色荧光高亮笔触（100% 绝对物理贴合原文字符）
      sentenceRects.forEach(rect => {
        const mark = document.createElement('div');
        mark.className = 'focus-highlight-rect sentence-active';
        mark.style.left = `${rect.left}px`;
        mark.style.top = `${rect.top - 1}px`;
        mark.style.width = `${rect.width}px`;
        mark.style.height = `${rect.height + 2}px`;
        overlay.appendChild(mark);
      });
    } else {
      // 聚焦整段
      paraRects = getParagraphHighlightRects(para, pageWrapper);
      paraRects.forEach(rect => {
        const mark = document.createElement('div');
        mark.className = 'focus-highlight-rect para-active';
        mark.style.left = `${rect.left}px`;
        mark.style.top = `${rect.top - 1}px`;
        mark.style.width = `${rect.width}px`;
        mark.style.height = `${rect.height + 2}px`;
        overlay.appendChild(mark);
      });
    }

    // 绘制段落左侧指示色带
    if (paraRects.length > 0) {
      let minTop = Infinity;
      let maxBottom = -Infinity;
      let minLeft = Infinity;
      paraRects.forEach(r => {
        if (r.top < minTop) minTop = r.top;
        if (r.top + r.height > maxBottom) maxBottom = r.top + r.height;
        if (r.left < minLeft) minLeft = r.left;
      });

      if (minTop !== Infinity && maxBottom !== -Infinity) {
        const ribbon = document.createElement('div');
        ribbon.className = 'para-bracket-ribbon';
        ribbon.style.left = `${Math.max(4, minLeft - 10)}px`;
        ribbon.style.top = `${minTop - 2}px`;
        ribbon.style.height = `${maxBottom - minTop + 4}px`;
        overlay.appendChild(ribbon);
      }
    }

    // 平滑滚动居中聚焦视野
    const anchorRect = sentenceRects.length > 0 ? sentenceRects[0] : (paraRects.length > 0 ? paraRects[0] : null);
    if (anchorRect && dom.pdfViewerContainer) {
      const container = dom.pdfViewerContainer;
      const targetY = pageWrapper.offsetTop + anchorRect.top - 100;
      container.scrollTo({
        top: Math.max(0, targetY),
        behavior: 'smooth'
      });
    }

    // 唤醒段落聚焦灵动快捷条 (让用户点击段落后随时可用工具栏)
    showParaFocusBar(para, targetSentenceIdx, anchorRect, pageWrapper);
  }

  /**
   * 重新计算聚焦条位置——它必须**跟着高亮的那句话走**。
   *
   * 旧实现只在弹出时算一次坐标（position: fixed），滚动后卡片就定在原地，
   * 而原 PDF 里的高亮笔触是画在页面坐标系里的、会跟着滚——两者当场脱节。
   * 现在滚动/缩放时都按同一套公式重算；锚点完全移出可视区则隐藏，滚回来自动恢复。
   */
  function positionParaFocusBar() {
    const a = activeFocusAnchor;
    const bar = dom.paraFocusBar;
    if (!a || !bar) return;
    const { para, targetSentenceIdx, pageWrapper } = a;
    if (!pageWrapper || !pageWrapper.isConnected) {
      hideParaFocusBar();
      return;
    }

    const rects =
      targetSentenceIdx !== undefined
        ? getSentenceHighlightRects(para, targetSentenceIdx, pageWrapper)
        : getParagraphHighlightRects(para, pageWrapper);
    const anchorRect = rects.length > 0 ? rects[0] : null;
    if (!anchorRect) {
      hideParaFocusBar();
      return;
    }

    const pageRect = pageWrapper.getBoundingClientRect();
    const viewTop = pageRect.top + anchorRect.top;
    const viewBottom = viewTop + anchorRect.height;

    // 可视区：优先用 PDF 滚动容器，拿不到就退回窗口
    const cRect = dom.pdfViewerContainer
      ? dom.pdfViewerContainer.getBoundingClientRect()
      : { top: 46, bottom: window.innerHeight };

    if (viewBottom < cRect.top + 4 || viewTop > cRect.bottom - 4) {
      // 高亮句已滚出可视区 → 收起卡片
      bar.style.display = 'none';
      bar.dataset.hiddenByScroll = '1';
      return;
    }

    const barW = bar.offsetWidth || 280;
    const barH = bar.offsetHeight || 34;

    let left = pageRect.left + anchorRect.left + anchorRect.width / 2 - barW / 2;
    let top = viewTop - barH - 10;
    if (top < 58) top = viewBottom + 10;

    left = Math.max(12, Math.min(window.innerWidth - barW - 20, left));
    top = Math.max(50, Math.min(window.innerHeight - barH - 12, top));

    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
    bar.style.display = 'flex';
    bar.style.visibility = 'visible';
    bar.style.opacity = '1';
    bar.dataset.hiddenByScroll = '';
  }

  function requestFocusBarReposition() {
    if (!activeFocusAnchor || focusBarRaf) return;
    focusBarRaf = requestAnimationFrame(() => {
      focusBarRaf = 0;
      positionParaFocusBar();
    });
  }

  function bindFocusBarFollow() {
    if (focusFollowBound) return;
    focusFollowBound = true;
    const target = dom.pdfViewerContainer || window;
    target.addEventListener('scroll', requestFocusBarReposition, { passive: true });
    window.addEventListener('resize', requestFocusBarReposition);
    // 左右两侧的译文栏各自滚动时，PDF 区可能不动，但卡片仍需保持在原位
    document.querySelectorAll('.column-content, .translation-column, .pdf-pane').forEach(col => {
      col.addEventListener('scroll', requestFocusBarReposition, { passive: true });
    });
  }

  function showParaFocusBar(para, targetSentenceIdx, anchorRect, pageWrapper) {
    if (!dom.paraFocusBar || !anchorRect || !pageWrapper) return;
    activeFocusPara = para;
    activeFocusSentIdx = targetSentenceIdx;
    activeFocusAnchor = { para, targetSentenceIdx, pageWrapper };
    bindFocusBarFollow();

    let label = '当前段落';
    if (para.type === 'title') label = '论文标题';
    else if (para.type === 'abstract') label = '摘要';
    else if (para.type === 'keywords') label = '关键词';
    else if (targetSentenceIdx !== undefined) label = `句子 #${targetSentenceIdx + 1}`;

    if (dom.focusBarLabel) dom.focusBarLabel.textContent = label;

    dom.paraFocusBar.style.display = 'flex';
    dom.paraFocusBar.style.visibility = 'visible';
    dom.paraFocusBar.style.opacity = '1';

    // 统一走同一套定位逻辑（页面相对坐标 + 可视区判断）
    positionParaFocusBar();
  }

  function hideParaFocusBar() {
    if (dom.paraFocusBar) {
      dom.paraFocusBar.style.display = 'none';
    }
  }

  // 底部速照栏已按用户需求禁用
  function updateDockedInspector(para, targetSentenceIdx) {
    if (dom.dockedInspector) {
      dom.dockedInspector.style.display = 'none';
    }
  }

  // ====================== 核心：PDF 原件单击直接对齐右侧卡片与高亮 ======================
  function bindPdfClickAlignment(textLayerDiv) {
    textLayerDiv.addEventListener('click', (e) => {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) return;

      let node = e.target;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      let paraSpan = node.closest('[data-para-id]');

      if (!paraSpan) {
        const x = e.clientX;
        const y = e.clientY;
        const probes = [-4, 4, -8, 8, -12, 12, -18, 18, -25, 25];
        for (const dy of probes) {
          const el = document.elementFromPoint(x, y + dy);
          if (el && textLayerDiv.contains(el)) {
            const candidate = el.closest('[data-para-id]');
            if (candidate) {
              paraSpan = candidate;
              break;
            }
          }
        }
      }

      if (!paraSpan) return;

      const pId = parseInt(paraSpan.getAttribute('data-para-id'), 10);
      const para = currentParagraphs.find(p => p.id === pId);
      if (!para) return;

      // 找到点击的具体字符或句子
      let clickedSentIdx = undefined;
      if (para.sentencesEn && para.sentencesEn.length > 0 && para.charMap) {
        let offset = 0;
        if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(e.clientX, e.clientY);
          if (range && (range.startContainer === paraSpan || range.startContainer.parentElement === paraSpan)) {
            offset = range.startOffset;
          }
        }

        const charIdx = para.charMap.findIndex(c => c.span === paraSpan && c.offset >= offset);
        const targetIdx = charIdx !== -1 ? charIdx : para.charMap.findIndex(c => c.span === paraSpan);

        if (targetIdx !== -1) {
          const found = para.sentencesEn.findIndex(s => targetIdx >= s.startIdx && targetIdx <= s.endIdx);
          if (found !== -1) clickedSentIdx = found;
        }
      }

      // 1. PDF 原件物理高亮该句/段
      focusParagraphOnPdf(para, clickedSentIdx);

      // 2. 更新当前选区元数据，使得快捷键与弹窗能够获取精准的句子文本与物理矩形
      const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
      const rawRects = (clickedSentIdx !== undefined)
        ? (pageWrapper ? getSentenceHighlightRects(para, clickedSentIdx, pageWrapper) : [])
        : (pageWrapper ? getParagraphHighlightRects(para, pageWrapper) : []);
      const targetText = (clickedSentIdx !== undefined && para.sentencesEn && para.sentencesEn[clickedSentIdx])
        ? para.sentencesEn[clickedSentIdx].text
        : para.cleanText;

      currentSelectionInfo = {
        text: targetText,
        page: currentPage,
        range: null,
        rawRects: rawRects,
        paraIndex: para.id
      };

      // 3. 右侧卡片联动聚焦并平滑滚动到视野
      const card = document.getElementById(`transCard_${currentPage}_${para.id}`);
      if (card) {
        highlightCard(card);
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        card.querySelectorAll('.sentence-pair-row').forEach(r => r.classList.remove('active-sentence-row'));
        if (clickedSentIdx !== undefined) {
          const targetRow = card.querySelector(`.sentence-pair-row[data-sent-idx="${clickedSentIdx}"]`);
          if (targetRow) {
            targetRow.classList.add('active-sentence-row');
            targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      }
    });
  }

  // ====================== 渲染右侧对照翻译卡片 ======================
  /**
   * 段落内容指纹：FNV-1a 32 位 + 字符数。
   * 旧实现取「正文前 28 个字母数字」，同页里两段开头同为 "In this paper, we propose…"
   * 就会拿到同一个键，于是段落之间互相串译文——这是"翻译对不上"的一大元凶。
   */
  function getParaSig(text) {
    const s = (text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${h.toString(16)}-${s.length}`;
  }

  function getParaCacheKey(pageNum, para) {
    const sig = getParaSig(para.cleanText || para.text || '');
    // 缓存键里带上引擎标识：换引擎（Gemini ↔ DeepSeek）后旧译文自动失效，
    // 否则会继续复用上一个引擎翻出来的结果，让人以为"换了引擎没用"。
    const tag = currentEngineTag ? `${currentEngineTag}_` : '';
    return sig ? `${pageNum}_${tag}${sig}` : `${pageNum}_${para.id}`;
  }

  function findCachedTranslation(pageNum, para) {
    if (!para) return '';
    if (para.translation) return para.translation;

    const sig = getParaSig(para.cleanText || para.text || '');
    if (!sig) return '';
    // 只按内容指纹精确命中（不再做前缀模糊匹配——那会把别段的译文贴过来）
    //
    // 【必须查带引擎标识的键】缓存**写入**用的是 getParaCacheKey()（`${page}_${引擎标识}_${指纹}`），
    // 这里以前只查 `${page}_${指纹}`，于是重开插件后一律查不到——
    // 表现是每段都要再向宿主问一遍（宿主命中缓存才把译文送回来），
    // 而且导出用的段落快照在那之前生成，就全是"未翻译"（用户反馈的"译文没同步"）。
    // 无标识键保留做兜底：0.5.1 之前存下的缓存没有标识。
    const tagged = `${pageNum}_${currentEngineTag ? `${currentEngineTag}_` : ''}${sig}`;
    if (paperData.translations[tagged]) return paperData.translations[tagged];
    const legacyKey = `${pageNum}_${sig}`;
    if (paperData.translations[legacyKey]) return paperData.translations[legacyKey];
    return '';
  }

  function findCachedSentences(pageNum, para) {
    if (!para) return null;
    let list = null;
    if (para.sentenceTranslations && Array.isArray(para.sentenceTranslations) && para.sentenceTranslations.length > 0) {
      list = para.sentenceTranslations;
    } else if (paperData.sentenceTranslations) {
      const sig = getParaSig(para.cleanText || para.text || '');
      if (sig) {
        // 与 findCachedTranslation 同理：先查带引擎标识的键，再兜底无标识键
        const tagged = `${pageNum}_${currentEngineTag ? `${currentEngineTag}_` : ''}${sig}`;
        const legacyKey = `${pageNum}_${sig}`;
        list = paperData.sentenceTranslations[tagged] || paperData.sentenceTranslations[legacyKey] || null;
      }
    }

    if (!list || !Array.isArray(list) || list.length === 0) return null;

    // 只有与英文句数严格相等、且没有空项时才算"真的对齐了"
    const sentences = para.sentencesEn || [];
    if (list.length !== sentences.length) return null;
    if (list.some(s => !s || !s.trim())) return null;

    return list;
  }

  /** 图表标签 / 页眉页脚页码（视觉判为 noise 的）：连卡片都不生成 */
  function isFigureLabelPara(para) {
    return !!para && (para.type === 'figure-label' || para.type === 'noise');
  }

  /**
   * 不需要翻译的段落：图表标签、页眉页脚页码，以及**独立公式块**。
   *
   * 公式块没有散文可翻：送过去只会拿回原文残渣（"L cycle,t = L (Y ̂ t, Y t) …"），
   * 然后卡片里显示成一坨英文——这正是用户看到的"完全不行"。
   * 视觉模型给了 latex 的，卡片会把公式渲染出来（见 renderCardFormulaHtml）。
   */
  function isUntranslatablePara(para) {
    return isFigureLabelPara(para) || (!!para && para.type === 'formula');
  }

  /**
   * 纯公式/符号段落（集合记号、损失函数定义这类）：**不送翻译**。
   *
   * 它们是"公式行"而不是散文，本来就没有可翻译的文字；送过去只会拿到原样返回，
   * 然后被译文质量校验判成"疑似未翻译"而弹红框（用户真实反馈："公式它就识别为未翻译"）。
   *
   * 判据：符号/数字占主导，且拉丁字母很少、几乎没有成词内容。
   * 注意别把"散文里带公式"的段落误伤进来（例如 `mask. Hence, we have … ⊂ {…}`，
   * 它有 20+ 个字母、是完整句子）—— 所以同时要求字母数很少、成词数很少。
   */
  function isFormulaLikePara(para) {
    const text = (para && para.cleanText) || '';
    if (!text.trim()) return false;
    if (/[\u4e00-\u9fff]/.test(text)) return false; // 已经是中文，没什么可判的
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const symbols = (text.match(/[=+\-*/^_{}[\]()<>≤≥≈≠∈∑∫∂∇×·|\\]/g) || []).length;
    const digits = (text.match(/\d/g) || []).length;
    const denom = letters + symbols + digits;
    if (denom === 0) return false;
    const density = (symbols + digits) / denom;
    const words = (text.match(/[A-Za-z]{2,}/g) || []).length;
    return density >= 0.35 && letters <= 20 && words <= 6;
  }

  // ====================== 导出「全文双语精读稿」的数据准备 ======================
  /**
   * 归档一页的段落（renderPage 解析完就调用一次）。
   * 只留轻量字段，rawSpans/charMap 是 DOM 元素，绝不能留。
   */
  function archivePageParagraphs(pageNum, paras) {
    try {
      const snapshot = (paras || [])
        .filter(p => p && typeof p.cleanText === 'string' && p.cleanText.trim())
        .map(p => ({
          id: p.id,
          // 纯公式/符号段在快照里标成 formula：导出时据此写"（公式/符号段落，无需翻译）"，
          // 而不是含混的"（本段尚未翻译）"——后者会让人以为翻译失败了。
          type: isFormulaLikePara(p) ? 'formula' : p.type || 'body',
          cleanText: p.cleanText,
          sentencesEn: (p.sentencesEn || []).map(s => ({ text: s.text })),
          // 【必须在这里解析】段落对象上的 translation 只有在"本次会话刚翻好"时才有值；
          // 命中缓存（重开插件再导出）时它是空的，译文其实躺在 paperData.translations 里。
          // 只存 p.translation 就会出现"译文没同步到导出"——0.5.13 就是这样漏的。
          translation: findCachedTranslation(pageNum, p) || p.translation || '',
          sentenceTranslations: findCachedSentences(pageNum, p) || (Array.isArray(p.sentenceTranslations) ? p.sentenceTranslations.slice() : []),
          // 记下缓存键，宿主可以据此**精确**回查（不必重算指纹、猜引擎标识）
          cacheKey: getParaCacheKey(pageNum, p)
        }));
      if (snapshot.length === 0) return;
      pageParaArchive.set(pageNum, snapshot);
      syncPageArchive(pageNum, snapshot);
    } catch (e) {
      console.warn('[Viewer] 归档本页段落失败（只影响导出）:', e);
    }
  }

  /**
   * 把一页的段落快照交给宿主持久化。
   *
   * 合并节流：译文是一条条回来的，每来一条都整页同步会写很多次盘；
   * 但也不能不发——否则重开插件再导出时，宿主的快照里没有译文。
   */
  /** 立刻把待同步的段落快照发给宿主（节流到期或需要确定性时调用） */
  function flushPendingArchiveSync() {
    if (archiveSyncTimer) {
      clearTimeout(archiveSyncTimer);
      archiveSyncTimer = null;
    }
    if (pendingArchiveSync.size === 0) return;
    const batch = [...pendingArchiveSync.entries()];
    pendingArchiveSync.clear();
    batch.forEach(([page, paragraphs]) => {
      try {
        vscode.postMessage({ type: 'syncPageArchive', page, paragraphs });
      } catch (e) {
        /* 同步失败不影响本次会话内导出 */
      }
    });
  }

  function syncPageArchive(pageNum, snapshot) {
    pendingArchiveSync.set(pageNum, snapshot);
    if (archiveSyncTimer) return;
    archiveSyncTimer = setTimeout(flushPendingArchiveSync, 700);
  }

  /**
   * 译文到达后回填归档，否则导出时只会看到"未翻译"。
   *
   * @param {string} [expectCacheKey] 回包自带的内容指纹键。视觉手术会**重新编号**段落，
   *   在途回包可能落到"编号相同、其实是另一段"的归档项上——实测症状：某公式段拿到了
   *   隔壁小节标题的译文（"3.3 Gradient correction" → "3.3 梯度校正"）。给了这个键就核对
   *   归档项自己的指纹，核对不上**一个字都不写**。
   */
  function updateArchivedParagraph(pageNum, paraId, patch, expectCacheKey) {
    const list = pageParaArchive.get(pageNum);
    if (!list) return;
    const hit = list.find(p => p.id === paraId);
    if (!hit) return;
    if (expectCacheKey && hit.cacheKey && hit.cacheKey !== expectCacheKey) return;
    let changed = false;
    if (patch.translation && !hit.translation) {
      hit.translation = patch.translation;
      changed = true;
    }
    if (patch.sentenceTranslations && patch.sentenceTranslations.length > 0 && (!hit.sentenceTranslations || hit.sentenceTranslations.length === 0)) {
      hit.sentenceTranslations = patch.sentenceTranslations.slice();
      changed = true;
    }
    // 同步回宿主：不然宿主快照里这一页还是"没有译文"，导出 PDF 就缺中文
    if (changed) syncPageArchive(pageNum, list);
  }

  /**
   * 导出一段段落译文：依次尝试内存里的值 → 带引擎标识的缓存键 → 旧的无标识键。
   * 三种都试是有原因的：缓存写入用的是 getParaCacheKey()（含引擎标识），
   * 而 findCachedTranslation() 只查无标识键——只查一种就会漏掉刚翻好的段落。
   */
  function resolveArchivedTranslation(pageNum, para) {
    if (para.translation) return para.translation;
    const sig = getParaSig(para.cleanText || '');
    if (!sig) return '';
    const tagged = getParaCacheKey(pageNum, para);
    const untagged = `${pageNum}_${sig}`;
    return paperData.translations[tagged] || paperData.translations[untagged] || '';
  }

  /** 句级对齐译文（只有句数严格相等且无空项才算数，与界面上的判据一致） */
  function resolveArchivedSentences(pageNum, para) {
    const en = para.sentencesEn || [];
    if (en.length === 0) return null;
    let list = para.sentenceTranslations && para.sentenceTranslations.length ? para.sentenceTranslations : null;
    if (!list) {
      const sig = getParaSig(para.cleanText || '');
      if (sig) {
        const tagged = getParaCacheKey(pageNum, para);
        const untagged = `${pageNum}_${sig}`;
        list =
          (paperData.sentenceTranslations && paperData.sentenceTranslations[tagged]) ||
          (paperData.sentenceTranslations && paperData.sentenceTranslations[untagged]) ||
          null;
      }
    }
    if (!Array.isArray(list) || list.length !== en.length) return null;
    if (list.some(s => !s || !String(s).trim())) return null;
    return list;
  }

  /**
   * 记录一条 AI 答疑。
   *
   * 由 handleAiQuestionDone() 统一调用——弹窗与批注气泡两条入口都经过它，
   * 所以不会漏记。落进 paperData.aiQa 后同步给宿主持久化（关窗不再丢）。
   */
  function recordAiQa(entry) {
    const answer = (entry && entry.answer) || '';
    if (!answer.trim()) return;
    paperData.aiQa = Array.isArray(paperData.aiQa) ? paperData.aiQa : [];
    const record = {
      id: `qa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      page: entry.page || currentPage,
      selectedText: entry.selectedText || '',
      question: entry.question || '',
      answer,
      style: entry.style || aiStyle || '',
      model: entry.model || '',
      at: Date.now()
    };
    paperData.aiQa.push(record);
    // 只留最近 200 条，避免论文 JSON 无限膨胀
    if (paperData.aiQa.length > 200) paperData.aiQa = paperData.aiQa.slice(-200);
    try {
      vscode.postMessage({ type: 'recordAiQa', item: record });
    } catch (e) {
      console.warn('[Viewer] 同步 AI 答疑失败（本次仍能导出）:', e);
    }
  }

  // ====================== 导出「全文双语精读稿」 ======================
  /** Markdown 引用块：逐行加 `> `，保留原文里的换行 */
  function mdQuote(text) {
    return String(text || '')
      .split('\n')
      .map(l => `> ${l}`.trimEnd())
      .join('\n');
  }

  /**
   * 多行引用：多句时用 `> - ` 列表项。
   *
   * 为什么不用 `> 句一\n> 句二`：Markdown 会把相邻的引用行当成**同一段**，
   * 渲染出来两个英文句子被粘成一行，逐句对照就废了。
   * 列表项天然各自成行，也可以和中文侧一一对上。
   */
  function mdQuoteLines(lines) {
    const arr = (lines || []).map(l => String(l || '').trim()).filter(Boolean);
    if (arr.length === 0) return '';
    if (arr.length === 1) return `> ${arr[0]}`;
    return arr.map(l => `> - ${l}`).join('\n');
  }

  /** 批次：把页码数组压成 "1–3, 7" 这种可读区间 */
  function formatPageRanges(pages) {
    const sorted = [...new Set(pages)].filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    if (sorted.length === 0) return '（无）';
    const parts = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const cur = sorted[i];
      if (cur === prev + 1) {
        prev = cur;
        continue;
      }
      parts.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = cur;
      prev = cur;
    }
    return parts.join(', ');
  }

  const ANNOT_COLOR_LABEL = {
    yellow: '🟨 核心要点',
    green: '🟩 论据/数据',
    blue: '🟦 方法/公式',
    pink: '🟥 疑难/待查'
  };
  const PARA_TYPE_LABEL = {
    title: '文献标题',
    metadata: '作者信息',
    abstract: '摘要',
    keywords: '关键词',
    heading: '章节标题',
    caption: '图表题注',
    footnote: '脚注',
    significance: '意义声明',
    formula: '公式/符号'
  };

  /**
   * 把"预设分析问题"做成快捷提问芯片（和「核心动机 / 与前人区别」同一排）。
   *
   * 为什么不再做成第二个按钮：预设问题是**预填进输入框**的，所以旁边的「发送」
   * 发出去的就是它——两个按钮做同一件事，用户只会困惑（真实反馈："为啥会有两个按钮"）。
   * 而且旧按钮发送的是 `aiPresetQuestion` 原文，**无视用户在输入框里的修改**，是个坑。
   * 现在：主按钮只有「发送」；想一键发起预设分析，点这颗芯片。
   */
  function renderPresetChip(modal, presetQuestion) {
    if (!modal) return;
    const row = modal.querySelector('.ai-prompt-chips');
    if (!row) return;
    let chip = row.querySelector('.ai-chip-preset');
    const question = (presetQuestion || '').trim();
    if (!question) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ai-chip ai-chip-preset';
      row.insertBefore(chip, row.firstChild);
    }
    chip.textContent = '深度剖析此句';
    chip.title = `使用预设分析问题：${question.slice(0, 60)}…`;
    // 动态插入的芯片不在 bindAiAssistantModalEvents 的批量绑定里，这里自己绑
    chip.onclick = e => {
      e.stopPropagation();
      const input = dom.aiModalQuestionInput || document.getElementById('aiModalQuestionInput');
      if (input) input.value = question;
      sendAiModalQuestion(question);
    };
  }

  /** 导出文件名：<论文名>-双语精读稿.md（宿主只用它当默认名，用户可在另存为对话框里改） */
  function suggestedReadingDocName() {
    const t = (((dom.paperTitle && dom.paperTitle.textContent) || '论文').trim() || '论文').replace(/\.pdf$/i, '');
    return `${t.replace(/[\\/:*?"<>|]/g, '_')}-双语精读稿.md`;
  }

  // ====================== 视觉版面判断（视觉分割） ======================
  /**
   * 视觉分割：把当前页**图像** + 本地分段编号交给支持图片的模型，
   * 由它判断"每段是什么类型、阅读顺序、该合该拆"。
   *
   * 【铁律】坐标不经过视觉模型。划线高亮、"点中文跳英文"、导出 PDF 里把高亮画回原位，
   * 全都用本地文本层的 charMap/spans；视觉只负责"怎么切、切出来是什么"。
   * 这正是上一轮把视觉路线停用的原因（让模型给坐标不可靠），也是现在这条路能成立的前提。
   */

  /** 把某一页渲成 JPEG dataURL（优先用屏幕上已渲染好的 canvas，分辨率不够时离屏重渲） */
  async function capturePageImage(pageNum) {
    const onScreen = (() => {
      const wrap = document.getElementById(`pageWrapper_${pageNum}`);
      const cv = wrap ? wrap.querySelector('canvas.pdf-canvas') || wrap.querySelector('canvas') : null;
      return cv && cv.width > 0 ? cv : null;
    })();
    const longEdge = cv => Math.max(cv.width, cv.height);

    // 屏幕上这页已渲染且够清晰：直接用（零成本、所见即所得）
    if (onScreen && longEdge(onScreen) >= 1200) {
      return { dataUrl: onScreen.toDataURL('image/jpeg', 0.82), source: 'on-screen' };
    }
    // 否则离屏按目标分辨率重渲一版（缩放太小的时候，模型看不清小字）
    if (!pdfDoc) {
      return onScreen ? { dataUrl: onScreen.toDataURL('image/jpeg', 0.82), source: 'on-screen-low' } : null;
    }
    try {
      const page = await pdfDoc.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });
      const target = 1600;
      const scale = Math.min(3.5, Math.max(1, target / Math.max(base.width, base.height)));
      const viewport = page.getViewport({ scale });
      const cv = document.createElement('canvas');
      cv.width = Math.floor(viewport.width);
      cv.height = Math.floor(viewport.height);
      const ctx = cv.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      return { dataUrl: cv.toDataURL('image/jpeg', 0.82), source: 'offscreen' };
    } catch (e) {
      console.warn('[Viewer] 生成页面图像失败:', e);
      return onScreen ? { dataUrl: onScreen.toDataURL('image/jpeg', 0.82), source: 'on-screen-low' } : null;
    }
  }

  /** auto 模式：这一页看起来"本地可能切错了"吗 */
  function looksLowConfidence(paragraphs) {
    const list = paragraphs || [];
    if (list.length === 0) return false;
    const body = list.filter(p => p.type === 'body');
    const captions = list.filter(p => p.type === 'caption');
    const figureLabels = list.filter(p => p.type === 'figure-label');
    if (figureLabels.length / list.length > 0.45) return true; // 多半把图内文字当成了正文
    if (captions.length >= 3 && body.length <= 2) return true; // 图注被切得很碎
    if (body.length > 40) return true; // 行被切成了大量碎片
    return false;
  }

  /**
   * 请求视觉判断（每一页渲染时默认调用一次，没有手动入口）。
   * @param {number} pageNum
   */
  async function requestVisionSegmentation(pageNum) {
    if (visionPending.has(pageNum)) return;
    // 【必须发"本地未手术的分段"】否则第二次判断看到的是上一次手术后的结果，
    // 编号与内容都对不上，合并/拆分会被重复叠加（旧版只改类型所以看不出来）。
    const paragraphs =
      localParagraphsPage === pageNum && localParagraphsSnapshot ? localParagraphsSnapshot : currentParagraphs || [];
    if (paragraphs.length === 0) return;

    const cached = paperData.visionStructure && paperData.visionStructure[String(pageNum)];
    if (isUsableVisionCache(cached)) {
      const applied = visionSurgeryAllowed ? applyVisionStructure(pageNum, cached) : applyVisionSegments(pageNum, cached);
      showVisionBadge(
        `已用缓存的视觉结果校正本页（${cached.model || '视觉模型'}）：${applied.summary || `校正 ${applied.changed} 处`}`
      );
      setTimeout(() => showVisionBadge(''), 6000);
      return;
    }

    const shot = await capturePageImage(pageNum);
    if (!shot) return;
    const base64 = String(shot.dataUrl).split(',')[1] || '';
    if (!base64) return;

    visionPending.add(pageNum);
    showVisionBadge('正在请视觉模型判断版面…（坐标仍来自文本层）');
    try {
      vscode.postMessage({
        type: 'requestVisionSegmentation',
        page: pageNum,
        imageBase64: base64,
        mimeType: 'image/jpeg',
        segments: paragraphs.map(p => ({
          id: p.id,
          type: p.type || 'body',
          text: (p.cleanText || '').slice(0, 1500)
        }))
      });
    } catch (e) {
      visionPending.delete(pageNum);
      showVisionBadge('视觉请求发送失败', 'error');
      vscode.postMessage({ type: 'showInfo', message: `视觉请求发送失败：${(e && e.message) || e}` });
    }
  }

  /**
   * 卡片区顶部的小状态条（视觉进度/结果提示）。
   *
   * 【为什么没有「撤销」按钮了】视觉重排是**默认每一页都做**的分段依据，撤销属于多余的岔路：
   * 留着它反而带来一个隐蔽的坏行为——撤销会往缓存里写 `disabled`，那页从此不再自动重排。
   * 现在一律默认套用视觉结果；不想要就整体关掉 `academicReader.visionSurgery`。
   *
   * @param {string} text 传空串即移除
   * @param {string} [level] 'error' 时标红
   */
  function showVisionBadge(text, level) {
    let el = document.getElementById('visionStatusBadge');
    if (!text) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'visionStatusBadge';
      el.className = 'vision-status-badge';
      const host = dom.transListContainer || document.getElementById('transListContainer');
      if (host && host.parentNode) host.parentNode.insertBefore(el, host);
      else document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle('vision-status-error', level === 'error');
  }

  // ============ 视觉手术：真的按模型的判断合并 / 拆分 / 改类型（坐标仍来自文本层） ============
  /**
   * 把视觉模型的类型收敛到阅读器自己的类型词汇。
   *
   * 【为什么必须收敛】旧版把模型给的 type 原样写进段落，而"不翻译"的判据只认
   * figure-label / noise —— 于是模型判成 figure / table 的**图内文字**照旧进了翻译队列，
   * "图内文字不翻译"这条其实从未真正生效（模型越准，这个漏洞越显眼）。
   */
  function normalizeVisionType(t) {
    const s = String(t == null ? '' : t).trim().toLowerCase();
    if (!s) return '';
    if (s === 'figure' || s === 'table' || s === 'figure-label' || s === 'table-label') return 'figure-label';
    if (s === 'figure_caption' || s === 'table_caption' || s === 'caption') return 'caption';
    if (s === 'header' || s === 'footer' || s === 'page_number' || s === 'noise') return 'noise';
    if (s === 'equation') return 'formula';
    const known = [
      'title',
      'abstract',
      'keywords',
      'significance',
      'heading',
      'footnote',
      'metadata',
      'body',
      'reference',
      'formula',
      'formula_inline'
    ];
    return known.indexOf(s) >= 0 ? s : '';
  }

  /** 归一化匹配时的等价字符表（排版上"看着一样、码位不同"的那些） */
  const VISION_CHAR_EQUIV = {
    '\u2212': '-',
    '\u2013': '-',
    '\u2014': '-',
    '\u2010': '-',
    '\u2011': '-',
    '\u2012': '-',
    '\u2018': "'",
    '\u2019': "'",
    '\u2032': "'",
    '\u201c': '"',
    '\u201d': '"',
    '\u00d7': '*',
    '\u00b7': '*',
    '\u22c5': '*',
    '\u2219': '*'
  };

  /**
   * 归一化：去掉所有空白、拆掉重音与组合符（NFD 去 combining marks：
   * 模型写的 "Ŷ" 与文本层抽出的 "Y" + U+0302 都会变成 "Y"）、统一等价字符、转小写。
   * 同时返回**下标映射表**（归一化后第 i 个字符在原文里的下标），定位结果据此换算回原文。
   */
  function normalizeForMatch(s) {
    const src = String(s == null ? '' : s);
    const norm = [];
    const map = [];
    for (let i = 0; i < src.length; ) {
      const cp = src.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const at = i;
      i += ch.length;
      if (/\s/.test(ch)) continue;
      const eq = VISION_CHAR_EQUIV[ch];
      const base = (eq !== undefined ? eq : ch).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      for (const c of base) {
        norm.push(c);
        map.push(at);
      }
    }
    return { norm: norm.join(''), map };
  }

  /** 二元组 Dice 相似度（对"模型把残渣顺手写对"这类差异很宽容） */
  function bigramDice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bag = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const g = a.slice(i, i + 2);
      bag.set(g, (bag.get(g) || 0) + 1);
    }
    let hit = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const g = b.slice(i, i + 2);
      const c = bag.get(g) || 0;
      if (c > 0) {
        hit++;
        bag.set(g, c - 1);
      }
    }
    return (2 * hit) / (a.length - 1 + b.length - 1);
  }

  /**
   * 在 cleanText 里定位视觉模型给的"片段开头文字"。
   *
   * 为什么不能只用 indexOf：模型是**看图**写的，常把残渣顺手写对——
   * 文本层是 "Y ̂ t = S θ (X t )"（带组合抑扬符），模型可能写 "Ŷt = Sθ(Xt)"；
   * 空白、上下标、连字符、全角字符也常有出入。所以三级降级：
   *   ① 原样 indexOf；② 归一化后 indexOf（带下标映射）；③ 滑窗 + 二元组 Dice ≥ 0.72。
   * 都失败返回 -1 —— 调用方**跳过这一处手术**，绝不猜一个位置去切。
   */
  function locateAnchorIndex(text, anchor, from) {
    const t = String(text == null ? '' : text);
    const a = String(anchor == null ? '' : anchor).trim();
    const start = Math.max(0, Number(from) || 0);
    if (!t || !a || start >= t.length) return -1;

    const exact = t.indexOf(a, start);
    if (exact >= 0) return exact;

    const nt = normalizeForMatch(t);
    const na = normalizeForMatch(a);
    if (na.norm.length < 2) return -1;

    let nFrom = nt.map.length;
    for (let i = 0; i < nt.map.length; i++) {
      if (nt.map[i] >= start) {
        nFrom = i;
        break;
      }
    }
    const at = nt.norm.indexOf(na.norm, nFrom);
    if (at >= 0) return nt.map[at];

    const lens = [na.norm.length, na.norm.length - 2, na.norm.length + 2].filter(
      n => n >= 4 && n <= nt.norm.length
    );
    let best = null;
    for (const len of lens) {
      const step = len > 40 ? 2 : 1;
      for (let i = nFrom; i + len <= nt.norm.length; i += step) {
        const score = bigramDice(nt.norm.slice(i, i + len), na.norm);
        if (!best || score > best.score) best = { start: i, score };
        if (score >= 0.985) break;
      }
    }
    if (best && best.score >= 0.72) return nt.map[best.start];
    return -1;
  }

  /**
   * 这一段看起来是"整段散文"吗？
   *
   * 用在两道护栏上（模型把它判成 figure/table、或把它归进图块时）：
   * 图内文字、表格数据通常很短、也不以句末标点结尾。一旦把正文当图内文字剔掉，
   * 用户在阅读视图里就**看不到这段内容了**，代价远大于"少剔一段"（最多多翻译一次）。
   */
  function looksLikeProseParagraph(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return false;
    if (t.length > 120) return true;
    return t.length > 40 && /[.!?。！？]["'”’)\]]*$/.test(t);
  }

  /** 这一片字符映射涉及到的 span（去重、保持文档顺序） */
  function spansOfCharMap(charMap) {
    const out = [];
    const seen = new Set();
    (charMap || []).forEach(c => {
      if (c && c.span && !seen.has(c.span)) {
        seen.add(c.span);
        out.push(c.span);
      }
    });
    return out;
  }

  /** 校验句子下标与文本严格自洽（这个仓库被"下标错位"坑过多次，搬句子前一律验一遍） */
  function sentencesConsistent(text, sents) {
    if (!Array.isArray(sents) || sents.length === 0) return false;
    for (const s of sents) {
      if (!s || !Number.isFinite(s.startIdx) || !Number.isFinite(s.endIdx)) return false;
      if (s.startIdx < 0 || s.endIdx > text.length || s.startIdx >= s.endIdx) return false;
      if (text.slice(s.startIdx, s.endIdx) !== s.text) return false;
    }
    return true;
  }

  /** 切出一片：cleanText 与 charMap 严格 1:1，所以切片是精确的；首尾空白一起去掉（同步裁 charMap） */
  function sliceParaPart(para, start, end) {
    const text = (para && para.cleanText) || '';
    let s = Math.max(0, Math.min(start, text.length));
    let e = Math.max(s, Math.min(end, text.length));
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s$/.test(text[e - 1])) e--;
    return { start: s, end: e, text: text.slice(s, e), charMap: ((para && para.charMap) || []).slice(s, e) };
  }

  /**
   * 造出拆分后的一片。句子与译文**从原段继承**：原段的句下标与 cleanText 严格对应，
   * 落在这一片范围内的句子连同译文一起搬过来——这是唯一不会猜错的做法。
   * 被切点劈成两半的句子两边都不留（宁缺毋滥），那一片会被重新翻译。
   */
  function buildSplitPiece(orig, slice, part, isFirst) {
    const type = normalizeVisionType(part && part.type) || (isFirst ? orig.type || 'body' : 'body');
    const pieceSpans = spansOfCharMap(slice.charMap);
    // 横向范围按**这一片自己的 span** 重算（不继承整段的范围），
    // 否则"在左侧 PDF 定位"会往整段中间跑偏。
    let minX = orig.minX;
    let maxX = orig.maxX;
    const xs = [];
    pieceSpans.forEach(sp => {
      if (sp && Number.isFinite(sp._pdfX)) xs.push([sp._pdfX, sp._pdfX + (Number(sp._pdfW) || 0)]);
    });
    if (xs.length) {
      minX = Math.min(...xs.map(x => x[0]));
      maxX = Math.max(...xs.map(x => x[1]));
    }
    const piece = {
      id: orig.id,
      type,
      cleanText: slice.text,
      charMap: slice.charMap,
      rawSpans: pieceSpans,
      sentencesEn: [],
      translation: '',
      sentenceTranslations: [],
      minX,
      maxX,
      visionFromSplit: true
    };
    if (part && part.latex) piece.visionLatex = String(part.latex).trim();
    if (part && part.at) piece.visionSplitAt = part.at;
    if (Array.isArray(orig.visionInline) && orig.visionInline.length) piece.visionInline = orig.visionInline.slice();

    const srcSents = Array.isArray(orig.sentencesEn) ? orig.sentencesEn : [];
    const srcTrans = Array.isArray(orig.sentenceTranslations) ? orig.sentenceTranslations : [];
    const aligned =
      srcSents.length > 0 && srcTrans.length === srcSents.length && !srcTrans.some(t => !t || !t.trim());
    const kept = [];
    let straddler = false;
    srcSents.forEach((s, i) => {
      const sIdx = Number.isFinite(s.startIdx) ? s.startIdx : 0;
      const eIdx = Number.isFinite(s.endIdx) ? s.endIdx : sIdx + String(s.text || '').length;
      if (eIdx <= slice.start || sIdx >= slice.end) return;
      if (sIdx >= slice.start && eIdx <= slice.end) kept.push({ s, i });
      else straddler = true;
    });

    if (!straddler && kept.length > 0) {
      const moved = kept.map(({ s }) => ({
        text: s.text,
        startIdx: s.startIdx - slice.start,
        endIdx: s.endIdx - slice.start
      }));
      if (sentencesConsistent(piece.cleanText, moved)) {
        piece.sentencesEn = moved;
        if (aligned) {
          piece.sentenceTranslations = kept.map(({ i }) => srcTrans[i]);
          piece.translation = piece.sentenceTranslations.join(' ');
        }
        return piece;
      }
    }
    piece.sentencesEn = splitEnglishSentencesSmart(piece.cleanText);
    piece.needsRetranslate = true;
    return piece;
  }

  /**
   * 把两段合成一段（模型判为"被错误切开的同一段"）。
   *
   * 【译文的处理原则】不做"两半译文硬拼"：两半各自的逐句译文与合并后的切句无法保证严格 1:1，
   * 硬拼就会出现"看着对齐、其实错位"的假象（这个仓库最贵的一类 bug）。
   * 于是只有两边都完整对齐、且切点确实落在句末时才搬句子；切点落在句中时把
   * "a 的末句 + b 的首句"真正拼成一句（文本与译文一起拼）；其余情况清空译文交给队列重译。
   */
  function mergeParagraphs(a, b) {
    const aText = a.cleanText || '';
    const bText = b.cleanText || '';
    const hyphen = /[-‐]$/.test(aText);
    const sep = hyphen ? '' : ' ';
    const mergedText = hyphen ? aText.slice(0, -1) + bText : `${aText} ${bText}`;

    const charMap = (a.charMap || []).slice();
    if (hyphen) {
      charMap.pop(); // 去掉了末尾连字符，charMap 同步弹掉一个，保持 1:1
    } else if (bText) {
      // 合成出来的空格也要有字符映射（与 commitParagraph 的做法一致）
      charMap.push({ span: (b.rawSpans && b.rawSpans[0]) || null, offset: 0 });
    }
    charMap.push(...(b.charMap || []));

    const merged = Object.assign({}, a, {
      cleanText: mergedText,
      charMap,
      rawSpans: (a.rawSpans || []).concat(b.rawSpans || []),
      minX: Math.min(Number(a.minX) || 0, Number(b.minX) || 0),
      maxX: Math.max(Number(a.maxX) || 0, Number(b.maxX) || 0),
      sentencesEn: [],
      translation: '',
      sentenceTranslations: [],
      joinedByVision: true
    });
    // 行内公式替换表要**两段合起来**：模型常把公式的替换表给在下一段上，
    // 只留前一段的会导致合并后那条公式又变回残渣。
    const mergedInline = (a.visionInline || []).concat(b.visionInline || []);
    if (mergedInline.length) merged.visionInline = mergedInline.slice(0, 12);
    else delete merged.visionInline;

    const aSents = Array.isArray(a.sentencesEn) ? a.sentencesEn : [];
    const bSents = Array.isArray(b.sentencesEn) ? b.sentencesEn : [];
    const aTrans = Array.isArray(a.sentenceTranslations) ? a.sentenceTranslations : [];
    const bTrans = Array.isArray(b.sentenceTranslations) ? b.sentenceTranslations : [];
    const bothAligned =
      aSents.length > 0 &&
      bSents.length > 0 &&
      aTrans.length === aSents.length &&
      bTrans.length === bSents.length &&
      !aTrans.some(t => !t || !t.trim()) &&
      !bTrans.some(t => !t || !t.trim());
    const offset = hyphen ? Math.max(0, aText.length - 1) : aText.length + 1;

    if (bothAligned) {
      const aEndsSentence = /[.!?。！？]["'”’)\]]*\s*$/.test(aText);
      let sents;
      let trans;
      if (aEndsSentence) {
        sents = aSents
          .map(s => ({ text: s.text, startIdx: s.startIdx, endIdx: s.endIdx }))
          .concat(bSents.map(s => ({ text: s.text, startIdx: s.startIdx + offset, endIdx: s.endIdx + offset })));
        trans = aTrans.concat(bTrans);
      } else {
        const joinA = aSents[aSents.length - 1];
        const joinB = bSents[0];
        const glued = /[-‐]$/.test(joinA.text) ? joinA.text.slice(0, -1) + joinB.text : `${joinA.text} ${joinB.text}`;
        const gluedTrans = `${aTrans[aTrans.length - 1]}${bTrans[0]}`;
        sents = aSents
          .slice(0, -1)
          .map(s => ({ text: s.text, startIdx: s.startIdx, endIdx: s.endIdx }))
          .concat([{ text: glued, startIdx: joinA.startIdx, endIdx: joinB.endIdx + offset }])
          .concat(
            bSents.slice(1).map(s => ({ text: s.text, startIdx: s.startIdx + offset, endIdx: s.endIdx + offset }))
          );
        trans = aTrans.slice(0, -1).concat([gluedTrans]).concat(bTrans.slice(1));
      }
      if (sentencesConsistent(mergedText, sents)) {
        merged.sentencesEn = sents;
        merged.sentenceTranslations = trans;
        merged.translation = trans.join(' ');
        return merged;
      }
    }

    merged.sentencesEn = splitEnglishSentencesSmart(mergedText);
    merged.needsRetranslate = true;
    return merged;
  }

  /**
   * 视觉手术：按模型的判断在**本地未手术的分段**上真的做拆分/合并/改类型/改顺序/丢弃。
   *
   * 铁律不变：**坐标永远来自本地文本层**。这里只动 cleanText / charMap / rawSpans /
   * sentencesEn / translation —— span 引用原样搬过去，所以划线、点中文跳英文、
   * 导出 PDF 把高亮画回原位全部照旧精确（charMap 是逐字符的，切开后每片只覆盖自己的字符）。
   *
   * 传入的 list 会被**就地**修改（与 joinAcrossColumnBreak 的写法一致），调用方负责先克隆一份。
   * 任何一处判断无法安全落地（锚点定位不到、相邻关系不可信）都**跳过那一处**并记进 notes，
   * 绝不猜一个位置去切。
   */
  function visionSurgery(list, result) {
    const stats = {
      applied: 0,
      typeChanged: 0,
      orderChanged: 0,
      merged: 0,
      split: 0,
      dropped: 0,
      grouped: 0,
      anchored: 0,
      anchorMissed: 0,
      inline: 0,
      notes: []
    };
    const segsRaw = result && Array.isArray(result.segments) ? result.segments : [];
    if (!Array.isArray(list) || list.length === 0 || segsRaw.length === 0) return stats;

    const byId = new Map();
    list.forEach(p => byId.set(Number(p.id), p));
    const segs = segsRaw
      .filter(s => s && Number.isFinite(Number(s.index)) && byId.has(Number(s.index)))
      .map(s => Object.assign({}, s, { index: Number(s.index) }));
    if (segs.length === 0) return stats;
    stats.applied = segs.length;
    const segByIndex = new Map(segs.map(s => [s.index, s]));

    // ---- 1) 阅读顺序 ----
    // ① 每条都给了 order → 按 order 排（模型显式声明了顺序）；
    // ② 没给/给得不全 → 按回包里 segments 的**数组顺序**（提示词就要求它按阅读顺序列出，
    //    实测数组顺序确实等于阅读顺序）。全有或全无，避免"一半按 order、一半按原位置"的混乱排序。
    const allOrdered = segs.length > 1 && segs.every(s => Number.isFinite(Number(s.order)));
    if (segs.length > 1) {
      const pos = new Map();
      if (allOrdered) {
        segs
          .slice()
          .sort((a, b) => Number(a.order) - Number(b.order))
          .forEach((s, i) => pos.set(s.index, i));
      } else {
        segs.forEach((s, i) => pos.set(s.index, i));
      }
      const before = list.map(p => p.id).join(',');
      list.sort((x, y) => {
        const px = pos.has(Number(x.id)) ? pos.get(Number(x.id)) : Number.MAX_SAFE_INTEGER;
        const py = pos.has(Number(y.id)) ? pos.get(Number(y.id)) : Number.MAX_SAFE_INTEGER;
        return px - py;
      });
      if (list.map(p => p.id).join(',') !== before) stats.orderChanged = 1;
    }

    // ---- 1.5) 行内公式替换表先按编号挂到各段上 ----
    // 【为什么必须在合并之前】模型常把公式的替换表给在"被判 merge_next 的下一段"上；
    // 合并要把它和前一段的替换表**合起来**，否则后一段的会随合并一起丢掉——
    // 实测症状：合并后的正文里那条公式只剩残渣可看（用户看到的"没有 latex 渲染"）。
    segs.forEach(s => {
      if (!Array.isArray(s.inline) || s.inline.length === 0) return;
      const para = byId.get(s.index);
      if (!para) return;
      para.visionInline = s.inline.slice(0, 8);
      stats.inline++;
    });

    // ---- 2) 拆分：把"混了多种内容"的一段按锚点切开（锚点由模型按文本层残渣写法给出）----
    const out = [];
    list.forEach(p => {
      const seg = segByIndex.get(Number(p.id));
      if (!seg) {
        out.push({ seg: null, para: p });
        return;
      }
      // parts 优先（每片自带类型与 LaTeX）；只有老式 splitAt 时按同样类型兜底拆
      let parts = Array.isArray(seg.parts) && seg.parts.length >= 2 ? seg.parts.slice() : null;
      if (!parts && seg.action === 'split' && Array.isArray(seg.splitAt) && seg.splitAt.length >= 1) {
        parts = [{ type: seg.type }].concat(seg.splitAt.map(at => ({ type: seg.type, at })));
      }
      if (!parts || seg.action !== 'split') {
        out.push({ seg, para: p });
        return;
      }
      const cuts = [];
      let from = 0;
      let ok = true;
      for (let k = 1; k < parts.length; k++) {
        const anchor = parts[k] && parts[k].at;
        const at = anchor ? locateAnchorIndex(p.cleanText, anchor, from) : -1;
        if (at < 0) {
          ok = false;
          break;
        }
        cuts.push(at);
        from = at;
      }
      const bounds = [0].concat(cuts).concat([(p.cleanText || '').length]);
      const made = [];
      if (ok) {
        for (let k = 0; k < parts.length; k++) {
          const sl = sliceParaPart(p, bounds[k], bounds[k + 1]);
          if (!sl.text) continue;
          made.push(buildSplitPiece(p, sl, parts[k], k === 0));
        }
      }
      if (!ok || made.length < 2) {
        stats.anchorMissed++;
        stats.notes.push(
          `一段的拆分点没能在文本层里定位（${String((parts[1] && parts[1].at) || '').slice(0, 30)}…），已跳过该处拆分`
        );
        out.push({ seg, para: p });
        return;
      }
      stats.split++;
      stats.anchored += cuts.length;
      made.forEach((piece, idx) => {
        // 模型偶尔把整段公式的 latex 放在顶层、只拆出正文片：兜底给第一片留住它，
        // 否则那条公式就只剩残渣可看了。
        if (idx === 0 && !piece.visionLatex && seg.latex) piece.visionLatex = String(seg.latex).trim();
        out.push({ seg: null, para: piece });
      });
    });

    // ---- 3) 合并：模型说"这一段与紧随其后的那一段本应是同一段" ----
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      if (!a.seg || a.seg.action !== 'merge_next') continue;
      // 只合并模型明确判断过的相邻段：拆出来的片段、没被判断过的段落，邻接关系都不可信
      if (!b || !b.seg || b.seg.action === 'split' || b.seg.action === 'drop') continue;
      // 【护栏一：下一段必须"看起来像半句的续写"】以小写字母/数字/左括号/引号开头才算续句。
      // 实测模型有把"本段续上一段"错标成 merge_next 的倾向（方向搞反：下一段其实是
      // 大写开头的新段落）。本地跨栏合并一直用同一条保守判据——见 joinAcrossColumnBreak
      // 的 looksContinuation——这里照抄，宁可漏合一次，也不能把两段正常正文粘在一起。
      const nextText = String(b.para.cleanText || '').trim();
      if (!/^[a-z0-9(“"'\[]/.test(nextText)) continue;
      // 【护栏二：标题/图注/元信息不参与合并】"2 Related works" → "2.1 Semi-supervised…"
      // 这种字面看着像续句的，其实是小节标题，永远不该合并。
      const nextType = normalizeVisionType(b.seg.type) || b.para.type;
      if (['heading', 'title', 'caption', 'figure-label', 'noise', 'metadata'].indexOf(nextType) >= 0) continue;
      out.splice(i, 2, { seg: a.seg, para: mergeParagraphs(a.para, b.para) });
      stats.merged++;
      i--;
    }

    // ---- 4) 类型 / LaTeX / 行内公式 / 丢弃 ----
    out.forEach(ent => {
      const seg = ent.seg;
      const para = ent.para;
      if (!seg || !para) return;
      const type = normalizeVisionType(seg.type);
      if (type && para.type !== type) {
        // 【护栏】模型把一整段散文判成图内文字/页眉页脚 → 保留本地类型。
        // 正文被剔掉是不可逆的损失（阅读视图里直接看不到这段内容），而"少剔一段"最多多翻译一次。
        if ((type === 'figure-label' || type === 'noise') && looksLikeProseParagraph(para.cleanText)) {
          stats.notes.push(`模型把一段正文判成 ${type}（${String(para.cleanText || '').slice(0, 18)}…），已保留`);
        } else {
          para.type = type;
          para.visionType = type;
          stats.typeChanged++;
        }
      }
      if (seg.latex) para.visionLatex = String(seg.latex).trim();
      // 行内公式替换表在合并**之前**就按编号挂好了（见步骤 1.5）：这里绝不能再按本段的
      // inline 覆盖一次，否则合并时刚合起来的替换表会被覆盖回只剩前一段的。
      if (seg.why) para.visionWhy = seg.why;
      para.visionAction = seg.action || 'keep';
      if (seg.action === 'drop' && para.type !== 'noise') {
        // 同一条护栏：要丢的若是明显一整段正文，宁可多留一段也不删
        if (looksLikeProseParagraph(para.cleanText)) {
          stats.notes.push(`模型要丢弃一段明显是正文的内容（${String(para.cleanText || '').slice(0, 18)}…），已保留`);
        } else {
          para.type = 'noise';
          stats.dropped++;
        }
      }
      const g = Number(seg.group);
      if (Number.isInteger(g) && g > 0) para.visionGroup = g;
    });

    // ---- 5) 图块分组：同一 group 的成员收拢到一起，图注留成卡片、图内文字整片丢掉 ----
    const groupIds = [];
    out.forEach(ent => {
      const g = ent.para ? Number(ent.para.visionGroup) : NaN;
      if (Number.isInteger(g) && g > 0 && groupIds.indexOf(g) < 0) groupIds.push(g);
    });
    groupIds.forEach(g => {
      const members = out.filter(ent => ent.para && Number(ent.para.visionGroup) === g);
      if (members.length < 2) return;
      // 【必须有明确的图注才敢丢】没有图注做锚点时，把"哪个是图内文字"交给模型判断太危险——
      // 一旦把整块图注误判成图内文字就会被丢掉。所以这种情况只收拢顺序、不做任何丢弃。
      const capEnt = members.find(ent => ent.para.type === 'caption');
      if (!capEnt) {
        stats.notes.push('一处图块没有标出图注，已只收拢顺序、不丢弃任何内容');
        return;
      }
      members.forEach(ent => {
        if (ent === capEnt) return;
        const p = ent.para;
        // 【护栏】明显是整段散文的成员不丢：图内文字/表格数据通常很短、也不以句末标点结尾。
        // 万一模型把图下方/表下方的正文也归进同一个 group，这条能挡住"正文被当成图内文字丢掉"。
        const t = String(p.cleanText || '').trim();
        if (looksLikeProseParagraph(t)) {
          stats.notes.push(`图块里有一段明显是正文（${t.slice(0, 20)}…），已保留不丢`);
          return;
        }
        if (p.type !== 'figure-label' && p.type !== 'noise') {
          p.type = 'figure-label';
          p.visionType = 'figure-label';
          stats.typeChanged++;
        }
        // 图内文字本来就不该送翻译：连它的旧译文也清掉，免得精读稿里冒出图内文字的"译文"
        p.translation = '';
        p.sentenceTranslations = [];
      });
      stats.grouped++;
    });
    const regrouped = [];
    const done = new Set();
    out.forEach(ent => {
      const g = ent.para ? Number(ent.para.visionGroup) : NaN;
      if (!Number.isInteger(g) || g <= 0) {
        regrouped.push(ent);
        return;
      }
      if (done.has(g)) return;
      done.add(g);
      out.forEach(e2 => {
        if (e2.para && Number(e2.para.visionGroup) === g) regrouped.push(e2);
      });
    });

    // ---- 6) 重新编号 + 把 data-para-id 改到新编号（否则点左侧 PDF 会定位到别的段落）----
    list.length = 0;
    regrouped.forEach(ent => list.push(ent.para));
    let bodyCount = 0;
    list.forEach((p, idx) => {
      p.id = idx;
      p.bodyIndex = undefined;
      if (p.type === 'body') p.bodyIndex = ++bodyCount;
      (p.rawSpans || []).forEach(sp => {
        if (sp && typeof sp.setAttribute === 'function') sp.setAttribute('data-para-id', `${idx}`);
      });
    });
    return stats;
  }

  /**
   * 应用视觉判断结果（**只改类型 + 顺序 + 丢弃**，不动分段）。
   *
   * 这是"关闭视觉手术"时的路径（设置 academicReader.visionSurgery = false），
   * 也是 1.2.0 的行为。真的合并/拆分见 visionSurgery / applyVisionStructure。
   */
  function applyVisionSegments(pageNum, result) {
    if (!result || !Array.isArray(result.segments)) return { changed: 0, applied: 0 };
    const byId = new Map((currentParagraphs || []).map(p => [p.id, p]));
    const dropped = new Set();
    let changed = 0;
    let applied = 0;

    result.segments.forEach(s => {
      const para = byId.get(Number(s.index));
      if (!para) return;
      applied++;
      if (s.action === 'drop') {
        dropped.add(para.id);
        return;
      }
      if (s.type) {
        // 类型要收敛到阅读器自己的词汇：模型给的 figure / table（图内、表内文字）
        // 必须落到 figure-label，否则它们照旧会被送进翻译队列。
        const nt = normalizeVisionType(s.type);
        if (nt && para.type !== nt) {
          para.type = nt;
          para.visionType = nt;
          changed++;
        }
      }
      // 公式的 LaTeX（模型看图写的）——卡片里直接渲染成公式，不再显示 "Y ̂ t" 这种残渣
      if (s.latex) {
        para.visionLatex = s.latex;
        changed++;
      }
      if (Array.isArray(s.splitAt) && s.splitAt.length) para.visionSplitAt = s.splitAt;
      if (s.why) para.visionWhy = s.why;
      para.visionAction = s.action || 'keep';
    });

    // 顺序：模型给了 order 就按它排；没给的保持原相对位置（稳定排序）
    const ordered = result.segments
      .filter(s => Number.isFinite(Number(s.order)))
      .sort((a, b) => Number(a.order) - Number(b.order))
      .map(s => Number(s.index));
    if (ordered.length > 1) {
      const pos = new Map(ordered.map((id, i) => [id, i]));
      const before = (currentParagraphs || []).map(p => p.id).join(',');
      currentParagraphs.sort((a, b) => {
        const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
        const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
        return pa - pb;
      });
      if ((currentParagraphs || []).map(p => p.id).join(',') !== before) changed++;
    }

    // 丢弃：标成 noise —— 卡片、翻译队列、导出都会跳过它（像图表标签那样）
    dropped.forEach(id => {
      const para = byId.get(id);
      if (para && para.type !== 'noise') {
        para.type = 'noise';
        changed++;
      }
    });

    try {
      renderTranslationCards(pageNum, currentParagraphs);
      renderNotesList();
    } catch (e) {
      console.warn('[Viewer] 应用视觉结果后重绘失败:', e);
    }
    // 缓存到论文数据（同一页只花一次钱），由宿主持久化
    cacheVisionStructure(pageNum, result);
    return { changed, applied };
  }

  /** 克隆一份段落（视觉手术永远在本地原件上重放，所以每次都要一份互不污染的副本） */
  function cloneParagraphs(list) {
    return (list || []).map(p =>
      Object.assign({}, p, {
        charMap: (p.charMap || []).slice(),
        rawSpans: (p.rawSpans || []).slice(),
        sentencesEn: (p.sentencesEn || []).map(s => Object.assign({}, s)),
        sentenceTranslations: (p.sentenceTranslations || []).slice()
      })
    );
  }

  /**
   * 视觉手术要作用的"原件"：**永远是本地代码切出来的那一份**，绝不是"已经手术过的当前结果"。
   * 这样翻页回来、缩放重渲染、手动点「视觉重排」都是幂等的 —— 同一份判断重放多少次结果都一样。
   */
  function visionBaseParagraphs() {
    if (localParagraphsPage === currentPage && localParagraphsSnapshot && localParagraphsSnapshot.length) {
      return localParagraphsSnapshot;
    }
    return currentParagraphs || [];
  }

  /**
   * 视觉缓存能不能直接用？
   * ① 协议版本必须 ≥2（v1 的回包里没有 parts/group/inline，套用只会得到"类型改了但没真的合并拆分"）；
   * ② **不能是"用另一个视觉模型判出来的"**：模型换了就重新问一次，这也是移除
   *    「视觉重排」按钮之后，用户唯一的"重判本页"手段（换模型即可）。
   *    新缓存记 `requested`（请求时配置的模型名）；老缓存没有这个字段，
   *    就退化成比较"实际服务的模型"——两者相同就不重问，避免升级后凭空多花钱。
   *
   * 历史遗留的 `disabled` 标记**一律忽略**：那是早期"本页别再自动套用"那个开关写下的，
   * 现在视觉重排是默认行为，不该有哪一页被永久排除在外。
   */
  function isUsableVisionCache(entry) {
    if (!entry) return false;
    if (!Array.isArray(entry.segments) || entry.segments.length === 0) return false;
    // 注意写成"不满足才拒"：v1 老缓存没有 version 字段，Number(undefined) 是 NaN，
    // 用 `NaN < 2` 判会漏过去（实测被冒烟测试抓到过一次）。
    if (!(Number(entry.version) >= 2)) return false;
    if (!configuredVisionModel) return true; // 没配具体模型名（沿用问答模型）→ 无从比较，照用
    if (entry.requested !== undefined) return entry.requested === configuredVisionModel;
    return !entry.model || entry.model === configuredVisionModel;
  }

  /** 把视觉结果写进论文数据（同一页只花一次钱），由宿主持久化 */
  function cacheVisionStructure(pageNum, result) {
    try {
      paperData.visionStructure = paperData.visionStructure || {};
      paperData.visionStructure[String(pageNum)] = {
        version: Number(result && result.version) || 2,
        model: (result && result.model) || '',
        // 记下"这次是拿哪个视觉模型判的"：换了模型，这页缓存就作废重判（见 isUsableVisionCache）
        requested: configuredVisionModel || '',
        at: Date.now(),
        columns: result && result.columns,
        fixes: (result && result.fixes) || '',
        segments: (result && result.segments) || []
      };
      vscode.postMessage({
        type: 'syncVisionStructure',
        page: pageNum,
        structure: paperData.visionStructure[String(pageNum)]
      });
    } catch (e) {
      /* 缓存失败不影响本次校正 */
    }
  }

  /** 改动摘要（卡片区那行提示用） */
  function summarizeVisionStats(stats) {
    const bits = [];
    if (stats.split) bits.push(`拆分 ${stats.split} 处`);
    if (stats.merged) bits.push(`合并 ${stats.merged} 处`);
    if (stats.typeChanged) bits.push(`改类型 ${stats.typeChanged} 处`);
    if (stats.dropped) bits.push(`丢弃 ${stats.dropped} 段`);
    if (bits.length === 0 && stats.orderChanged) bits.push('调整了阅读顺序');
    if (stats.anchorMissed) bits.push(`${stats.anchorMissed} 处拆分点没定位到`);
    return bits.length ? bits.join(' / ') : '无需改动';
  }

  /**
   * 应用视觉判断（**手术版**，设置 academicReader.visionSurgery 默认开）：
   * 真的按模型的判断合并/拆分，再改类型/顺序/丢弃，然后重绘卡片并缓存结果。
   */
  function applyVisionStructure(pageNum, result) {
    if (!result || !Array.isArray(result.segments)) return { changed: 0, applied: 0, stats: null, summary: '' };
    const list = cloneParagraphs(visionBaseParagraphs());
    if (list.length === 0) return { changed: 0, applied: 0, stats: null, summary: '' };

    const stats = visionSurgery(list, result);

    // 拆分时从原段继承过来的逐句译文要写进缓存：否则缩放/翻页重渲染后按新指纹查不到，
    // 这些片段会被重新翻译一遍（白花钱，而且用户会觉得"译文自己没了"）。
    list.forEach(p => {
      if (!p || !p.translation) return;
      try {
        const key = getParaCacheKey(pageNum, p);
        paperData.translations = paperData.translations || {};
        paperData.translations[key] = p.translation;
        if (Array.isArray(p.sentenceTranslations) && p.sentenceTranslations.length) {
          paperData.sentenceTranslations = paperData.sentenceTranslations || {};
          paperData.sentenceTranslations[key] = p.sentenceTranslations;
        }
      } catch (e) {
        /* 写缓存失败不影响本次手术 */
      }
    });

    currentParagraphs = list;
    try {
      renderTranslationCards(pageNum, currentParagraphs);
      renderNotesList();
    } catch (e) {
      console.warn('[Viewer] 视觉手术后重绘失败:', e);
    }
    cacheVisionStructure(pageNum, result);
    // 归档快照要跟着改，否则导出的「全文双语精读稿」里还是旧的分段
    try {
      archivePageParagraphs(pageNum, currentParagraphs);
    } catch (e) {
      /* 归档失败只影响导出 */
    }

    const changed = stats.typeChanged + stats.merged + stats.split + stats.dropped + stats.orderChanged;
    return { applied: stats.applied, changed, stats, summary: summarizeVisionStats(stats) };
  }

  /**
   * 生成全文双语精读稿。
   *
   * 与旧版"导出笔记"的根本区别：旧版只把 annotations 按页罗列，没批注就是空文件；
   * 这里以**你读过的每一页的段落**为骨架，把原文、译文、我的批注、AI 答疑
   * 交织在同一段之下，导出的是一份能直接读、能归档、能给别人的文稿。
   */
  function buildReadingDocMarkdown() {
    const paperTitle = ((dom.paperTitle && dom.paperTitle.textContent) || '未命名文献').trim();
    const baseName = paperTitle.replace(/\.pdf$/i, '');
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const timeOf = t => {
      const d = new Date(t || Date.now());
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
        d.getHours()
      ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const annotations = Array.isArray(paperData.annotations) ? paperData.annotations : [];
    const aiQa = Array.isArray(paperData.aiQa) ? paperData.aiQa : [];

    // 收录范围 = 翻阅过的页 ∪ 有批注/答疑的页（有后者但没译文时也要出，那是用户自己的东西）
    const pages = new Set([...pageParaArchive.keys()]);
    annotations.forEach(a => pages.add(a.page));
    aiQa.forEach(q => pages.add(q.page));
    const pageList = [...pages].filter(n => Number.isFinite(n)).sort((a, b) => a - b);

    const totalPagesText = Number.isFinite(totalPages) && totalPages > 0 ? `共 ${totalPages} 页` : '';
    const engineText = currentEngineTag ? `翻译引擎 ${currentEngineTag}` : '';

    let md = '---\n';
    md += `title: "${baseName}"\n`;
    md += `source: ${paperTitle}\n`;
    md += `generated: ${stamp}\n`;
    if (engineText) md += `engine: ${currentEngineTag}\n`;
    md += `pages: ${formatPageRanges(pageList)}${totalPagesText ? ` / ${totalPagesText}` : ''}\n`;
    md += `annotations: ${annotations.length}\n`;
    md += `ai_qa: ${aiQa.length}\n`;
    md += '---\n\n';

    md += `# ${baseName} · 双语精读稿\n\n`;
    md += `> 由「文献对照翻译阅读器」导出 · ${stamp}\n`;
    md += `> 收录第 ${formatPageRanges(pageList)} 页${totalPagesText ? `（${totalPagesText}）` : ''}`;
    md += ` · 批注 ${annotations.length} 条 · AI 答疑 ${aiQa.length} 条`;
    md += engineText ? ` · ${engineText}\n` : '\n';
    md += `>\n> 未翻阅的页面不会自动翻译，因此不在本文档中；翻译与批注都会自动保存，下次继续读同一篇即可补齐。\n\n`;

    if (pageList.length === 0) {
      md += `*这份文稿还什么都没有：请先在左侧翻几页，让插件解析并翻译段落，再回来导出。*\n`;
      return md;
    }

    // 目录
    md += `## 目录\n\n`;
    pageList.forEach(p => {
      const paraCount = (pageParaArchive.get(p) || []).filter(x => x.type !== 'figure-label' && x.type !== 'noise').length;
      const notes = annotations.filter(a => a.page === p).length;
      const qas = aiQa.filter(q => q.page === p).length;
      const bits = [`${paraCount} 段`, notes ? `${notes} 批注` : '', qas ? `${qas} 答疑` : ''].filter(Boolean);
      md += `- [第 ${p} 页](#第-${p}-页) —— ${bits.join(' · ')}\n`;
    });
    md += `\n---\n\n`;

    /** 已挂到某个段落上的批注 / 答疑，避免重复输出 */
    const usedAnnotIds = new Set();
    const usedQaIds = new Set();

    pageList.forEach(pageNum => {
      const paras = (pageParaArchive.get(pageNum) || []).filter(p => p.type !== 'figure-label' && p.type !== 'noise');
      const pageAnnotations = annotations.filter(a => a.page === pageNum);
      const pageQa = aiQa.filter(q => q.page === pageNum);

      md += `## 第 ${pageNum} 页\n\n`;

      if (paras.length === 0) {
        md += `*（这一页没有留存段落：可能是只标了批注，或本页内容为图表）*\n\n`;
      }

      let ordinal = 0;
      paras.forEach(para => {
        const sourceText = (para.cleanText || '').trim();
        if (!sourceText) return;
        const translation = resolveArchivedTranslation(pageNum, para);
        const sentences = resolveArchivedSentences(pageNum, para);
        const label = PARA_TYPE_LABEL[para.type] || '';

        if (para.type === 'title') {
          md += `### ${sourceText}\n\n`;
        } else if (para.type === 'heading') {
          md += `### ${sourceText}\n\n`;
        } else {
          ordinal++;
          md += `#### ${label ? `${label} · ` : ''}¶${ordinal}\n\n`;
        }

        // 原文 / 译文：对齐时逐句成行（方便逐句精读对照），否则整段
        const enLines = para.sentencesEn && para.sentencesEn.length ? para.sentencesEn.map(s => s.text) : [sourceText];
        if (para.type === 'title' || para.type === 'heading') {
          if (translation) md += `${mdQuote(translation)}\n\n`;
        } else {
          md += `**原文**\n\n${mdQuoteLines(enLines)}\n\n`;
          if (translation) {
            const zhLines = sentences && sentences.length === enLines.length ? sentences : [translation];
            md += `**译文**\n\n${mdQuoteLines(zhLines)}\n\n`;
          } else {
            // 公式/符号段落本来就没有可翻译的文字，别说成"尚未翻译"（会被当成失败）
            md +=
              para.type === 'formula'
                ? `**译文**\n\n*（公式/符号段落，无需翻译）*\n\n`
                : `**译文**\n\n*（本段尚未翻译）*\n\n`;
          }
        }

        // 挂在这一段上的批注
        pageAnnotations
          .filter(a => a.paraIndex !== undefined && a.paraIndex === para.id)
          .forEach(a => {
            usedAnnotIds.add(a.id);
            md += `**📌 我的批注 · ${ANNOT_COLOR_LABEL[a.color] || '📌 高亮'} · ${timeOf(a.timestamp)}**\n\n`;
            if (a.note && a.note.trim()) {
              md += `${a.note.trim()}\n\n`;
            } else {
              md += `*（只有高亮，没有写批注）*\n\n`;
            }
          });

        // 挂在这一段上的 AI 答疑
        pageQa
          .filter(q => q.selectedText && sourceText.includes(q.selectedText.slice(0, 40)))
          .forEach(q => {
            usedQaIds.add(q.id);
            md += `**🤖 AI 答疑 · ${timeOf(q.at)}${q.model ? ` · ${q.model}` : ''}**\n\n`;
            md += `**问**：${q.question}\n\n`;
            md += `**答**：\n\n${q.answer}\n\n`;
          });
      });

      // 没挂上段落的批注 / 答疑（跨页、整页心得、手动改过段落切分等）
      const orphans = pageAnnotations.filter(a => !usedAnnotIds.has(a.id));
      const orphanQa = pageQa.filter(q => !usedQaIds.has(q.id));
      if (orphans.length || orphanQa.length) {
        md += `### 本页其它记录\n\n`;
        orphans.forEach(a => {
          usedAnnotIds.add(a.id);
          md += `**📌 我的批注 · ${ANNOT_COLOR_LABEL[a.color] || '📌 高亮'} · ${timeOf(a.timestamp)}**\n\n`;
          md += `> ${String(a.text || '').replace(/\n/g, '\n> ')}\n\n`;
          if (a.note && a.note.trim()) md += `${a.note.trim()}\n\n`;
        });
        orphanQa.forEach(q => {
          usedQaIds.add(q.id);
          md += `**🤖 AI 答疑 · ${timeOf(q.at)}${q.model ? ` · ${q.model}` : ''}**\n\n`;
          if (q.selectedText) md += `> 针对：${q.selectedText.replace(/\n/g, ' ').slice(0, 200)}\n\n`;
          md += `**问**：${q.question}\n\n`;
          md += `**答**：\n\n${q.answer}\n\n`;
        });
      }

      md += `---\n\n`;
    });

    return md;
  }

  /** 图表内部标签（轴标签/图例/子图编号）：只展示原文，不送翻译 */
  function renderFigureLabelNoticeHtml(para) {
    const text = (para && para.cleanText) || '';
    return `
      <div class="trans-skip-note">图表内部标签，未翻译</div>
      <div class="sentence-pair-row" data-sent-idx="0" title="点击在左侧 PDF 中高亮">
        <div class="sent-num">·</div>
        <div class="sent-content">
          <div class="sent-en">${renderEnTextHtml(text, para && para.visionInline)}</div>
        </div>
      </div>`;
  }

  /**
   * 公式卡片的正文：把视觉模型看图转写出来的 LaTeX 渲染成真正的公式。
   *
   * 为什么不直接渲染段落原文：PDF 文本层抽出来的公式是 "L cycle,t = L (Y ̂ t, Y t)" 这种残渣，
   * 上下标全丢、希腊字母变普通字符，KaTeX 也无从渲染。图像是唯一可靠的来源，
   * 所以让视觉模型把公式**转写成 LaTeX**（见 translator.segmentPageWithVision 的提示词）。
   */
  function renderCardFormulaHtml(para, inline) {
    const latex = String(para.visionLatex || '').trim();
    if (!latex) return renderFigureLabelNoticeHtml(para);
    return `
      <div class="card-formula-block${inline ? ' card-formula-inline' : ''}">
        <div class="card-formula-label">${inline ? '本段公式（视觉模型从页面图像转写为 LaTeX）' : '公式（由视觉模型从页面图像转写为 LaTeX）'}</div>
        <div class="card-formula-body">${renderMathSpan(latex, true)}</div>
        <div class="card-formula-note">公式不翻译；下方原文仅供核对字符层抽取结果</div>
        <div class="card-formula-raw">${escapeHtml(String(para.cleanText || '').slice(0, 300))}</div>
      </div>
    `;
  }

  function renderSentencePairsHtml(para, cachedTrans, cachedSentences) {
    if (!cachedTrans) {
      return `
        <div class="trans-skeleton-box active-loading">
          <div class="skeleton-shimmer-line title-line"></div>
          <div class="skeleton-shimmer-line text-line"></div>
          <div class="skeleton-shimmer-line text-line short"></div>
          <div class="skeleton-shimmer-tip"><span class="mini-spinner spinning"></span> 正在翻译...</div>
        </div>`;
    }

    const sentences = para.sentencesEn || [];
    if (sentences.length === 0) {
      return `<div class="sentence-pair-row" data-sent-idx="0">
        <div class="sent-num">1</div>
        <div class="sent-content">
          <div class="sent-zh">${renderEnTextHtml(cachedTrans, para.visionInline)}</div>
          <div class="sent-en">${renderEnTextHtml(para.cleanText, para.visionInline)}</div>
        </div>
      </div>`;
    }

    const aligned =
      cachedSentences &&
      Array.isArray(cachedSentences) &&
      cachedSentences.length === sentences.length &&
      !cachedSentences.some(s => !s || !s.trim());

    // 未对齐：如实展示整段译文 + 只列英文原句，
    // 绝不再用「按中文标点比例猜切分」的方式伪造句对（那正是出现张冠李戴的原因）。
    if (!aligned) {
      const noteHtml = para.alignmentNote
        ? `<div class="trans-align-warn">⚠️ ${escapeHtml(para.alignmentNote)}</div>`
        : '';
      return `
        <div class="trans-unaligned-box">
          <div class="trans-unaligned-head">整段译文（逐句对齐未成功，已停止猜测式拆分）</div>
          <div class="trans-unaligned-zh">${escapeHtml(cachedTrans)}</div>
          <button class="btn-retry-trans" data-para-id="${para.id}">重新尝试逐句对齐</button>
        </div>
        ${noteHtml}
        <div class="sentence-pair-list en-only">
          ${sentences
            .map(
              (sent, idx) => `
            <div class="sentence-pair-row" data-sent-idx="${idx}" title="点击可在左侧 PDF 中高亮此句">
              <div class="sent-num">${idx + 1}</div>
              <div class="sent-content">
                <div class="sent-en">${renderEnTextHtml(sent.text, para.visionInline)}</div>
              </div>
              <div class="sent-row-actions">
                <button class="btn-row-ai" data-sent-idx="${idx}" title="针对此句向 AI 导师提问">AI</button>
                <button class="btn-row-note" data-sent-idx="${idx}" title="对此句添加批注便签">记</button>
              </div>
            </div>`
            )
            .join('')}
        </div>`;
    }

    return sentences
      .map((sent, idx) => {
        const zh = (cachedSentences[idx] || '').trim();
        return `
        <div class="sentence-pair-row" data-sent-idx="${idx}" title="点击可使左侧 PDF 原件 100% 精确高亮对应本句">
          <div class="sent-num">${idx + 1}</div>
          <div class="sent-content">
            <div class="sent-zh">${renderEnTextHtml(zh, para.visionInline)}</div>
            <div class="sent-en">${renderEnTextHtml(sent.text, para.visionInline)}</div>
          </div>
          <div class="sent-row-actions">
            <button class="btn-row-ai" data-sent-idx="${idx}" title="针对此句向 AI 导师提问">AI</button>
            <button class="btn-row-note" data-sent-idx="${idx}" title="对此句添加批注便签">记</button>
          </div>
        </div>
      `;
      })
      .join('');
  }

  function renderTranslationCards(pageNum, paragraphs) {
    dom.transListContainer.innerHTML = '';

    if (paragraphs.length === 0) {
      dom.transListContainer.innerHTML = `
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          <p>当前页面没有检测到可提取的文字段落。</p>
        </div>`;
      return;
    }

    const typeBadgeMap = {
      title: '<span class="para-type-tag type-title">论文大标题</span>',
      abstract: '<span class="para-type-tag type-abstract">核心摘要</span>',
      keywords: '<span class="para-type-tag type-keywords">关键词</span>',
      significance: '<span class="para-type-tag type-significance">研究意义</span>',
      heading: '<span class="para-type-tag type-heading">核心章节</span>',
      caption: '<span class="para-type-tag type-caption">图表说明</span>',
      'figure-label': '<span class="para-type-tag type-caption">图形标签</span>',
      footnote: '<span class="para-type-tag type-metadata">页面脚注</span>',
      metadata: '<span class="para-type-tag type-metadata">学术元信息</span>',
      body: '<span class="para-type-tag type-body">正文</span>'
    };

    // 图表内部标签（轴标签、图例、子图编号）不送翻译：
    // 模型只会把符号原样吐回来，既没有信息量，还会触发"照搬原文"的假报错。
    const isFigureLabelPara = para => para && (para.type === 'figure-label' || para.type === 'noise');

    // 纯公式/符号段落也一起跳过（判据见 isFormulaLikePara）：
    // 它们是"公式行"不是散文，送翻译只会拿回原文，然后被质量校验判成"疑似未翻译"弹红框。
    // 例外：视觉模型给了 LaTeX 的（type=formula）要**生成卡片**——卡片里渲染真公式。
    const hasLatex = p => !!(p && p.visionLatex);
    const skippedFormula = paragraphs.filter(p => !isFigureLabelPara(p) && isFormulaLikePara(p) && !hasLatex(p));

    // 这些段落**连卡片都不生成**。
    // 否则第 6 页那类以表格为主的页面会变成一张满屏数字的"未翻译"卡片墙，
    // 而且它们本来就不该出现在对照翻译视图里。
    const skippedFigure = paragraphs.filter(isFigureLabelPara);
    const translatableParas = paragraphs.filter(
      p => !isFigureLabelPara(p) && (!isFormulaLikePara(p) || hasLatex(p))
    );

    if (translatableParas.length === 0) {
      dom.transListContainer.innerHTML = `
        <div class="empty-state">
          <p>本页主要是图表/表格与公式内容，没有可对照翻译的正文。</p>
        </div>`;
      return;
    }

    if (skippedFigure.length > 0 || skippedFormula.length > 0) {
      const notice = document.createElement('div');
      notice.className = 'trans-skip-summary';
      const parts = [];
      if (skippedFigure.length > 0) parts.push(`${skippedFigure.length} 段图表/表格内容`);
      if (skippedFormula.length > 0) parts.push(`${skippedFormula.length} 段公式/符号`);
      notice.textContent = `已跳过本页 ${parts.join('、')}（不做翻译）`;
      notice.title = [...skippedFigure, ...skippedFormula]
        .map(p => (p.cleanText || '').slice(0, 40))
        .slice(0, 12)
        .join('\n');
      dom.transListContainer.appendChild(notice);
    }

    translatableParas.forEach((para) => {
      const cacheKey = getParaCacheKey(pageNum, para);
      const cachedTrans = findCachedTranslation(pageNum, para);
      const cachedSentences = findCachedSentences(pageNum, para);

      const card = document.createElement('div');
      card.className = 'trans-card';
      card.id = `transCard_${pageNum}_${para.id}`;
      card.setAttribute('data-para-id', para.id);

      let metaLabel = '';
      if (para.type === 'body') {
        metaLabel = `<span class="para-index-tag">正文 第 ${para.bodyIndex || (para.id + 1)} 段</span>`;
      }
      const typeTag = typeBadgeMap[para.type] || '';

      card.innerHTML = `
        <div class="trans-card-header">
          <div class="para-meta">
            ${metaLabel}
            ${typeTag}
          </div>
          <div class="card-actions">
            <div class="view-mode-pill">
              <button class="btn-card-mode btn-mode-sentence active" title="逐句双语对照精读模式">逐句精读</button>
              <button class="btn-card-mode btn-mode-paragraph" title="连贯全文通读模式">连贯段落</button>
            </div>
            <button class="btn-card-action btn-locate" title="在左侧原件中居中定位">定位</button>
            <button class="btn-card-action btn-card-ai" title="针对此段向AI学术导师深度提问 (快捷键: Q)">问AI</button>
            <button class="btn-card-action btn-card-note" title="为此段落添加文献笔记">笔记</button>
            <button class="btn-card-action btn-copy-card-zh" title="复制中文译文（未翻译时自动翻译）">译文</button>
            <button class="btn-card-action btn-copy-card-en" title="复制英文原文">原文</button>
            <button class="btn-card-action btn-retranslate" title="使用大模型重新翻译此段"><span class="retrans-icon">↻</span> 重译</button>
          </div>
        </div>

        <!-- 混排段落（正文里夹公式）：额外给一条公式条，公式排版好看，正文照旧逐句精读。
             独立成块的公式（type=formula）走下面模式 A 的公式卡。 -->
        ${para.type !== 'formula' && hasLatex(para) ? renderCardFormulaHtml(para, true) : ''}

        <!-- 模式 A: 逐句双语精读对照模式 (默认推荐，精准对齐) -->
        <div class="trans-sentence-pairs" id="sentencePairs_${pageNum}_${para.id}">
          ${
            isFigureLabelPara(para)
              ? renderFigureLabelNoticeHtml(para)
              : para.type === 'formula' && hasLatex(para)
                ? renderCardFormulaHtml(para)
                : renderSentencePairsHtml(para, cachedTrans, cachedSentences)
          }
        </div>

        <!-- 模式 B: 连贯段落模式 (清晰区分英中双栏/双模块) -->
        <div class="trans-fluid-block" id="fluidBlock_${pageNum}_${para.id}" style="display: none;">
          <div class="fluid-section-panel fluid-panel-en">
            <div class="fluid-section-header">
              <div class="fluid-header-left">
                <span class="fluid-badge fluid-badge-en">EN</span>
                <span class="fluid-title">英文原文</span>
              </div>
              <div class="fluid-header-tools">
                <button class="btn-mini-tool btn-fluid-copy-en" title="复制英文原文">复制</button>
                <button class="btn-mini-tool btn-fluid-locate" title="在原件中定位此段">定位</button>
              </div>
            </div>
            <div class="trans-original" title="点击句子可单独在原件聚焦此句">${formatOriginalParagraph(para)}</div>
          </div>

          <div class="fluid-section-panel fluid-panel-zh">
            <div class="fluid-section-header">
              <div class="fluid-header-left">
                <span class="fluid-badge fluid-badge-zh">CN</span>
                <span class="fluid-title">中文学术精译</span>
              </div>
              <div class="fluid-header-tools">
                <button class="btn-mini-tool btn-fluid-copy-zh" title="复制中文译文">复制</button>
                <button class="btn-mini-tool btn-fluid-retrans" title="使用大模型重新翻译此段"><span class="retrans-icon">↻</span> 重译</button>
              </div>
            </div>
            <div class="trans-translated" id="transText_${pageNum}_${para.id}" title="点击任意中文句子可在原件精准聚焦对应英文原句">
              ${
                isFigureLabelPara(para)
                  ? `<div class="trans-skip-note">图表内部标签，未翻译</div>`
                  : cachedTrans
                    ? formatTranslatedParagraph(cachedTrans, para)
                    : `
                <div class="trans-skeleton-box active-loading">
                  <div class="skeleton-shimmer-line text-line"></div>
                  <div class="skeleton-shimmer-line text-line short"></div>
                  <div class="skeleton-shimmer-tip"><span class="mini-spinner spinning"></span> 正在翻译...</div>
                </div>`
              }
            </div>
          </div>
        </div>
      `;

      // 绑定视图模式切换
      const btnModeSentence = card.querySelector('.btn-mode-sentence');
      const btnModeParagraph = card.querySelector('.btn-mode-paragraph');
      const sentencePairsView = card.querySelector('.trans-sentence-pairs');
      const fluidBlockView = card.querySelector('.trans-fluid-block');

      btnModeSentence.addEventListener('click', (e) => {
        e.stopPropagation();
        btnModeSentence.classList.add('active');
        btnModeParagraph.classList.remove('active');
        sentencePairsView.style.display = 'flex';
        fluidBlockView.style.display = 'none';
      });

      btnModeParagraph.addEventListener('click', (e) => {
        e.stopPropagation();
        btnModeParagraph.classList.add('active');
        btnModeSentence.classList.remove('active');
        sentencePairsView.style.display = 'none';
        fluidBlockView.style.display = 'flex';
      });

      // 逐句精读行点击事件委托：点击任意句对（无论点中文还是英文），100% 精准高亮对应英文句！
      sentencePairsView.addEventListener('click', (e) => {
        const btnRowAi = e.target.closest('.btn-row-ai');
        if (btnRowAi) {
          e.stopPropagation();
          const sentIdx = parseInt(btnRowAi.getAttribute('data-sent-idx'), 10);
          highlightCard(card);
          try {
            focusParagraphOnPdf(para, sentIdx);
          } catch (err) {
            console.warn('[Viewer] focusParagraphOnPdf failed:', err);
          }
          const sentText = (para.sentencesEn && para.sentencesEn[sentIdx]) ? para.sentencesEn[sentIdx].text : para.cleanText;
          openAiAssistantModal({
            selectedText: sentText,
            contextText: para.cleanText,
            page: currentPage,
            presetQuestion: `请结合论文上下文，深度剖析并解答此句的核心学术含义、技术动机与研究背景：\n"${sentText}"`,
          });
          return;
        }

        const btnNote = e.target.closest('.btn-row-note');
        if (btnNote) {
          e.stopPropagation();
          const sentIdx = parseInt(btnNote.getAttribute('data-sent-idx'), 10);
          highlightCard(card);
          focusParagraphOnPdf(para, sentIdx);
          const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
          const rects = getSentenceHighlightRects(para, sentIdx, pageWrapper);
          const sentText = (para.sentencesEn && para.sentencesEn[sentIdx]) ? para.sentencesEn[sentIdx].text : para.cleanText;
          openAnnotationPopover({
            text: sentText,
            page: currentPage,
            rects: rects,
            paraId: para.id,
            anchorRect: btnNote.getBoundingClientRect()
          });
          return;
        }

        const row = e.target.closest('.sentence-pair-row');
        if (!row) {
          highlightCard(card);
          focusParagraphOnPdf(para);
          return;
        }

        e.stopPropagation();
        highlightCard(card);
        const sentIdx = parseInt(row.getAttribute('data-sent-idx'), 10);

        // 激活当前行视觉样式
        card.querySelectorAll('.sentence-pair-row').forEach(r => r.classList.remove('active-sentence-row'));
        row.classList.add('active-sentence-row');

        // 在 PDF 原件上精准绘制该句高光
        focusParagraphOnPdf(para, sentIdx);
      });

      // 连贯段落视图点击事件：点击中文或英文句子，双向 100% 精准联动对应原文与高亮！
      fluidBlockView.addEventListener('click', (e) => {
        const enSpan = e.target.closest('.en-sentence');
        const zhSpan = e.target.closest('.zh-sentence');
        highlightCard(card);
        const targetSpan = enSpan || zhSpan;
        if (targetSpan) {
          e.stopPropagation();
          const sentIdx = parseInt(targetSpan.getAttribute('data-sent-idx'), 10);
          card.querySelectorAll('.en-sentence, .zh-sentence').forEach(s => s.classList.remove('sentence-matched'));
          targetSpan.classList.add('sentence-matched');
          const twin = enSpan
            ? card.querySelector(`.zh-sentence[data-sent-idx="${sentIdx}"]`)
            : card.querySelector(`.en-sentence[data-sent-idx="${sentIdx}"]`);
          if (twin) twin.classList.add('sentence-matched');

          focusParagraphOnPdf(para, sentIdx);
        } else {
          focusParagraphOnPdf(para);
        }
      });

      // 卡片通用定位按钮
      card.querySelector('.btn-locate').addEventListener('click', (e) => {
        e.stopPropagation();
        highlightCard(card);
        focusParagraphOnPdf(para);
      });

      const btnCardNote = card.querySelector('.btn-card-note');
      if (btnCardNote) {
        btnCardNote.addEventListener('click', (e) => {
          e.stopPropagation();
          highlightCard(card);
          focusParagraphOnPdf(para);
          const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
          const rects = getParagraphHighlightRects(para, pageWrapper);
          openAnnotationPopover({
            text: para.cleanText,
            page: currentPage,
            rects: rects,
            paraId: para.id,
            anchorRect: btnCardNote.getBoundingClientRect()
          });
        });
      }

      // 复制英文原文通用函数
      const copyEnFn = (btn) => {
        navigator.clipboard.writeText(para.cleanText);
        const origText = btn.innerHTML;
        btn.innerHTML = '✅ 已复制';
        btn.classList.add('btn-copied-success');
        setTimeout(() => {
          btn.innerHTML = origText;
          btn.classList.remove('btn-copied-success');
        }, 1800);
        vscode.postMessage({ type: 'showInfo', message: `已复制第 ${para.bodyIndex || (para.id + 1)} 段英文原文到剪贴板` });
      };

      // 复制中文译文 / 快速查看或触发翻译
      const copyZhFn = (btn) => {
        const curTrans = findCachedTranslation(pageNum, para);
        if (curTrans && !curTrans.startsWith('[翻译出错') && !curTrans.startsWith('[暂无网络')) {
          navigator.clipboard.writeText(curTrans);
          const origText = btn.innerHTML;
          btn.innerHTML = '✅ 已复制';
          btn.classList.add('btn-copied-success');
          setTimeout(() => {
            btn.innerHTML = origText;
            btn.classList.remove('btn-copied-success');
          }, 1800);
          vscode.postMessage({ type: 'showInfo', message: `已复制第 ${para.bodyIndex || (para.id + 1)} 段中文译文到剪贴板` });

          // 连贯段落模式下，平滑滚动至译文并微光闪烁提示
          const transEl = document.getElementById(`transText_${pageNum}_${para.id}`);
          if (transEl) {
            transEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            transEl.classList.add('trans-flash-highlight');
            setTimeout(() => transEl.classList.remove('trans-flash-highlight'), 1200);
          }
        } else {
          // 尚未翻译或翻译错误：自动发起翻译并给用户反馈
          triggerParagraphTranslate(pageNum, para, false);
          vscode.postMessage({ type: 'showInfo', message: `正在为您请求翻译第 ${para.bodyIndex || (para.id + 1)} 段，请稍候...` });
          const transEl = document.getElementById(`transText_${pageNum}_${para.id}`);
          if (transEl) {
            transEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      };

      // 重新翻译处理
      const retransFn = (btn) => {
        card.querySelectorAll('.btn-retranslate, .btn-fluid-retrans').forEach(b => {
          b.classList.add('is-loading');
          b.disabled = true;
          const icon = b.querySelector('.retrans-icon') || b;
          icon.classList.add('spinning');
        });

        vscode.postMessage({
          type: 'showInfo',
          message: `正在使用大模型重新翻译第 ${para.bodyIndex || (para.id + 1)} 段，请稍候...`
        });

        triggerParagraphTranslate(pageNum, para, true);

        const transEl = document.getElementById(`transText_${pageNum}_${para.id}`);
        if (transEl) {
          transEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      };

      // 绑定头部按钮
      const btnAi = card.querySelector('.btn-card-ai');
      if (btnAi) {
        btnAi.addEventListener('click', (e) => {
          e.stopPropagation();
          openAiAssistantModal({
            selectedText: para.cleanText.slice(0, 240),
            contextText: para.cleanText,
            page: pageNum,
            presetQuestion: '请结合论文全文上下文，深度剖析本段落的核心论点、技术动机与研究逻辑。',
          });
        });
      }

      const btnCopyZh = card.querySelector('.btn-copy-card-zh');
      if (btnCopyZh) btnCopyZh.addEventListener('click', (e) => { e.stopPropagation(); copyZhFn(btnCopyZh); });

      const btnCopyEn = card.querySelector('.btn-copy-card-en');
      if (btnCopyEn) btnCopyEn.addEventListener('click', (e) => { e.stopPropagation(); copyEnFn(btnCopyEn); });

      const btnRetrans = card.querySelector('.btn-retranslate');
      if (btnRetrans) btnRetrans.addEventListener('click', (e) => { e.stopPropagation(); retransFn(btnRetrans); });

      // 绑定内联按钮
      const btnFluidCopyEn = card.querySelector('.btn-fluid-copy-en');
      if (btnFluidCopyEn) btnFluidCopyEn.addEventListener('click', (e) => { e.stopPropagation(); copyEnFn(btnFluidCopyEn); });

      const btnFluidLocate = card.querySelector('.btn-fluid-locate');
      if (btnFluidLocate) btnFluidLocate.addEventListener('click', (e) => {
        e.stopPropagation();
        highlightCard(card);
        focusParagraphOnPdf(para);
      });

      const btnFluidCopyZh = card.querySelector('.btn-fluid-copy-zh');
      if (btnFluidCopyZh) btnFluidCopyZh.addEventListener('click', (e) => { e.stopPropagation(); copyZhFn(btnFluidCopyZh); });

      const btnFluidRetrans = card.querySelector('.btn-fluid-retrans');
      if (btnFluidRetrans) btnFluidRetrans.addEventListener('click', (e) => { e.stopPropagation(); retransFn(btnFluidRetrans); });

      // 绑定卡片内重试按钮委托
      card.addEventListener('click', (e) => {
        const retryBtn = e.target.closest('.btn-retry-trans');
        if (retryBtn) {
          e.stopPropagation();
          retransFn(retryBtn);
        }
      });

      dom.transListContainer.appendChild(card);
    });

    // 智能并发平滑翻译队列
    // 这里放 6 路是为了让扩展侧有机会把请求合并成一次 API 调用
    // （免费档 Key 的瓶颈是每分钟请求数，逐段发必然 429，越翻越慢）。
    // 扩展侧仍有自己的并发闸门，真正同时打 API 的次数受 academicReader.translateConcurrency 控制。
    const unCachedParas = paragraphs.filter(
      // 图表标签、页眉页脚与**独立公式块**都不进翻译队列：送过去只会拿回原文残渣
      p => !findCachedTranslation(pageNum, p) && !isUntranslatablePara(p) && !isFormulaLikePara(p)
    );
    let qIdx = 0;
    let activeWorkers = 0;
    let lastQueueProgressAt = Date.now();
    const MAX_CONCURRENT = 6;

    window._academicTransNext = function() {
      lastQueueProgressAt = Date.now();
      activeWorkers = Math.max(0, activeWorkers - 1);
      while (activeWorkers < MAX_CONCURRENT && qIdx < unCachedParas.length) {
        const nextP = unCachedParas[qIdx++];
        activeWorkers++;
        triggerParagraphTranslate(pageNum, nextP);
      }
    };

    // 启动初始并发 (2 路)
    while (activeWorkers < MAX_CONCURRENT && qIdx < unCachedParas.length) {
      const nextP = unCachedParas[qIdx++];
      activeWorkers++;
      triggerParagraphTranslate(pageNum, nextP);
    }

    // 防卡死看门狗（已修复）：
    // 旧版每 8 秒无条件把 activeWorkers 清零再放 2 路请求，等于废掉 MAX_CONCURRENT 上限——
    // 池里旧请求还在飞，于是同一批段落被反复重复请求（重复计费），UI 上呈现"假进度"。
    // 现在只在"确实长时间毫无进展"时释放 1 个槽位，绝不清零。
    if (window._academicQueueWatchdog) clearInterval(window._academicQueueWatchdog);
    window._academicQueueWatchdog = setInterval(() => {
      if (qIdx >= unCachedParas.length && activeWorkers <= 0) {
        clearInterval(window._academicQueueWatchdog);
        window._academicQueueWatchdog = null;
        return;
      }
      if (qIdx >= unCachedParas.length) return;
      if (Date.now() - lastQueueProgressAt < 45000) return; // 45 秒内有过进展就不干预
      lastQueueProgressAt = Date.now();
      activeWorkers = Math.max(0, activeWorkers - 1);
      if (typeof window._academicTransNext === 'function') window._academicTransNext();
    }, 15000);

    if (currentRightView === 'article') {
      renderArticleFlow(pageNum, paragraphs);
    }
  }

  // ====================== 沉浸式全文对照流排版 (Nature/Web 级排版) ======================
  function renderArticleFlow(pageNum, paragraphs) {
    if (!dom.articleFlowContainer) return;
    dom.articleFlowContainer.innerHTML = '';

    if (!paragraphs || paragraphs.length === 0) {
      dom.articleFlowContainer.innerHTML = `
        <div class="empty-state">
          <p>当前页面没有可提取的正文段落。</p>
        </div>`;
      return;
    }

    const typeBadgeMap = {
      title: '论文标题',
      abstract: '摘要',
      keywords: '关键词',
      significance: '研究意义',
      heading: '章节',
      caption: '图表说明',
      metadata: '元信息',
      body: '正文'
    };

    paragraphs.forEach((para, idx) => {
      const cachedTrans = findCachedTranslation(pageNum, para);

      const section = document.createElement('div');
      section.className = 'article-section-card';

      section.innerHTML = `
        <div class="article-section-header">
          <span class="article-section-tag">${typeBadgeMap[para.type] || `段落 #${idx + 1}`}</span>
          <div class="card-actions">
            <button class="btn-card-action btn-locate-flow" title="在左侧原件中居中定位">定位</button>
            <button class="btn-card-action btn-copy-flow-en" title="复制英文">原文</button>
            <button class="btn-card-action btn-copy-flow-zh" title="复制中文">译文</button>
          </div>
        </div>
        <div class="article-section-en">${renderEnTextHtml(para.cleanText, para.visionInline)}</div>
        <div class="article-section-zh" id="flowTrans_${pageNum}_${para.id}">
          ${cachedTrans ? escapeHtml(cachedTrans) : `<span class="trans-loading"><span class="mini-spinner"></span> 正在请求翻译...</span>`}
        </div>
      `;

      section.querySelector('.btn-locate-flow').addEventListener('click', () => {
        focusParagraphOnPdf(para);
      });

      section.querySelector('.btn-copy-flow-en').addEventListener('click', () => {
        navigator.clipboard.writeText(para.cleanText);
        vscode.postMessage({ type: 'showInfo', message: '已复制英文原文到剪贴板' });
      });

      section.querySelector('.btn-copy-flow-zh').addEventListener('click', () => {
        const curTrans = findCachedTranslation(pageNum, para);
        if (curTrans) {
          navigator.clipboard.writeText(curTrans);
          vscode.postMessage({ type: 'showInfo', message: '已复制中文译文到剪贴板' });
        }
      });

      dom.articleFlowContainer.appendChild(section);
    });
  }

  function formatOriginalParagraph(para) {
    if (!para.sentencesEn || para.sentencesEn.length === 0) {
      return renderEnTextHtml(para.cleanText, para.visionInline);
    }
    return para.sentencesEn
      .map(
        (s, idx) =>
          `<span class="en-sentence" data-sent-idx="${idx}" title="点击在原件中单独高亮此句">${renderEnTextHtml(
            s.text,
            para.visionInline
          )}</span>`
      )
      .join(' ');
  }

  function formatTranslatedParagraph(transText, para) {
    if (!transText) return '';

    const pageNum = currentPage;
    const cacheKey = getParaCacheKey(pageNum, para);
    const cached =
      (paperData.sentenceTranslations && paperData.sentenceTranslations[cacheKey]) || para.sentenceTranslations;
    const enSentences = para.sentencesEn || [];
    const aligned =
      Array.isArray(cached) &&
      enSentences.length > 0 &&
      cached.length === enSentences.length &&
      !cached.some(s => !s || !s.trim());

    // 只有真的逐句对齐了，才把中文切成可点击的句子。
    // 否则只渲染整段译文——不再用中文标点猜切分，然后让「点中文跳英文」跳到错误的句子。
    // 【译文也要走公式渲染】译文里的公式现在是 $...$ LaTeX（提示词要求模型转写），
    // 残渣形式的老译文则靠视觉模型的替换表就地补渲染——两条路都通到 KaTeX。
    if (!aligned) {
      return `<div class="zh-paragraph-plain">${renderEnTextHtml(transText, para.visionInline)}</div>`;
    }

    return cached
      .map(
        (s, idx) =>
          `<span class="zh-sentence" data-sent-idx="${idx}" title="点击在原件中单独高亮此句">${renderEnTextHtml(
            s,
            para.visionInline
          )}</span>`
      )
      .join(' ');
  }

  function triggerParagraphTranslate(pageNum, para, force = false) {
    if (!para) return;

    // 图表内部标签不翻译（手动点"重译"也一样）：模型只会把符号原样返回
    if (para.type === 'figure-label') {
      const pairsEl = document.getElementById(`sentencePairs_${pageNum}_${para.id}`);
      if (pairsEl) pairsEl.innerHTML = renderFigureLabelNoticeHtml(para);
      const textEl = document.getElementById(`transText_${pageNum}_${para.id}`);
      if (textEl) textEl.innerHTML = `<div class="trans-skip-note">图表内部标签，未翻译</div>`;
      if (typeof window._academicTransNext === 'function') window._academicTransNext();
      return;
    }

    const cacheKey = getParaCacheKey(pageNum, para);

    if (force) {
      // 只按内容指纹清除（旧版用「前 28 字符前缀」清理，会误删别的段落缓存）
      delete paperData.translations[cacheKey];
      if (paperData.sentenceTranslations) delete paperData.sentenceTranslations[cacheKey];
      if (paperData.alignment) delete paperData.alignment[cacheKey];
      para.translation = '';
      para.sentenceTranslations = [];
      para.alignmentNote = '';
    }

    const pairsEl = document.getElementById(`sentencePairs_${pageNum}_${para.id}`);
    if (pairsEl) {
      pairsEl.innerHTML = `
        <div class="trans-skeleton-box active-loading">
          <div class="skeleton-shimmer-line title-line"></div>
          <div class="skeleton-shimmer-line text-line"></div>
          <div class="skeleton-shimmer-line text-line short"></div>
          <div class="skeleton-shimmer-tip"><span class="mini-spinner spinning"></span> 正在翻译...</div>
        </div>`;
    }

    const textEl = document.getElementById(`transText_${pageNum}_${para.id}`);
    if (textEl) {
      textEl.innerHTML = `
        <div class="trans-skeleton-box active-loading">
          <div class="skeleton-shimmer-line text-line"></div>
          <div class="skeleton-shimmer-line text-line short"></div>
          <div class="skeleton-shimmer-tip"><span class="mini-spinner spinning"></span> 正在翻译...</div>
        </div>`;
    }

    const sentences = para.sentencesEn ? para.sentencesEn.map(s => s.text) : [];

    vscode.postMessage({
      type: 'requestTranslate',
      page: pageNum,
      paraIndex: para.id,
      cacheKey: cacheKey,
      text: para.cleanText,
      sentences: sentences
    });
  }

  function handleTranslateResult(msg) {
    try {
      const {
        page,
        paraIndex,
        cacheKey,
        translated,
        sentenceTranslations,
        isError,
        errorText,
        aligned,
        mode,
        note,
        model
      } = msg;
      // 防串段护栏：翻译在途时若用户翻页/缩放，currentParagraphs 已换成新页，
      // 同一个 paraIndex 可能落到"另一个段落"上。用内容指纹核对，核对不上就不动 DOM、不写真状态。
      const candidate = currentParagraphs.find(p => p.id === paraIndex);
      const para =
        candidate && (!cacheKey || getParaCacheKey(page, candidate) === cacheKey) ? candidate : null;
      const key = cacheKey || (para ? getParaCacheKey(page, para) : `${page}_${paraIndex}`);

      // 只写内容指纹键。旧版同时写 `${page}_${paraIndex}`，段落切分一变就会指向别的段落。
      if (translated) paperData.translations[key] = translated;
      if (sentenceTranslations && sentenceTranslations.length > 0) {
        paperData.sentenceTranslations = paperData.sentenceTranslations || {};
        paperData.sentenceTranslations[key] = sentenceTranslations;
      }
      // 归档快照同步回填，否则导出精读稿时这些段落会显示"未翻译"。
      // 带上回包的内容指纹：手术重新编号后，在途回包不能落到身份已经变了的同一编号上。
      updateArchivedParagraph(page, paraIndex, { translation: translated, sentenceTranslations }, cacheKey);
      paperData.alignment = paperData.alignment || {};
      paperData.alignment[key] = { aligned: !!aligned, mode: mode || '', note: note || '', model: model || '' };

      // 恢复对应卡片上所有重译按钮的旋转与禁用状态
      const card = document.getElementById(`transCard_${page}_${paraIndex}`);
      if (card) {
        card.querySelectorAll('.btn-retranslate, .btn-fluid-retrans').forEach(b => {
          b.classList.remove('is-loading');
          b.disabled = false;
          const icon = b.querySelector('.retrans-icon') || b;
          icon.classList.remove('spinning');
        });
      }

      if (!para) return;

      if (isError || !translated) {
        const errorHtml = `
          <div class="trans-error-box">
            <div class="error-msg">⚠️ 学术翻译未完成：${escapeHtml(
              errorText || '服务不可用，请检查 API Key 与网络'
            )}</div>
            <button class="btn-retry-trans" data-para-id="${para.id}">点击重试</button>
          </div>`;

        const pairsEl = document.getElementById(`sentencePairs_${page}_${paraIndex}`);
        if (pairsEl) pairsEl.innerHTML = errorHtml;

        const textEl = document.getElementById(`transText_${page}_${paraIndex}`);
        if (textEl) textEl.innerHTML = errorHtml;
        return;
      }

      para.alignmentNote = note || '';

      // 更新逐句精读视图（未对齐时如实展示整段译文，不再伪造句对）
      const pairsEl = document.getElementById(`sentencePairs_${page}_${paraIndex}`);
      if (pairsEl) {
        pairsEl.innerHTML = renderSentencePairsHtml(para, translated, sentenceTranslations);
        pairsEl.classList.add('trans-flash-highlight');
        setTimeout(() => pairsEl.classList.remove('trans-flash-highlight'), 1200);
      }

      // 更新连贯段落视图 (保持句子可点击高亮标记)
      const textEl = document.getElementById(`transText_${page}_${paraIndex}`);
      if (textEl) {
        textEl.innerHTML = formatTranslatedParagraph(translated, para);
        textEl.classList.add('trans-flash-highlight');
        setTimeout(() => textEl.classList.remove('trans-flash-highlight'), 1200);
      }

      const flowEl = document.getElementById(`flowTrans_${page}_${paraIndex}`);
      if (flowEl) {
        flowEl.textContent = translated;
      }

      // 若当前高亮的是该段落，同步更新底部速照栏
      if (activeFocusPara && activeFocusPara.id === paraIndex && page === currentPage) {
        updateDockedInspector(activeFocusPara, activeFocusSentIdx);
      }
    } finally {
      // 推进平滑翻译队列 (无论失败还是提前返回，必须调用以保证后续段落继续翻译)
      if (typeof window._academicTransNext === 'function') {
        window._academicTransNext();
      }
    }
  }

  function handlePageStructureResult(msg) {
    if (msg.page !== currentPage) return;
    const { paragraphs } = msg;
    if (!paragraphs || paragraphs.length === 0) return;

    paragraphs.forEach((p, idx) => {
      if (p.translation && currentParagraphs[idx]) {
        currentParagraphs[idx].translation = p.translation;
        const cacheKey = getParaCacheKey(msg.page, currentParagraphs[idx]);
        paperData.translations[cacheKey] = p.translation;
        // 同一段落可能已经被归档过（先渲染后解析），这里补上译文
        updateArchivedParagraph(msg.page, currentParagraphs[idx].id, { translation: p.translation }, cacheKey);
        const textEl = document.getElementById(`transText_${msg.page}_${currentParagraphs[idx].id}`);
        if (textEl) {
          textEl.innerHTML = formatTranslatedParagraph(p.translation, currentParagraphs[idx]);
        }
        const pairsEl = document.getElementById(`sentencePairs_${msg.page}_${currentParagraphs[idx].id}`);
        if (pairsEl) {
          pairsEl.innerHTML = renderSentencePairsHtml(currentParagraphs[idx], p.translation, null);
        }
      }
    });

    if (activeFocusPara && msg.page === currentPage) {
      updateDockedInspector(activeFocusPara, activeFocusSentIdx);
    }
  }


  // ====================== 核心：鼠标划词 & 句子级高光双向联动 ======================
  let currentNoteContext = null;
  let selectionDebounceTimer = null;
  let isPointerSelecting = false;

  function bindSelectionEvents() {
    window.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        isPointerSelecting = true;
      } else if (e.button === 2) {
        const sel = window.getSelection();
        if (sel && sel.toString().trim().length > 0) {
          // 保留选区
        }
      }
    }, true);

    const triggerSelection = (e) => {
      isPointerSelecting = false;
      clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = setTimeout(() => handleTextSelection(e), 20);
    };

    window.addEventListener('mouseup', triggerSelection);
    document.addEventListener('mouseup', triggerSelection);
    document.addEventListener('selectionchange', () => {
      if (isPointerSelecting) return;
      clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = setTimeout(() => handleTextSelection(), 80);
    });

    // 全局 capture 阶段捕获 contextmenu，确保 100% 触发我们的学术右键菜单
    window.addEventListener('contextmenu', handlePdfContextMenu, true);
    document.addEventListener('contextmenu', handlePdfContextMenu, true);

    if (dom.pdfPane) {
      dom.pdfPane.addEventListener('mouseup', triggerSelection);
    }
    if (dom.pdfViewerContainer) {
      dom.pdfViewerContainer.addEventListener('mouseup', triggerSelection);
      dom.pdfViewerContainer.addEventListener('scroll', () => {
        hideContextMenu();
        hideSelectionToolbar();
      }, { passive: true });
    }

    // 防止点击悬浮浮条或右键菜单时丢失选区
    if (dom.selectionToolbar) {
      dom.selectionToolbar.addEventListener('mousedown', (e) => e.preventDefault());
    }
    if (dom.pdfContextMenu) {
      dom.pdfContextMenu.addEventListener('mousedown', (e) => e.preventDefault());
    }
  }
  bindSelectionEvents();

  function handleTextSelection(e) {
    if (
      (dom.selectionToolbar && e && e.target && dom.selectionToolbar.contains(e.target)) ||
      (dom.annotationPopover && e && e.target && dom.annotationPopover.contains(e.target)) ||
      (dom.noteHoverTooltip && e && e.target && dom.noteHoverTooltip.contains(e.target)) ||
      (dom.pdfContextMenu && e && e.target && dom.pdfContextMenu.contains(e.target)) ||
      (dom.quickTranslatePopover && e && e.target && dom.quickTranslatePopover.contains(e.target)) ||
      (dom.noteModal && e && e.target && dom.noteModal.contains(e.target)) ||
      (dom.instantTranslateCard && e && e.target && dom.instantTranslateCard.contains(e.target)) ||
      (dom.dockedInspector && e && e.target && dom.dockedInspector.contains(e.target))
    ) {
      return;
    }

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';

    if (!selectedText || selection.rangeCount === 0) {
      hideSelectionToolbar();
      clearSentenceHighlights();
      return;
    }

    const range = selection.getRangeAt(0);

    // 检查选区是否在左侧 PDF 面板或右侧翻译面板中
    let inPdf = false;
    let inRight = false;
    try {
      const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
      const endEl = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
      inPdf = !!(
        (dom.pdfPane && (dom.pdfPane.contains(startEl) || dom.pdfPane.contains(endEl))) ||
        (dom.pdfViewerContainer && (dom.pdfViewerContainer.contains(startEl) || dom.pdfViewerContainer.contains(endEl)))
      );
      inRight = !!(dom.rightPane && (dom.rightPane.contains(startEl) || dom.rightPane.contains(endEl)));
    } catch (err) {
      inPdf = true;
    }

    if (!inPdf && !inRight) {
      hideSelectionToolbar();
      clearSentenceHighlights();
      return;
    }

    // 联合包围盒计算：解决跨 span 时 range.getBoundingClientRect() 宽高异常
    const rectList = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    let bounding = null;
    if (rectList.length > 0) {
      const minLeft = Math.min(...rectList.map(r => r.left));
      const maxRight = Math.max(...rectList.map(r => r.right));
      const minTop = Math.min(...rectList.map(r => r.top));
      const maxBottom = Math.max(...rectList.map(r => r.bottom));
      bounding = {
        left: minLeft,
        top: minTop,
        right: maxRight,
        bottom: maxBottom,
        width: maxRight - minLeft,
        height: maxBottom - minTop
      };
    } else {
      bounding = range.getBoundingClientRect();
    }

    if (!bounding || bounding.width === 0) {
      bounding = {
        left: (e && e.clientX) ? e.clientX - 60 : 100,
        top: (e && e.clientY) ? e.clientY - 25 : 100,
        width: 120,
        height: 24,
        right: (e && e.clientX) ? e.clientX + 60 : 220,
        bottom: (e && e.clientY) ? e.clientY : 124
      };
    }

    // 自动清洗连字符与换行
    const cleanQuery = selectedText.replace(/(\w+)-\s*\n\s*(\w+)/g, '$1$2').replace(/\s+/g, ' ');

    const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
    const parentRect = pageWrapper ? pageWrapper.getBoundingClientRect() : { left: 0, top: 0 };
    const rawRects = inPdf ? rectList.map(r => ({
      left: Math.round(r.left - parentRect.left),
      top: Math.round(r.top - parentRect.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
    })) : [];

    currentSelectionInfo = {
      text: cleanQuery,
      page: currentPage,
      range: range,
      rawRects: rawRects,
      bounding: bounding,
      inRight: inRight
    };

    // 核心：优先立即弹出悬浮工具条 (避免任何后续逻辑异常影响工具条显示)
    showSelectionToolbar(bounding);

    // 辅助联动 (句子定位)，以 try-catch 保护
    try {
      if (inPdf) {
        alignRightSentenceHighlight(range, cleanQuery);
      }
    } catch (err) {
      console.warn('Selection auxiliary action notice:', err);
    }
  }

  function alignRightSentenceHighlight(range, selectedText) {
    clearSentenceHighlights();

    let matchedPara = null;

    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement;
    }
    const paraSpan = node.closest('[data-para-id]');
    if (paraSpan) {
      const pId = parseInt(paraSpan.getAttribute('data-para-id'), 10);
      matchedPara = currentParagraphs.find((p) => p.id === pId);
    }

    if (!matchedPara && currentParagraphs.length > 0) {
      const normSelected = selectedText.replace(/\W+/g, '').toLowerCase().slice(0, 35);
      matchedPara = currentParagraphs.find((p) => (p.cleanText || '').replace(/\W+/g, '').toLowerCase().includes(normSelected));
      if (!matchedPara) {
        let maxOverlap = 0;
        currentParagraphs.forEach((p) => {
          const score = getOverlapScore(selectedText, p.cleanText || '');
          if (score > maxOverlap) {
            maxOverlap = score;
            matchedPara = p;
          }
        });
      }
    }

    if (!matchedPara) return;

    // 高亮右侧卡片
    const card = document.getElementById(`transCard_${currentPage}_${matchedPara.id}`);
    if (card) {
      highlightCard(card);
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      // 句子级精准匹配：右侧对应中文亮起醒目荧光黄
      if (matchedPara.sentencesEn && matchedPara.sentencesEn.length > 0) {
        let bestSentenceIdx = 0;
        let maxOverlap = 0;

        matchedPara.sentencesEn.forEach((enSent, idx) => {
          const sentText = typeof enSent === 'string' ? enSent : (enSent ? enSent.text : '');
          const overlap = getOverlapScore(selectedText, sentText);
          if (overlap > maxOverlap) {
            maxOverlap = overlap;
            bestSentenceIdx = idx;
          }
        });

        const zhSpans = card.querySelectorAll('.zh-sentence');
        if (zhSpans.length > 0) {
          const targetZhIdx = Math.min(
            zhSpans.length - 1,
            Math.round((bestSentenceIdx / Math.max(1, matchedPara.sentencesEn.length - 1)) * (zhSpans.length - 1))
          );
          if (zhSpans[targetZhIdx]) {
            zhSpans[targetZhIdx].classList.add('sentence-matched');
          }
        }
      }
    }
  }

  function getOverlapScore(strA, strB) {
    if (!strA || !strB) return 0;
    const a = typeof strA === 'string' ? strA : (strA.text || '');
    const b = typeof strB === 'string' ? strB : (strB.text || '');
    const wordsA = a.toLowerCase().split(/\W+/).filter(Boolean);
    const wordsB = b.toLowerCase().split(/\W+/).filter(Boolean);
    let count = 0;
    wordsA.forEach((w) => {
      if (wordsB.includes(w)) count++;
    });
    return count;
  }

  function clearSentenceHighlights() {
    document.querySelectorAll('.sentence-matched').forEach((el) => {
      el.classList.remove('sentence-matched');
    });
  }

  function highlightCard(card) {
    if (activeHighlightCard && activeHighlightCard !== card) {
      activeHighlightCard.classList.remove('highlight-active');
    }
    card.classList.add('highlight-active');
    activeHighlightCard = card;
  }

  // ====================== 划词悬浮菜单与即时翻译 ======================
  function showSelectionToolbar(bounding) {
    hideParaFocusBar();
    if (!dom.selectionToolbar) {
      dom.selectionToolbar = document.getElementById('selectionToolbar');
    }
    const bar = dom.selectionToolbar;
    if (!bar) return;

    bar.style.display = 'flex';
    bar.style.visibility = 'visible';
    bar.style.opacity = '1';
    bar.style.pointerEvents = 'auto';

    document.querySelectorAll('.color-dot').forEach((dot) => {
      dot.classList.toggle('active', dot.getAttribute('data-color') === selectedHighlightColor);
    });

    const barW = bar.offsetWidth || 340;
    const barH = bar.offsetHeight || 38;

    let left = bounding.left + bounding.width / 2 - barW / 2;
    let top = bounding.top - barH - 10;

    // 距顶部太近时（顶栏高度46px），翻转显示在选区文字下方
    if (top < 52) {
      top = bounding.bottom + 10;
    }

    // 视口边界碰撞防护
    left = Math.max(10, Math.min(window.innerWidth - barW - 16, left));
    top = Math.max(10, Math.min(window.innerHeight - barH - 10, top));

    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  function hideSelectionToolbar() {
    if (dom.selectionToolbar) {
      dom.selectionToolbar.style.display = 'none';
    }
  }

  // ====================== 自定义学术 PDF 右键快捷上下文菜单 ======================
  function handlePdfContextMenu(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      return; // 允许输入框使用原生菜单
    }

    e.preventDefault();
    e.stopPropagation();

    if (dom.pdfContextMenu && dom.pdfContextMenu.contains(e.target)) {
      return;
    }

    let node = e.target;
    let hasText = false;
    let hasAnnot = false;
    activeContextAnnot = null;

    // 1. 优先检测是否右击在已有的高亮或批注徽章上
    let annotEl = node ? (node.closest('.note-pin-badge') || node.closest('.highlight-mark')) : null;
    if (annotEl) {
      const annotId = annotEl.getAttribute('data-annot-id') || (annotEl.id ? annotEl.id.replace('noteCard_', '') : null);
      if (annotId) {
        activeContextAnnot = paperData.annotations.find(a => a.id === annotId);
      }
      if (activeContextAnnot) {
        hasAnnot = true;
      }
    }

    const selection = window.getSelection();
    const selText = selection ? selection.toString().trim() : '';

    if (selText && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const cleanText = selText.replace(/(\w+)-\s*\n\s*(\w+)/g, '$1$2').replace(/\s+/g, ' ');

      const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
      const parentRect = pageWrapper ? pageWrapper.getBoundingClientRect() : { left: 0, top: 0 };
      const clientRects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      const rawRects = clientRects.map(r => ({
        left: Math.round(r.left - parentRect.left),
        top: Math.round(r.top - parentRect.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }));

      currentSelectionInfo = {
        text: cleanText,
        page: currentPage,
        range: range,
        rawRects: rawRects,
        bounding: range.getBoundingClientRect()
      };
      hasText = true;
      if (dom.ctxBtnAddNoteLabel) dom.ctxBtnAddNoteLabel.textContent = '添加批注便签';
      alignRightSentenceHighlight(range, cleanText);
    } else if (!hasAnnot) {
      // 2. 检查右栏中的点击 (卡片或逐句行)
      const inRight = dom.rightPane && dom.rightPane.contains(node);
      if (inRight) {
        const sentRow = node.closest('.sentence-pair-row');
        if (sentRow) {
          const sentEn = sentRow.querySelector('.sent-en')?.textContent || '';
          const sentZh = sentRow.querySelector('.sent-zh')?.textContent || '';
          currentSelectionInfo = {
            text: sentEn || sentZh,
            page: currentPage,
            range: null,
            rawRects: [],
            paraIndex: undefined
          };
          hasText = true;
          if (dom.ctxBtnAddNoteLabel) dom.ctxBtnAddNoteLabel.textContent = '为此句添加批注便签';
        } else {
          const card = node.closest('.trans-card');
          if (card) {
            const pId = parseInt(card.getAttribute('data-para-id'), 10);
            const para = currentParagraphs.find(p => p.id === pId);
            if (para) {
              currentSelectionInfo = {
                text: para.cleanText,
                page: currentPage,
                range: null,
                rawRects: [],
                paraIndex: para.id
              };
              hasText = true;
              if (dom.ctxBtnAddNoteLabel) dom.ctxBtnAddNoteLabel.textContent = '为此段添加批注便签';
            }
          }
        }
      }

      // 3. 探针定位鼠标悬停下的 PDF 段落与句子
      if (!hasText) {
        let paraSpan = node ? node.closest('[data-para-id]') : null;

        if (!paraSpan) {
          const x = e.clientX;
          const y = e.clientY;
          // 水平与垂直多点探针，即使点在线间距或字符边缘也能精准拾取
          const probes = [
            [0, -4], [0, 4], [-8, 0], [8, 0],
            [0, -10], [0, 10], [-15, 0], [15, 0],
            [-20, 0], [20, 0], [0, -20], [0, 20]
          ];
          for (const [dx, dy] of probes) {
            const el = document.elementFromPoint(x + dx, y + dy);
            if (el && dom.pdfPane && dom.pdfPane.contains(el)) {
              const candidate = el.closest('[data-para-id]');
              if (candidate) {
                paraSpan = candidate;
                break;
              }
            }
          }
        }

        // 备用兜底：若在页面内但在空隙处，就近匹配当前列中垂直距离最近的段落
        if (!paraSpan && currentParagraphs.length > 0) {
          const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
          if (pageWrapper && pageWrapper.contains(node)) {
            const wrapperRect = pageWrapper.getBoundingClientRect();
            const clickRelY = e.clientY - wrapperRect.top;
            let closestPara = null;
            let minDist = 999999;
            currentParagraphs.forEach(p => {
              if (p.rawSpans && p.rawSpans.length > 0) {
                const firstSpan = p.rawSpans[0];
                const spanTop = firstSpan.offsetTop;
                const dist = Math.abs(spanTop - clickRelY);
                if (dist < minDist) {
                  minDist = dist;
                  closestPara = p;
                }
              }
            });
            if (closestPara && minDist < 120 && closestPara.rawSpans.length > 0) {
              paraSpan = closestPara.rawSpans[0];
            }
          }
        }

        if (paraSpan) {
          const pId = parseInt(paraSpan.getAttribute('data-para-id'), 10);
          const para = currentParagraphs.find(p => p.id === pId);
          if (para) {
            let clickedSentIdx = undefined;
            if (para.sentencesEn && para.sentencesEn.length > 0 && para.charMap) {
              let offset = 0;
              if (document.caretRangeFromPoint) {
                const r = document.caretRangeFromPoint(e.clientX, e.clientY);
                if (r && (r.startContainer === paraSpan || r.startContainer.parentElement === paraSpan)) {
                  offset = r.startOffset;
                }
              }
              const charIdx = para.charMap.findIndex(c => c.span === paraSpan && c.offset >= offset);
              const targetIdx = charIdx !== -1 ? charIdx : para.charMap.findIndex(c => c.span === paraSpan);
              if (targetIdx !== -1) {
                const found = para.sentencesEn.findIndex(s => targetIdx >= s.startIdx && targetIdx <= s.endIdx);
                if (found !== -1) clickedSentIdx = found;
              }
            }

            focusParagraphOnPdf(para, clickedSentIdx);

            let targetText = para.cleanText;
            if (clickedSentIdx !== undefined && para.sentencesEn && para.sentencesEn[clickedSentIdx]) {
              targetText = para.sentencesEn[clickedSentIdx].text;
            }

            const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
            const rawRects = (clickedSentIdx !== undefined)
              ? getSentenceHighlightRects(para, clickedSentIdx, pageWrapper)
              : getParagraphHighlightRects(para, pageWrapper);

            currentSelectionInfo = {
              text: targetText,
              page: currentPage,
              range: null,
              rawRects: rawRects,
              paraIndex: para.id
            };
            hasText = true;
            if (dom.ctxBtnAddNoteLabel) dom.ctxBtnAddNoteLabel.textContent = '对此句添加批注便签';

            const card = document.getElementById(`transCard_${currentPage}_${para.id}`);
            if (card) {
              highlightCard(card);
              card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }
        }
      }
    }

    if (!hasText && !hasAnnot) {
      currentSelectionInfo = null;
    }

    // 弹出右键菜单
    showContextMenu(e.clientX, e.clientY, hasText, hasAnnot);
  }

  function showContextMenu(clientX, clientY, hasText = true, hasAnnot = false) {
    const menu = dom.pdfContextMenu;
    if (!menu) return;

    hideSelectionToolbar();
    hideQuickTranslatePopover();
    hideHoverTooltip();

    if (dom.ctxAnnotSection) {
      dom.ctxAnnotSection.style.display = hasAnnot ? 'block' : 'none';
      if (hasAnnot && activeContextAnnot && dom.ctxAnnotColorPicker) {
        dom.ctxAnnotColorPicker.querySelectorAll('.ctx-color-dot').forEach(d => {
          d.classList.toggle('active', d.getAttribute('data-color') === activeContextAnnot.color);
        });
      }
    }

    if (dom.ctxTextSection) {
      dom.ctxTextSection.style.display = hasText ? 'block' : 'none';
    }

    menu.style.display = 'flex';
    menu.style.visibility = 'visible';
    menu.style.opacity = '1';

    const menuW = menu.offsetWidth || 230;
    const menuH = menu.offsetHeight || 280;

    let left = clientX;
    let top = clientY;

    if (left + menuW > window.innerWidth - 12) {
      left = window.innerWidth - menuW - 12;
    }
    if (top + menuH > window.innerHeight - 12) {
      top = window.innerHeight - menuH - 12;
    }
    if (left < 10) left = 10;
    if (top < 10) top = 10;

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function hideContextMenu() {
    if (dom.pdfContextMenu) {
      dom.pdfContextMenu.style.display = 'none';
    }
  }

  // ====================== 核心：就近批注编辑气泡 (Annotation Popover) ======================
  function openAnnotationPopover({
    text = '',
    page = currentPage,
    rects = [],
    paraId = undefined,
    existingAnnot = null,
    anchorRect = null,
    isPageNote = false
  }) {
    hideContextMenu();
    hideSelectionToolbar();
    hideHoverTooltip();

    let popover = dom.annotationPopover || document.getElementById('annotationPopover');
    if (!popover) {
      ensureAllToolbarsExist();
      popover = document.getElementById('annotationPopover');
      if (popover) {
        dom.annotationPopover = popover;
        dom.annotPopoverTitle = document.getElementById('annotPopoverTitle');
        dom.annotPopoverPageBadge = document.getElementById('annotPopoverPageBadge');
        dom.annotQuoteText = document.getElementById('annotQuoteText');
        dom.annotTextInput = document.getElementById('annotTextInput');
        dom.deleteAnnotBtn = document.getElementById('deleteAnnotBtn');
        dom.cancelAnnotBtn = document.getElementById('cancelAnnotBtn');
        dom.saveAnnotBtn = document.getElementById('saveAnnotBtn');
        dom.closeAnnotPopoverBtn = document.getElementById('closeAnnotPopoverBtn');
      }
    }

    if (!popover) {
      // 降级兜底方案：全屏弹窗 modal
      if (dom.noteModal) {
        dom.modalQuoteText.textContent = text || '';
        dom.modalNoteInput.value = existingAnnot ? (existingAnnot.note || '') : '';
        dom.noteModal.style.display = 'flex';
        dom.modalNoteInput.focus();
      }
      return;
    }

    bindAnnotationPopoverEvents();

    currentEditingAnnot = existingAnnot;
    const isEdit = !!existingAnnot;

    const targetText = isEdit ? existingAnnot.text : text;
    const targetPage = isEdit ? existingAnnot.page : page;
    const targetColor = isEdit ? existingAnnot.color : (selectedHighlightColor || 'yellow');
    const targetNote = isEdit ? (existingAnnot.note || '') : '';

    const titleEl = dom.annotPopoverTitle || document.getElementById('annotPopoverTitle');
    if (titleEl) {
      titleEl.textContent = isEdit ? '编辑文献批注' : (isPageNote ? '记录本页研读心得' : '文献研读批注');
    }
    const pageBadgeEl = dom.annotPopoverPageBadge || document.getElementById('annotPopoverPageBadge');
    if (pageBadgeEl) {
      pageBadgeEl.textContent = `第 ${targetPage} 页`;
    }
    const quoteTextEl = dom.annotQuoteText || document.getElementById('annotQuoteText');
    if (quoteTextEl) {
      quoteTextEl.textContent = targetText || '(本页全局研读批注)';
    }
    const textInputEl = dom.annotTextInput || document.getElementById('annotTextInput');
    if (textInputEl) {
      textInputEl.value = targetNote;
    }

    const delBtn = dom.deleteAnnotBtn || document.getElementById('deleteAnnotBtn');
    if (delBtn) {
      delBtn.style.display = isEdit ? 'inline-block' : 'none';
    }

    // 更新气泡内荧光颜色
    popover.querySelectorAll('.annot-color-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-color') === targetColor);
    });
    selectedHighlightColor = targetColor;

    const ansBox = document.getElementById('annotAiAnswerBox');
    if (ansBox) ansBox.style.display = 'none';
    const statusHint = document.getElementById('annotAiStatusHint');
    if (statusHint) statusHint.textContent = '';

    popover.style.display = 'flex';
    popover.style.visibility = 'hidden';

    requestAnimationFrame(() => {
      const popW = popover.offsetWidth || 380;
      const popH = popover.offsetHeight || 290;

      let left = window.innerWidth / 2 - popW / 2;
      let top = window.innerHeight / 2 - popH / 2;

      if (anchorRect && anchorRect.width > 0) {
        left = anchorRect.left + anchorRect.width / 2 - popW / 2;
        top = anchorRect.bottom + 8;
        if (top + popH > window.innerHeight - 16) {
          top = anchorRect.top - popH - 8;
        }
      }

      left = Math.max(16, Math.min(window.innerWidth - popW - 16, left));
      top = Math.max(52, Math.min(window.innerHeight - popH - 16, top));

      popover.style.left = `${Math.round(left)}px`;
      popover.style.top = `${Math.round(top)}px`;
      popover.style.visibility = 'visible';

      const input = dom.annotTextInput || document.getElementById('annotTextInput');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });

    currentNoteContext = {
      text: targetText,
      page: targetPage,
      rects: isEdit ? (existingAnnot.rects || []) : rects,
      paraId: isEdit ? existingAnnot.paraIndex : paraId
    };
  }

  function hideAnnotationPopover() {
    const popover = dom.annotationPopover || document.getElementById('annotationPopover');
    if (popover) {
      popover.style.display = 'none';
    }
    currentEditingAnnot = null;
    currentNoteContext = null;
  }

  function saveCurrentAnnotation() {
    const input = dom.annotTextInput || document.getElementById('annotTextInput');
    const noteText = input ? input.value.trim() : '';

    if (currentEditingAnnot) {
      currentEditingAnnot.note = noteText;
      currentEditingAnnot.color = selectedHighlightColor;
      currentEditingAnnot.timestamp = Date.now();

      vscode.postMessage({
        type: 'saveAnnotations',
        annotations: paperData.annotations
      });

      const annotLayer = document.getElementById(`annotLayer_${currentPage}`);
      if (annotLayer) renderPageAnnotations(currentPage, annotLayer);
      renderNotesList();
      updateNotesBadge();
      vscode.postMessage({ type: 'showInfo', message: '批注已成功更新！' });
    } else {
      const ctx = currentNoteContext || currentSelectionInfo || {};
      const quoteEl = dom.annotQuoteText || document.getElementById('annotQuoteText');
      const quote = (ctx.text && ctx.text.trim()) ? ctx.text : (quoteEl ? quoteEl.textContent : '');
      addAnnotation({
        text: quote || `第 ${currentPage} 页批注`,
        color: selectedHighlightColor,
        note: noteText,
        page: ctx.page || currentPage,
        rawRects: ctx.rects || (currentSelectionInfo ? currentSelectionInfo.rawRects : []),
        paraIndex: ctx.paraId !== undefined ? ctx.paraId : (currentSelectionInfo ? currentSelectionInfo.paraIndex : undefined)
      });
    }

    hideAnnotationPopover();
    window.getSelection()?.removeAllRanges();
  }

  function bindAnnotationPopoverEvents() {
    const popover = dom.annotationPopover || document.getElementById('annotationPopover');
    if (!popover || popover._eventsBound) return;
    popover._eventsBound = true;

    // 防止在气泡内操作时事件冒泡导致关闭
    popover.addEventListener('mousedown', (e) => e.stopPropagation());
    popover.addEventListener('click', (e) => e.stopPropagation());

    // 快捷标签点击自动插入
    popover.querySelectorAll('.quick-tag-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const tag = chip.getAttribute('data-tag');
        const input = dom.annotTextInput || document.getElementById('annotTextInput');
        if (!tag || !input) return;
        const cur = input.value;
        if (!cur.includes(tag)) {
          input.value = cur ? `${cur}\n${tag} ` : `${tag} `;
        }
        input.focus();
      });
    });

    // 气泡颜色选择
    popover.querySelectorAll('.annot-color-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        popover.querySelectorAll('.annot-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedHighlightColor = btn.getAttribute('data-color') || 'yellow';
        const quoteBox = popover.querySelector('.annot-popover-quote');
        if (quoteBox) {
          const colorVarMap = {
            yellow: '#ffeb3b',
            green: '#00e676',
            blue: '#00b0ff',
            pink: '#ff4081'
          };
          quoteBox.style.borderLeftColor = colorVarMap[selectedHighlightColor] || '#ffeb3b';
        }
      });
    });

    const btnAskAi = document.getElementById('btnAskAiPopover');
    if (btnAskAi) btnAskAi.onclick = (e) => { e.stopPropagation(); askAiFromPopover(); };

    const btnAdoptAi = document.getElementById('btnAdoptAiToNote');
    if (btnAdoptAi) btnAdoptAi.onclick = (e) => { e.stopPropagation(); adoptAiAnswerToNote(); };

    const btnCloseAi = document.getElementById('btnCloseAiAnswer');
    if (btnCloseAi) btnCloseAi.onclick = (e) => {
      e.stopPropagation();
      const ansBox = document.getElementById('annotAiAnswerBox');
      if (ansBox) ansBox.style.display = 'none';
    };

    const saveBtn = dom.saveAnnotBtn || document.getElementById('saveAnnotBtn');
    if (saveBtn) saveBtn.onclick = saveCurrentAnnotation;

    const cancelBtn = dom.cancelAnnotBtn || document.getElementById('cancelAnnotBtn');
    if (cancelBtn) cancelBtn.onclick = hideAnnotationPopover;

    const closeBtn = dom.closeAnnotPopoverBtn || document.getElementById('closeAnnotPopoverBtn');
    if (closeBtn) closeBtn.onclick = hideAnnotationPopover;

    const delBtn = dom.deleteAnnotBtn || document.getElementById('deleteAnnotBtn');
    if (delBtn) {
      delBtn.onclick = () => {
        if (currentEditingAnnot) {
          deleteAnnotationById(currentEditingAnnot.id);
          hideAnnotationPopover();
        }
      };
    }

    const input = dom.annotTextInput || document.getElementById('annotTextInput');
    if (input) {
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          saveCurrentAnnotation();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          hideAnnotationPopover();
        }
      };
    }
  }
  bindAnnotationPopoverEvents();

  // ====================== 原文高亮批注悬停预览卡片 ======================
  function showHoverTooltip(annot, anchorRect) {
    clearTimeout(hoverTooltipTimer);
    const tip = dom.noteHoverTooltip;
    if (!tip || !annot) return;

    const colorNames = {
      yellow: '核心要点',
      green: '论据数据',
      blue: '公式方法',
      pink: '疑难待查'
    };

    if (dom.tooltipBadge) dom.tooltipBadge.textContent = colorNames[annot.color] || '文献高亮';
    if (dom.tooltipTime) dom.tooltipTime.textContent = new Date(annot.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (dom.tooltipQuote) dom.tooltipQuote.textContent = annot.text;
    if (dom.tooltipContent) dom.tooltipContent.textContent = annot.note || '(暂无文字批注，点击编辑补充)';

    tip.style.display = 'flex';
    tip.style.visibility = 'hidden';

    const tipW = tip.offsetWidth || 290;
    const tipH = tip.offsetHeight || 160;

    let left = anchorRect.left + anchorRect.width / 2 - tipW / 2;
    let top = anchorRect.top - tipH - 8;

    if (top < 50) {
      top = anchorRect.bottom + 8;
    }
    left = Math.max(12, Math.min(window.innerWidth - tipW - 12, left));

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.visibility = 'visible';

    if (dom.tooltipBtnEdit) {
      dom.tooltipBtnEdit.onclick = (e) => {
        e.stopPropagation();
        hideHoverTooltip();
        openAnnotationPopover({ existingAnnot: annot, anchorRect });
      };
    }

    if (dom.tooltipBtnJump) {
      dom.tooltipBtnJump.onclick = (e) => {
        e.stopPropagation();
        hideHoverTooltip();
        switchTab('notes');
        const card = document.getElementById(`noteCard_${annot.id}`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.style.borderColor = '#0098ff';
          setTimeout(() => card.style.borderColor = 'transparent', 2000);
        }
      };
    }

    if (dom.tooltipBtnDelete) {
      dom.tooltipBtnDelete.onclick = (e) => {
        e.stopPropagation();
        hideHoverTooltip();
        deleteAnnotationById(annot.id);
      };
    }
  }

  function scheduleHideHoverTooltip() {
    clearTimeout(hoverTooltipTimer);
    hoverTooltipTimer = setTimeout(() => {
      hideHoverTooltip();
    }, 280);
  }

  function hideHoverTooltip() {
    if (dom.noteHoverTooltip) {
      dom.noteHoverTooltip.style.display = 'none';
    }
  }

  if (dom.noteHoverTooltip) {
    dom.noteHoverTooltip.addEventListener('mouseenter', () => clearTimeout(hoverTooltipTimer));
    dom.noteHoverTooltip.addEventListener('mouseleave', scheduleHideHoverTooltip);
  }

  function deleteAnnotationById(id) {
    paperData.annotations = paperData.annotations.filter(a => a.id !== id);
    vscode.postMessage({
      type: 'saveAnnotations',
      annotations: paperData.annotations
    });
    updateNotesBadge();
    renderNotesList();
    const annotLayer = document.getElementById(`annotLayer_${currentPage}`);
    if (annotLayer) renderPageAnnotations(currentPage, annotLayer);
    vscode.postMessage({ type: 'showInfo', message: '已删除该条批注' });
  }

  // 浮条颜色选择器
  document.querySelectorAll('.color-dot').forEach((dot) => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      selectedHighlightColor = dot.getAttribute('data-color');
      document.querySelectorAll('.ctx-color-dot').forEach((d) => {
        d.classList.toggle('active', d.getAttribute('data-color') === selectedHighlightColor);
      });
    });
  });

  // 右键菜单文本颜色选择器 (点击即高亮)
  if (dom.ctxTextSection) {
    dom.ctxTextSection.querySelectorAll('.ctx-color-dot').forEach((dot) => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.ctxTextSection.querySelectorAll('.ctx-color-dot').forEach((d) => d.classList.remove('active'));
        dot.classList.add('active');
        selectedHighlightColor = dot.getAttribute('data-color');
        document.querySelectorAll('.color-dot').forEach((d) => {
          d.classList.toggle('active', d.getAttribute('data-color') === selectedHighlightColor);
        });

        if (currentSelectionInfo && currentSelectionInfo.text) {
          addAnnotation({
            text: currentSelectionInfo.text,
            color: selectedHighlightColor,
            note: '',
            page: currentSelectionInfo.page,
            rawRects: currentSelectionInfo.rawRects,
            paraIndex: currentSelectionInfo.paraIndex
          });
          hideContextMenu();
          hideSelectionToolbar();
          window.getSelection()?.removeAllRanges();
        }
      });
    });
  }

  // 右键菜单已有批注改色选择器
  if (dom.ctxAnnotColorPicker) {
    dom.ctxAnnotColorPicker.querySelectorAll('.ctx-color-dot').forEach((dot) => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!activeContextAnnot) return;
        const color = dot.getAttribute('data-color');
        activeContextAnnot.color = color;
        activeContextAnnot.timestamp = Date.now();
        vscode.postMessage({ type: 'saveAnnotations', annotations: paperData.annotations });

        const layer = document.getElementById(`annotLayer_${currentPage}`);
        if (layer) renderPageAnnotations(currentPage, layer);
        renderNotesList();
        hideContextMenu();
        vscode.postMessage({ type: 'showInfo', message: '批注高亮颜色已更新' });
      });
    });
  }

  // 已有批注操作菜单项
  if (dom.ctxBtnEditAnnot) {
    dom.ctxBtnEditAnnot.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!activeContextAnnot) return;
      const annot = activeContextAnnot;
      hideContextMenu();
      openAnnotationPopover({ existingAnnot: annot });
    });
  }

  if (dom.ctxBtnCopyAnnot) {
    dom.ctxBtnCopyAnnot.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!activeContextAnnot) return;
      const annot = activeContextAnnot;
      const textToCopy = `【文献摘录 (P.${annot.page})】\n${annot.text}\n\n【我的批注】\n${annot.note || '(无)'}`;
      try {
        await navigator.clipboard.writeText(textToCopy);
        vscode.postMessage({ type: 'showInfo', message: '批注与原文已复制到剪贴板' });
      } catch (err) {}
      hideContextMenu();
    });
  }

  if (dom.ctxBtnFocusAnnot) {
    dom.ctxBtnFocusAnnot.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!activeContextAnnot) return;
      const annot = activeContextAnnot;
      hideContextMenu();
      switchTab('notes');
      const card = document.getElementById(`noteCard_${annot.id}`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.borderColor = '#0098ff';
        setTimeout(() => card.style.borderColor = 'transparent', 2000);
      }
    });
  }

  if (dom.ctxBtnDeleteAnnot) {
    dom.ctxBtnDeleteAnnot.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!activeContextAnnot) return;
      const id = activeContextAnnot.id;
      hideContextMenu();
      deleteAnnotationById(id);
    });
  }

  // 划线高亮按钮 (浮条)
  dom.btnHighlight.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentSelectionInfo || !currentSelectionInfo.text) return;
    addAnnotation({
      text: currentSelectionInfo.text,
      color: selectedHighlightColor,
      note: '',
      page: currentSelectionInfo.page,
      rawRects: currentSelectionInfo.rawRects,
      paraIndex: currentSelectionInfo.paraIndex
    });
    hideSelectionToolbar();
    hideContextMenu();
    window.getSelection()?.removeAllRanges();
  });

  // 右键菜单高亮按钮
  if (dom.ctxBtnHighlight) {
    dom.ctxBtnHighlight.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentSelectionInfo || !currentSelectionInfo.text) return;
      addAnnotation({
        text: currentSelectionInfo.text,
        color: selectedHighlightColor,
        note: '',
        page: currentSelectionInfo.page,
        rawRects: currentSelectionInfo.rawRects,
        paraIndex: currentSelectionInfo.paraIndex
      });
      hideContextMenu();
      hideSelectionToolbar();
      window.getSelection()?.removeAllRanges();
    });
  }

  // 核心：触发为当前选区或聚焦段落添加批注便签
  function triggerAddNoteFromSelection(e) {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    let text = (currentSelectionInfo && currentSelectionInfo.text) ? currentSelectionInfo.text : '';
    let page = (currentSelectionInfo && currentSelectionInfo.page) ? currentSelectionInfo.page : currentPage;
    let rects = (currentSelectionInfo && currentSelectionInfo.rawRects) ? currentSelectionInfo.rawRects : [];
    let paraId = currentSelectionInfo ? currentSelectionInfo.paraIndex : undefined;
    let anchor = currentSelectionInfo ? currentSelectionInfo.bounding : null;

    if (!text) {
      const sel = window.getSelection();
      if (sel && sel.toString().trim()) {
        text = sel.toString().trim().replace(/(\w+)-\s*\n\s*(\w+)/g, '$1$2').replace(/\s+/g, ' ');
        if (sel.rangeCount > 0) {
          const r = sel.getRangeAt(0);
          anchor = r.getBoundingClientRect();
        }
      }
    }

    if (!text && activeFocusPara) {
      if (activeFocusSentIdx !== undefined && activeFocusPara.sentencesEn && activeFocusPara.sentencesEn[activeFocusSentIdx]) {
        text = activeFocusPara.sentencesEn[activeFocusSentIdx].text;
      } else {
        text = activeFocusPara.cleanText;
      }
      paraId = activeFocusPara.id;
      const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
      if (pageWrapper) {
        rects = (activeFocusSentIdx !== undefined)
          ? getSentenceHighlightRects(activeFocusPara, activeFocusSentIdx, pageWrapper)
          : getParagraphHighlightRects(activeFocusPara, pageWrapper);
      }
    }

    if (!text) {
      vscode.postMessage({ type: 'showInfo', message: '请先在原文中划选一段文字，或点击某段落后再点击【批注】' });
      return;
    }

    hideSelectionToolbar();
    hideContextMenu();
    openAnnotationPopover({
      text: text,
      page: page,
      rects: rects,
      paraId: paraId,
      anchorRect: anchor
    });
  }

  // 添加批注便签按钮 (浮条) -> 打开就近批注编辑气泡
  const noteBtnEl = dom.btnAddNote || document.getElementById('btnAddNote');
  if (noteBtnEl) {
    noteBtnEl.addEventListener('click', triggerAddNoteFromSelection);
  }

  // 浮条事件委托保证 100% 触发批注 (防止动态生成的节点未绑定独立事件)
  const selBarEl = dom.selectionToolbar || document.getElementById('selectionToolbar');
  if (selBarEl) {
    selBarEl.addEventListener('click', (e) => {
      const btn = e.target.closest('#btnAddNote');
      if (btn) {
        triggerAddNoteFromSelection(e);
      }
    });
  }

  function triggerAskAiFromSelection(e) {
    if (e) e.stopPropagation();
    if (!currentSelectionInfo || !currentSelectionInfo.text) return;
    const targetText = currentSelectionInfo.text;
    const contextText = (activeFocusPara ? activeFocusPara.cleanText : targetText);
    hideSelectionToolbar();
    hideContextMenu();
    openAiAssistantModal({
      selectedText: targetText,
      contextText: contextText,
      page: currentSelectionInfo.page || currentPage,
      presetQuestion: `请结合论文上下文，深度剖析此处技术要点与学术意图：“${targetText.slice(0, 180)}”`,
    });
  }

  const btnSelAi = document.getElementById('btnSelectionAi');
  if (btnSelAi) {
    btnSelAi.addEventListener('click', triggerAskAiFromSelection);
  }
  const ctxAskAi = document.getElementById('ctxBtnAskAi');
  if (ctxAskAi) {
    ctxAskAi.addEventListener('click', triggerAskAiFromSelection);
  }

  // 浮条事件委托保证 100% 触发问AI
  if (selBarEl) {
    selBarEl.addEventListener('click', (e) => {
      const btn = e.target.closest('#btnSelectionAi');
      if (btn) {
        triggerAskAiFromSelection(e);
      }
    });
  }

  // 添加批注便签按钮 (右键菜单)
  if (dom.ctxBtnAddNote) {
    dom.ctxBtnAddNote.addEventListener('click', triggerAddNoteFromSelection);
  }

  // 记录本页研读心得 (右键菜单 & 批注栏快速按钮)
  if (dom.ctxBtnAddPageNote) {
    dom.ctxBtnAddPageNote.addEventListener('click', (e) => {
      e.stopPropagation();
      hideContextMenu();
      openAnnotationPopover({
        text: `第 ${currentPage} 页文献总结与研读心得`,
        page: currentPage,
        isPageNote: true,
        rects: []
      });
    });
  }

  if (dom.btnAddPageNoteQuick) {
    dom.btnAddPageNoteQuick.addEventListener('click', (e) => {
      e.stopPropagation();
      openAnnotationPopover({
        text: `第 ${currentPage} 页文献总结与研读心得`,
        page: currentPage,
        isPageNote: true,
        rects: []
      });
    });
  }

  // 划词快捷复制按钮 (浮条)
  if (dom.btnQuickCopy) {
    dom.btnQuickCopy.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!currentSelectionInfo || !currentSelectionInfo.text) return;
      try {
        await navigator.clipboard.writeText(currentSelectionInfo.text);
        vscode.postMessage({ type: 'showInfo', message: '原文已成功复制到剪贴板' });
      } catch (err) {
        console.warn('Clipboard write failed:', err);
      }
      hideSelectionToolbar();
    });
  }

  // 划词查词/译句按钮 (浮条)
  dom.btnQuickTranslate.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentSelectionInfo || !currentSelectionInfo.text) return;
    const info = currentSelectionInfo;
    hideSelectionToolbar();
    hideContextMenu();

    dom.popoverSourceText.textContent = info.text;
    dom.popoverResultText.innerHTML = `<span class="mini-spinner"></span> 正在翻译...`;
    dom.quickTranslatePopover.style.display = 'block';

    const b = info.range ? info.range.getBoundingClientRect() : {
      left: window.innerWidth / 3,
      bottom: window.innerHeight / 3,
      width: 100
    };

    let left = b.left + b.width / 2 - 160;
    let top = b.bottom + 8;
    left = Math.max(10, Math.min(window.innerWidth - 340, left));
    top = Math.max(10, Math.min(window.innerHeight - 200, top));
    dom.quickTranslatePopover.style.left = `${Math.round(left)}px`;
    dom.quickTranslatePopover.style.top = `${Math.round(top)}px`;

    vscode.postMessage({
      type: 'requestTranslateSelection',
      text: info.text
    });
  });

  // 即时学术精译按钮 (右键菜单)
  if (dom.ctxBtnTranslate) {
    dom.ctxBtnTranslate.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentSelectionInfo || !currentSelectionInfo.text) return;
      if (dom.btnQuickTranslate) {
        dom.btnQuickTranslate.click();
      }
    });
  }

  // 复制英文原文 (右键菜单)
  if (dom.ctxBtnCopy) {
    dom.ctxBtnCopy.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!currentSelectionInfo || !currentSelectionInfo.text) return;
      const text = currentSelectionInfo.text;
      try {
        await navigator.clipboard.writeText(text);
        vscode.postMessage({ type: 'showInfo', message: '原文已成功复制到剪贴板' });
      } catch (err) {
        console.warn('Clipboard write failed:', err);
      }
      hideContextMenu();
    });
  }

  // 定位对应翻译卡片 (右键菜单)
  if (dom.ctxBtnLocate) {
    dom.ctxBtnLocate.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentSelectionInfo) return;
      hideContextMenu();
      if (currentSelectionInfo.paraIndex !== undefined) {
        const card = document.getElementById(`transCard_${currentPage}_${currentSelectionInfo.paraIndex}`);
        if (card) {
          highlightCard(card);
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      } else if (currentSelectionInfo.range) {
        alignRightSentenceHighlight(currentSelectionInfo.range, currentSelectionInfo.text);
      }
    });
  }

  // 全局菜单按钮 (整页翻译, 适合宽度, 上一页, 下一页, 导出笔记)
  if (dom.ctxBtnTranslatePage) {
    dom.ctxBtnTranslatePage.addEventListener('click', () => {
      hideContextMenu();
      if (dom.translateAllBtn) dom.translateAllBtn.click();
    });
  }

  if (dom.ctxBtnFitWidth) {
    dom.ctxBtnFitWidth.addEventListener('click', () => {
      hideContextMenu();
      if (dom.zoomFitBtn) dom.zoomFitBtn.click();
    });
  }

  if (dom.ctxBtnPrevPage) {
    dom.ctxBtnPrevPage.addEventListener('click', () => {
      hideContextMenu();
      if (dom.prevPageBtn) dom.prevPageBtn.click();
    });
  }

  if (dom.ctxBtnNextPage) {
    dom.ctxBtnNextPage.addEventListener('click', () => {
      hideContextMenu();
      if (dom.nextPageBtn) dom.nextPageBtn.click();
    });
  }

  if (dom.ctxBtnExportNotes) {
    dom.ctxBtnExportNotes.addEventListener('click', () => {
      hideContextMenu();
      if (dom.exportNotesBtn) dom.exportNotesBtn.click();
    });
  }

  // ====================== 段落聚焦快捷浮条事件绑定 ======================

  // 段落聚焦快捷浮条按钮
  if (dom.btnFocusHighlight) {
    dom.btnFocusHighlight.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!activeFocusPara) return;
      const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
      const rawRects = (activeFocusSentIdx !== undefined)
        ? (pageWrapper ? getSentenceHighlightRects(activeFocusPara, activeFocusSentIdx, pageWrapper) : [])
        : (pageWrapper ? getParagraphHighlightRects(activeFocusPara, pageWrapper) : []);
      const targetText = (activeFocusSentIdx !== undefined && activeFocusPara.sentencesEn && activeFocusPara.sentencesEn[activeFocusSentIdx])
        ? activeFocusPara.sentencesEn[activeFocusSentIdx].text
        : activeFocusPara.cleanText;

      addAnnotation({
        text: targetText,
        color: selectedHighlightColor,
        note: '',
        page: currentPage,
        rawRects: rawRects,
        paraIndex: activeFocusPara.id
      });
      hideParaFocusBar();
      vscode.postMessage({ type: 'showInfo', message: `已成功为此${activeFocusSentIdx !== undefined ? '句子' : '段落'}添加高亮` });
    });
  }

  if (dom.btnFocusAi || document.getElementById('btnFocusAi')) {
    const btn = dom.btnFocusAi || document.getElementById('btnFocusAi');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetPara = activeFocusPara || (currentParagraphs && currentParagraphs[0]);
      const targetText = (activeFocusSentIdx !== undefined && targetPara && targetPara.sentencesEn && targetPara.sentencesEn[activeFocusSentIdx])
        ? targetPara.sentencesEn[activeFocusSentIdx].text
        : (targetPara ? targetPara.cleanText : '');
      openAiAssistantModal({
        selectedText: targetText,
        contextText: targetPara ? targetPara.cleanText : targetText,
        page: currentPage,
        presetQuestion: targetText ? `请结合论文上下文，深度剖析此处学术意图与核心原理：“${targetText.slice(0, 180)}”` : '请结合本页论文上下文，深度剖析核心技术逻辑与学术创新点。',
      });
      hideParaFocusBar();
    });
  }

  if (dom.btnFocusNote) {
    dom.btnFocusNote.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!activeFocusPara) return;
      const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
      const rawRects = (activeFocusSentIdx !== undefined)
        ? (pageWrapper ? getSentenceHighlightRects(activeFocusPara, activeFocusSentIdx, pageWrapper) : [])
        : (pageWrapper ? getParagraphHighlightRects(activeFocusPara, pageWrapper) : []);
      const targetText = (activeFocusSentIdx !== undefined && activeFocusPara.sentencesEn && activeFocusPara.sentencesEn[activeFocusSentIdx])
        ? activeFocusPara.sentencesEn[activeFocusSentIdx].text
        : activeFocusPara.cleanText;

      openAnnotationPopover({
        text: targetText,
        page: currentPage,
        rects: rawRects,
        paraId: activeFocusPara.id,
        anchorRect: dom.btnFocusNote.getBoundingClientRect()
      });
      hideParaFocusBar();
    });
  }

  if (dom.btnFocusTranslate) {
    dom.btnFocusTranslate.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!activeFocusPara) return;
      // 联动聚焦右侧卡片与该句子
      const card = document.getElementById(`transCard_${currentPage}_${activeFocusPara.id}`);
      if (card) {
        highlightCard(card);
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (activeFocusSentIdx !== undefined) {
          const row = card.querySelector(`.sentence-pair-row[data-sent-idx="${activeFocusSentIdx}"]`);
          if (row) {
            row.classList.add('active-sentence-row');
            row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      }
      triggerParagraphTranslate(currentPage, activeFocusPara, true);
    });
  }

  if (dom.btnFocusCopy) {
    dom.btnFocusCopy.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!activeFocusPara) return;
      const targetText = (activeFocusSentIdx !== undefined && activeFocusPara.sentencesEn && activeFocusPara.sentencesEn[activeFocusSentIdx])
        ? activeFocusPara.sentencesEn[activeFocusSentIdx].text
        : activeFocusPara.cleanText;
      try {
        await navigator.clipboard.writeText(targetText);
        vscode.postMessage({ type: 'showInfo', message: `已复制当前${activeFocusSentIdx !== undefined ? '句子' : '段落'}文本` });
      } catch (err) {}
      hideParaFocusBar();
    });
  }

  if (dom.btnCloseFocusBar) {
    dom.btnCloseFocusBar.addEventListener('click', (e) => {
      e.stopPropagation();
      hideParaFocusBar();
    });
  }

  // 点击外部收起右键菜单与气泡
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      if (dom.paraFocusBar && dom.paraFocusBar.style.display !== 'none' && !dom.paraFocusBar.contains(e.target)) {
        if (!e.target.closest('[data-para-id]')) {
          hideParaFocusBar();
        }
      }
      if (dom.pdfContextMenu && dom.pdfContextMenu.style.display !== 'none' && !dom.pdfContextMenu.contains(e.target)) {
        hideContextMenu();
      }
      if (dom.annotationPopover && dom.annotationPopover.style.display !== 'none' && !dom.annotationPopover.contains(e.target)) {
        if (!e.target.closest('#btnAddNote') && !e.target.closest('#ctxBtnAddNote') && !e.target.closest('#ctxBtnEditAnnot') && !e.target.closest('.note-pin-badge') && !e.target.closest('.btn-row-note') && !e.target.closest('#btnFocusNote') && !e.target.closest('#btnAddPageNoteQuick')) {
          hideAnnotationPopover();
        }
      }
    }
  });
  window.addEventListener('click', (e) => {
    if (dom.pdfContextMenu && dom.pdfContextMenu.style.display !== 'none') {
      if (!dom.pdfContextMenu.contains(e.target)) {
        hideContextMenu();
      }
    }
  });

  // 全局快捷键监听 (H: 高亮, N: 笔记, T: 翻译, Esc: 关闭)
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      if (e.key === 'Escape') {
        if (dom.noteModal) dom.noteModal.style.display = 'none';
      }
      return;
    }

    if (e.key === 'Escape') {
      hideContextMenu();
      hideSelectionToolbar();
      hideQuickTranslatePopover();
      hideAnnotationPopover();
      hideHoverTooltip();
      if (dom.noteModal) dom.noteModal.style.display = 'none';
      return;
    }

    if (!currentSelectionInfo || !currentSelectionInfo.text) return;

    if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      addAnnotation({
        text: currentSelectionInfo.text,
        color: selectedHighlightColor,
        note: '',
        page: currentSelectionInfo.page,
        rawRects: currentSelectionInfo.rawRects,
        paraIndex: currentSelectionInfo.paraIndex
      });
      hideContextMenu();
      hideSelectionToolbar();
      window.getSelection()?.removeAllRanges();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      const info = currentSelectionInfo;
      hideContextMenu();
      hideSelectionToolbar();
      openAnnotationPopover({
        text: info.text,
        page: info.page || currentPage,
        rects: info.rawRects || [],
        paraId: info.paraIndex,
        anchorRect: info.bounding
      });
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      if (dom.btnQuickTranslate) {
        dom.btnQuickTranslate.click();
      }
    } else if ((e.key === 'q' || e.key === 'Q') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const targetText = currentSelectionInfo ? currentSelectionInfo.text : (activeFocusPara ? activeFocusPara.cleanText : '');
      const contextText = activeFocusPara ? activeFocusPara.cleanText : targetText;
      openAiAssistantModal({
        selectedText: targetText,
        contextText: contextText,
        page: currentPage,
        presetQuestion: targetText ? `请结合论文上下文，深度剖析此处技术意图与学术要点：“${targetText.slice(0, 160)}”` : '请结合本页论文上下文，深度剖析当前段落的核心技术动机与原理。',
      });
      hideContextMenu();
      hideSelectionToolbar();
      hideParaFocusBar();
    } else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const text = currentSelectionInfo.text;
      navigator.clipboard.writeText(text).then(() => {
        vscode.postMessage({ type: 'showInfo', message: '原文已成功复制到剪贴板' });
      }).catch(() => {});
      hideContextMenu();
      hideSelectionToolbar();
    }
  });

  function handleSelectionTranslateResult(msg) {
    if (dom.popoverResultText) dom.popoverResultText.textContent = msg.translated;
    if (dom.instantTranslatedText) dom.instantTranslatedText.textContent = msg.translated;
  }

  // 视图切换：卡片对照 vs 沉浸全文精读
  let currentRightView = 'cards';

  if (dom.btnViewCards && dom.btnViewArticle) {
    dom.btnViewCards.addEventListener('click', () => {
      currentRightView = 'cards';
      dom.btnViewCards.classList.add('active');
      dom.btnViewArticle.classList.remove('active');
      dom.transListContainer.style.display = 'block';
      if (dom.articleFlowContainer) dom.articleFlowContainer.style.display = 'none';
    });

    dom.btnViewArticle.addEventListener('click', () => {
      currentRightView = 'article';
      dom.btnViewArticle.classList.add('active');
      dom.btnViewCards.classList.remove('active');
      dom.transListContainer.style.display = 'none';
      if (dom.articleFlowContainer) {
        dom.articleFlowContainer.style.display = 'block';
        renderArticleFlow(currentPage, currentParagraphs);
      }
    });
  }

  // 即时划词卡片按钮
  if (dom.btnCloseInstant) {
    dom.btnCloseInstant.addEventListener('click', () => {
      dom.instantTranslateCard.style.display = 'none';
    });
  }

  if (dom.btnCopyInstantZh) {
    dom.btnCopyInstantZh.addEventListener('click', () => {
      const text = dom.instantTranslatedText ? dom.instantTranslatedText.textContent : '';
      if (text) {
        navigator.clipboard.writeText(text);
        vscode.postMessage({ type: 'showInfo', message: '已复制译文到剪贴板' });
      }
    });
  }

  if (dom.btnNoteFromInstant) {
    dom.btnNoteFromInstant.addEventListener('click', () => {
      if (!currentSelectionInfo) return;
      openAnnotationPopover({
        text: currentSelectionInfo.text,
        page: currentSelectionInfo.page || currentPage,
        rects: currentSelectionInfo.rawRects || [],
        paraId: currentSelectionInfo.paraIndex,
        anchorRect: dom.btnNoteFromInstant.getBoundingClientRect()
      });
    });
  }

  // 底部速照栏操作按钮
  if (dom.btnCloseDocked) {
    dom.btnCloseDocked.addEventListener('click', () => {
      dom.dockedInspector.style.display = 'none';
    });
  }

  if (dom.btnCopyDockedZh) {
    dom.btnCopyDockedZh.addEventListener('click', () => {
      const text = dom.dockedZhText ? dom.dockedZhText.textContent : '';
      if (text) {
        navigator.clipboard.writeText(text);
        vscode.postMessage({ type: 'showInfo', message: '已复制中文译文到剪贴板' });
      }
    });
  }

  if (dom.btnCopyDockedEn) {
    dom.btnCopyDockedEn.addEventListener('click', () => {
      const text = dom.dockedEnText ? dom.dockedEnText.textContent : '';
      if (text) {
        navigator.clipboard.writeText(text);
        vscode.postMessage({ type: 'showInfo', message: '已复制英文原文到剪贴板' });
      }
    });
  }

  if (dom.btnNoteFromDocked) {
    dom.btnNoteFromDocked.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = dom.dockedEnText ? dom.dockedEnText.textContent : '';
      if (!text) return;
      const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
      let rects = null;
      if (activeFocusPara) {
        if (activeFocusSentIdx !== undefined) {
          rects = getSentenceHighlightRects(activeFocusPara, activeFocusSentIdx, pageWrapper);
        } else {
          rects = getParagraphHighlightRects(activeFocusPara, pageWrapper);
        }
      }
      openAnnotationPopover({
        text: text,
        page: currentPage,
        rects: rects || [],
        paraId: activeFocusPara ? activeFocusPara.id : undefined,
        anchorRect: dom.btnNoteFromDocked.getBoundingClientRect()
      });
    });
  }

  function openNoteModal(quoteText, rects = null, paraId = undefined) {
    openAnnotationPopover({
      text: quoteText || (currentSelectionInfo ? currentSelectionInfo.text : ''),
      page: currentPage,
      rects: rects || (currentSelectionInfo ? currentSelectionInfo.rawRects : []),
      paraId: paraId
    });
  }

  dom.closePopoverBtn.addEventListener('click', hideQuickTranslatePopover);
  function hideQuickTranslatePopover() {
    dom.quickTranslatePopover.style.display = 'none';
  }

  // ====================== 批注管理与高亮渲染 ======================
  function addAnnotation({ text, color, note, page = currentPage, rawRects = null, paraIndex = undefined }) {
    if (!text) return;

    let targetParaId = paraIndex;
    if (targetParaId === undefined || targetParaId === -1) {
      for (const p of currentParagraphs) {
        if ((p.cleanText || '').includes(text)) {
          targetParaId = p.id;
          break;
        }
      }
    }

    let lineRects = [];
    if (rawRects && rawRects.length > 0) {
      lineRects = mergeAdjacentLineRects(rawRects);
    } else if (currentSelectionInfo && currentSelectionInfo.range) {
      const range = currentSelectionInfo.range;
      const clientRects = Array.from(range.getClientRects());
      const pageWrapper = document.getElementById(`pageWrapper_${page}`);
      const parentRect = pageWrapper ? pageWrapper.getBoundingClientRect() : { left: 0, top: 0 };
      const unmerged = clientRects.map(r => ({
        left: Math.round(r.left - parentRect.left),
        top: Math.round(r.top - parentRect.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }));
      lineRects = mergeAdjacentLineRects(unmerged);
    }

    // 以缩放无损坐标归一化存储
    const normalizedRects = lineRects.map(r => ({
      left: r.left / currentScale,
      top: r.top / currentScale,
      width: r.width / currentScale,
      height: r.height / currentScale
    }));

    const annotation = {
      id: 'annot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      page: page,
      text: text,
      color: color || selectedHighlightColor || 'yellow',
      note: note || '',
      paraIndex: targetParaId !== -1 ? targetParaId : undefined,
      timestamp: Date.now(),
      rects: normalizedRects
    };

    paperData.annotations.push(annotation);

    vscode.postMessage({
      type: 'saveAnnotations',
      annotations: paperData.annotations
    });

    if (currentPage === page) {
      const annotLayer = document.getElementById(`annotLayer_${currentPage}`);
      if (annotLayer) renderPageAnnotations(currentPage, annotLayer);
    }

    updateNotesBadge();
    renderNotesList();

    if (note) {
      switchTab('notes');
      vscode.postMessage({ type: 'showInfo', message: '已成功保存文献笔记！' });
    } else {
      vscode.postMessage({ type: 'showInfo', message: '已添加高亮标记' });
    }
  }

  /**
   * 批注 → 段落：**引文文字是稳定标识，段落编号只做兜底**。
   *
   * 为什么：视觉手术会合并/拆分段落并重新编号，历史批注里存的 paraIndex 很可能
   * 已经指到另一个段落上（症状是"点批注跳到别的段"）。引文文字不会因为重新编号而失效。
   */
  function findParaForAnnotation(annot) {
    const list = currentParagraphs || [];
    if (!annot) return null;
    const text = annot.text || '';
    const matches = para =>
      !!para && !!text && ((para.cleanText || '').includes(text) || text.includes(para.cleanText || ''));
    const byId = annot.paraIndex !== undefined ? list.find(p => p.id === annot.paraIndex) : null;
    if (byId && (!text || matches(byId))) return byId;
    if (text) {
      const byText = list.find(matches);
      if (byText) return byText;
    }
    return byId || null;
  }

  function renderPageAnnotations(pageNum, annotLayerDiv) {
    annotLayerDiv.innerHTML = '';
    const pageAnnots = paperData.annotations.filter((a) => a.page === pageNum);
    if (pageAnnots.length === 0) return;

    let hasRepaired = false;
    const pageWrapper = document.getElementById(`pageWrapper_${pageNum}`);

    pageAnnots.forEach((annot) => {
      // 自动修复：若缺少 rects，利用当前页面已解析的段落与句子自动补全物理高亮矩形
      if ((!annot.rects || annot.rects.length === 0) && pageWrapper && currentParagraphs && currentParagraphs.length > 0) {
        // 引文文字优先、编号兜底：视觉手术重新编号后，编号可能已经指到别的段（见 findParaForAnnotation）
        const matchedPara = findParaForAnnotation(annot);
        if (matchedPara) {
          let matchedSentIdx = undefined;
          if (matchedPara.sentencesEn) {
            const sIdx = matchedPara.sentencesEn.findIndex(s => s.text === annot.text || (s.text && annot.text && (s.text.includes(annot.text) || annot.text.includes(s.text))));
            if (sIdx !== -1) matchedSentIdx = sIdx;
          }
          const rawRects = (matchedSentIdx !== undefined)
            ? getSentenceHighlightRects(matchedPara, matchedSentIdx, pageWrapper)
            : getParagraphHighlightRects(matchedPara, pageWrapper);

          if (rawRects && rawRects.length > 0) {
            const merged = mergeAdjacentLineRects(rawRects);
            annot.rects = merged.map(r => ({
              left: r.left / currentScale,
              top: r.top / currentScale,
              width: r.width / currentScale,
              height: r.height / currentScale
            }));
            if (annot.paraIndex === undefined) {
              annot.paraIndex = matchedPara.id;
            }
            hasRepaired = true;
          }
        }
      }

      if (!annot.rects || annot.rects.length === 0) return;

      annot.rects.forEach(r => {
        const mark = document.createElement('div');
        mark.className = `highlight-mark ${annot.color}`;
        mark.dataset.annotId = annot.id;
        mark.style.left = `${Math.round(r.left * currentScale)}px`;
        mark.style.top = `${Math.round(r.top * currentScale)}px`;
        mark.style.width = `${Math.round(r.width * currentScale)}px`;
        mark.style.height = `${Math.round(r.height * currentScale)}px`;
        // 连原生 title 提示也不挂：鼠标滑过高亮句子时不应该有任何东西冒出来。
        // 需要看批注内容/编辑时，点击高亮即可打开批注卡片。
        mark.addEventListener('click', (e) => {
          e.stopPropagation();
          openAnnotationPopover({ existingAnnot: annot, anchorRect: mark.getBoundingClientRect() });
        });

        annotLayerDiv.appendChild(mark);
      });

      // 如果包含批注便签文字，在最后一截高亮末端右上角绘制精致图钉徽章
      if (annot.note && annot.note.trim()) {
        const lastRect = annot.rects[annot.rects.length - 1];
        const pin = document.createElement('div');
        pin.className = `note-pin-badge ${annot.color}`;
        pin.dataset.annotId = annot.id;
        pin.title = '批注';
        pin.innerHTML = `✍️`;

        pin.style.left = `${Math.round((lastRect.left + lastRect.width) * currentScale) - 6}px`;
        pin.style.top = `${Math.round(lastRect.top * currentScale) - 8}px`;

        // 同样不再悬停弹出预览（只保留点击打开批注卡片）
        pin.addEventListener('click', (e) => {
          e.stopPropagation();
          openAnnotationPopover({ existingAnnot: annot, anchorRect: pin.getBoundingClientRect() });
        });

        annotLayerDiv.appendChild(pin);
      }
    });

    if (hasRepaired) {
      vscode.postMessage({
        type: 'saveAnnotations',
        annotations: paperData.annotations
      });
    }
  }

  function updateNotesBadge() {
    const count = paperData.annotations ? paperData.annotations.length : 0;
    if (dom.notesCount) dom.notesCount.textContent = count;
    if (dom.filterCountAll) dom.filterCountAll.textContent = count;
  }

  function renderNotesList() {
    dom.notesListContainer.innerHTML = '';

    const allAnnotations = paperData.annotations || [];
    updateNotesBadge();

    let filtered = allAnnotations;

    // 颜色筛选
    if (currentNotesColorFilter && currentNotesColorFilter !== 'all') {
      filtered = filtered.filter(a => a.color === currentNotesColorFilter);
    }

    // 关键词搜索筛选 (原文或批注)
    if (currentNotesSearchQuery && currentNotesSearchQuery.trim()) {
      const q = currentNotesSearchQuery.trim().toLowerCase();
      filtered = filtered.filter(a => {
        const matchText = (a.text || '').toLowerCase().includes(q);
        const matchNote = (a.note || '').toLowerCase().includes(q);
        return matchText || matchNote;
      });
    }

    if (filtered.length === 0) {
      if (allAnnotations.length === 0) {
        dom.notesListContainer.innerHTML = `
          <div class="empty-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            <p>暂无批注记录。<br>在左侧 PDF 划选文字后点击【高亮】或【批注】即可保存！</p>
          </div>`;
      } else {
        dom.notesListContainer.innerHTML = `
          <div class="empty-state">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <p>未找到符合条件的批注或笔记<br><span style="font-size: 11px; opacity: 0.7;">尝试清空搜索框或切换颜色分类</span></p>
          </div>`;
      }
      return;
    }

    const colorNames = {
      yellow: '核心要点',
      green: '论据数据',
      blue: '公式方法',
      pink: '疑难待查'
    };

    filtered.forEach((annot) => {
      const card = document.createElement('div');
      card.className = 'note-card';
      card.id = `noteCard_${annot.id}`;
      card.dataset.annotId = annot.id;

      card.innerHTML = `
        <div class="note-card-top">
          <div class="note-color-badge" title="点击切换高亮颜色">
            <span class="color-indicator ${annot.color}"></span>
            <span>第 ${annot.page} 页 · ${colorNames[annot.color] || '高亮'}</span>
          </div>
          <span class="note-time">${new Date(annot.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="note-quote" title="双击快速复制原文">${escapeHtml(annot.text)}</div>
        <div class="note-content-display">
          ${annot.note ? `<div class="note-content">${escapeHtml(annot.note)}</div>` : `<div class="note-content empty-note" style="color: var(--text-secondary); font-style: italic; font-size: 11px; cursor: pointer;">+ 点击补充批注心得</div>`}
        </div>
        <div class="note-inline-editor" style="display: none; margin-top: 8px;">
          <textarea class="note-inline-textarea" style="width: 100%; box-sizing: border-box; background: var(--bg-primary); border: 1px solid var(--accent-color); border-radius: 6px; padding: 6px 8px; color: var(--text-primary); font-size: 12px; resize: vertical; min-height: 56px; outline: none;"></textarea>
          <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px;">
            <button class="btn-cancel-inline" style="background: transparent; border: 1px solid var(--border-color); color: var(--text-secondary); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;">取消</button>
            <button class="btn-save-inline" style="background: var(--accent-color); border: none; color: #fff; border-radius: 4px; padding: 2px 10px; font-size: 11px; cursor: pointer; font-weight: 500;">保存</button>
          </div>
        </div>
        <div class="note-card-bottom">
          <button class="btn-card-action btn-ask-ai-from-note" style="color: #6366f1; font-weight: 500;" title="针对此疑点向AI导师提问">
            问AI
          </button>
          <button class="btn-card-action btn-edit-note" title="编辑批注内容">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            编辑
          </button>
          <button class="btn-card-action btn-copy-annot" title="复制批注与引文">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            复制
          </button>
          <button class="btn-card-action btn-jump" title="跳转到 PDF 原文位置">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
            定位
          </button>
          <button class="btn-card-action btn-del" style="color: #ff6b6b;" title="删除这条批注">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
            删除
          </button>
        </div>
      `;

      // 绑定行内编辑
      const displayDiv = card.querySelector('.note-content-display');
      const editorDiv = card.querySelector('.note-inline-editor');
      const textarea = card.querySelector('.note-inline-textarea');
      const btnEdit = card.querySelector('.btn-edit-note');
      const btnCancel = card.querySelector('.btn-cancel-inline');
      const btnSave = card.querySelector('.btn-save-inline');

      const startEditing = () => {
        textarea.value = annot.note || '';
        displayDiv.style.display = 'none';
        editorDiv.style.display = 'block';
        textarea.focus();
      };

      const btnAskAi = card.querySelector('.btn-ask-ai-from-note');
      if (btnAskAi) {
        btnAskAi.addEventListener('click', (e) => {
          e.stopPropagation();
          let contextText = annot.text;
          if (annot.paraIndex !== undefined) {
            const matchP = currentParagraphs.find(p => p.id === annot.paraIndex);
            if (matchP) contextText = matchP.cleanText;
          }
          openAiAssistantModal({
            selectedText: annot.text,
            contextText: contextText,
            presetQuestion: annot.note ? `针对我记录的疑点批注【${annot.note}】：请结合论文深度剖析该处原理与逻辑。` : '请针对此疑难点进行深度学术解析与背景动机推导。',
            page: annot.page,
            noteType: '疑难待查',
          });
        });
      }

      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        startEditing();
      });

      const emptyNoteDiv = card.querySelector('.empty-note');
      if (emptyNoteDiv) {
        emptyNoteDiv.addEventListener('click', (e) => {
          e.stopPropagation();
          startEditing();
        });
      }

      btnCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        editorDiv.style.display = 'none';
        displayDiv.style.display = 'block';
      });

      btnSave.addEventListener('click', (e) => {
        e.stopPropagation();
        annot.note = textarea.value.trim();
        annot.timestamp = Date.now();
        vscode.postMessage({
          type: 'saveAnnotations',
          annotations: paperData.annotations
        });
        editorDiv.style.display = 'none';
        displayDiv.style.display = 'block';
        renderNotesList();
        if (currentPage === annot.page) {
          const annotLayer = document.getElementById(`annotLayer_${currentPage}`);
          if (annotLayer) renderPageAnnotations(currentPage, annotLayer);
        }
        vscode.postMessage({ type: 'showInfo', message: '批注已更新' });
      });

      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          btnSave.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          btnCancel.click();
        }
      });

      // 点击颜色标签快速轮换高亮色
      const colorBadge = card.querySelector('.note-color-badge');
      colorBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        const colors = ['yellow', 'green', 'blue', 'pink'];
        const nextIdx = (colors.indexOf(annot.color) + 1) % colors.length;
        annot.color = colors[nextIdx];
        annot.timestamp = Date.now();
        vscode.postMessage({
          type: 'saveAnnotations',
          annotations: paperData.annotations
        });
        renderNotesList();
        if (currentPage === annot.page) {
          const annotLayer = document.getElementById(`annotLayer_${currentPage}`);
          if (annotLayer) renderPageAnnotations(currentPage, annotLayer);
        }
      });

      // 复制
      card.querySelector('.btn-copy-annot').addEventListener('click', async (e) => {
        e.stopPropagation();
        const textToCopy = `【文献引文 (P.${annot.page})】\n${annot.text}\n\n【我的批注】\n${annot.note || '(无)'}`;
        try {
          await navigator.clipboard.writeText(textToCopy);
          vscode.postMessage({ type: 'showInfo', message: '批注与原文已复制到剪贴板' });
        } catch (err) {}
      });

      // 双击引用快速复制原文
      card.querySelector('.note-quote').addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(annot.text);
          vscode.postMessage({ type: 'showInfo', message: '原文已成功复制' });
        } catch (err) {}
      });

      // 定位跳转
      const jumpToAnnotation = async () => {
        if (currentPage !== annot.page) {
          await renderPage(annot.page);
          await new Promise(r => setTimeout(r, 60));
        }

        const pageWrapper = document.getElementById(`pageWrapper_${annot.page}`);
        if (!pageWrapper || !dom.pdfViewerContainer) return;

        // 1. 若批注有准确的矩形坐标，直接定位并闪烁高光
        if (annot.rects && annot.rects.length > 0) {
          const r = annot.rects[0];
          const targetY = pageWrapper.offsetTop + r.top * currentScale - 120;
          dom.pdfViewerContainer.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });

          const marks = pageWrapper.querySelectorAll(`.highlight-mark[data-annot-id="${annot.id}"]`);
          marks.forEach(m => {
            m.classList.remove('annot-jump-flash');
            void m.offsetWidth;
            m.classList.add('annot-jump-flash');
            setTimeout(() => m.classList.remove('annot-jump-flash'), 2200);
          });
          return;
        }

        // 2. 若缺少 rects（如历史遗留数据），智能查找对应段落/句子并定位
        const matchedPara = findParaForAnnotation(annot);

        if (matchedPara) {
          let matchedSentIdx = undefined;
          if (matchedPara.sentencesEn) {
            const sIdx = matchedPara.sentencesEn.findIndex(s => s.text === annot.text || (s.text && annot.text && (s.text.includes(annot.text) || annot.text.includes(s.text))));
            if (sIdx !== -1) matchedSentIdx = sIdx;
          }

          focusParagraphOnPdf(matchedPara, matchedSentIdx);

          const pRects = (matchedSentIdx !== undefined)
            ? getSentenceHighlightRects(matchedPara, matchedSentIdx, pageWrapper)
            : getParagraphHighlightRects(matchedPara, pageWrapper);

          if (pRects && pRects.length > 0) {
            const targetY = pageWrapper.offsetTop + pRects[0].top - 120;
            dom.pdfViewerContainer.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
          } else {
            dom.pdfViewerContainer.scrollTo({ top: Math.max(0, pageWrapper.offsetTop - 50), behavior: 'smooth' });
          }

          // 联动聚焦右侧对照卡片
          const card = document.getElementById(`transCard_${annot.page}_${matchedPara.id}`);
          if (card) {
            highlightCard(card);
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        } else {
          // 兜底直接滚到对应页面
          dom.pdfViewerContainer.scrollTo({ top: Math.max(0, pageWrapper.offsetTop - 50), behavior: 'smooth' });
        }
      };

      card.querySelector('.btn-jump').addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToAnnotation();
      });

      card.addEventListener('click', (e) => {
        if (e.target.closest('.note-inline-editor') ||
            e.target.closest('.btn-card-action') ||
            e.target.closest('.note-color-badge') ||
            e.target.closest('.empty-note')) {
          return;
        }
        jumpToAnnotation();
      });

      // 删除
      card.querySelector('.btn-del').addEventListener('click', () => {
        deleteAnnotationById(annot.id);
      });

      dom.notesListContainer.appendChild(card);
    });
  }

  // 笔记搜索与筛选栏事件
  if (dom.notesSearchInput) {
    dom.notesSearchInput.addEventListener('input', (e) => {
      currentNotesSearchQuery = e.target.value;
      if (dom.clearNotesSearch) {
        dom.clearNotesSearch.style.display = currentNotesSearchQuery ? 'flex' : 'none';
      }
      renderNotesList();
    });
  }

  if (dom.clearNotesSearch) {
    dom.clearNotesSearch.addEventListener('click', () => {
      if (dom.notesSearchInput) dom.notesSearchInput.value = '';
      currentNotesSearchQuery = '';
      dom.clearNotesSearch.style.display = 'none';
      renderNotesList();
    });
  }

  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentNotesColorFilter = chip.getAttribute('data-color') || 'all';
      renderNotesList();
    });
  });

  // ====================== Tab 切换与工具栏控制 ======================
  function switchTab(tab) {
    if (tab === 'trans') {
      dom.tabTransBtn.classList.add('active');
      dom.tabNotesBtn.classList.remove('active');
      dom.transView.classList.add('active');
      dom.notesView.classList.remove('active');
    } else {
      dom.tabTransBtn.classList.remove('active');
      dom.tabNotesBtn.classList.add('active');
      dom.transView.classList.remove('active');
      dom.notesView.classList.add('active');
    }
  }

  dom.tabTransBtn.addEventListener('click', () => switchTab('trans'));
  dom.tabNotesBtn.addEventListener('click', () => switchTab('notes'));

  dom.prevPageBtn.addEventListener('click', () => {
    if (currentPage > 1) renderPage(currentPage - 1);
  });
  dom.nextPageBtn.addEventListener('click', () => {
    if (currentPage < totalPages) renderPage(currentPage + 1);
  });
  dom.pageNumberInput.addEventListener('change', () => {
    let p = parseInt(dom.pageNumberInput.value, 10);
    if (!isNaN(p) && p >= 1 && p <= totalPages) {
      renderPage(p);
    } else {
      dom.pageNumberInput.value = currentPage;
    }
  });

  // ====================== 自动适应窗口宽度（手动缩放优先） ======================
  const FIT_MIN_SCALE = 0.3;
  const FIT_MAX_SCALE = 3.5;
  /** 页面与滚动条之间留一点呼吸空间（px） */
  const FIT_MARGIN = 8;
  /** 可用宽度低于此值就不强行缩放（极端窄栏） */
  const FIT_MIN_CONTENT_WIDTH = 120;

  function clampFitScale(s) {
    return Math.min(FIT_MAX_SCALE, Math.max(FIT_MIN_SCALE, Math.round(s * 1000) / 1000));
  }

  /**
   * 左栏中真正可用于放页面的宽度。
   * 用容器的 clientWidth（已排除竖直滚动条）减去其左右内边距，
   * 比旧代码写死的 -48 更准——否则会白白浪费三十多像素，页面贴不满窗口。
   */
  function getAvailablePaneWidth() {
    const container = (dom && dom.pdfViewerContainer) || (dom && dom.pdfPane);
    if (!container) return 0;
    let pad = 0;
    try {
      const gcs = typeof getComputedStyle === 'function' ? getComputedStyle : null;
      if (gcs) {
        const cs = gcs(container);
        if (cs) pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      }
    } catch (e) {}
    return Math.max(0, container.clientWidth - pad - FIT_MARGIN);
  }

  /** 由「页面在 scale=1 时的宽度」推算贴合左栏所需比例；容器过窄时返回 null（不强行缩放） */
  function computeFitScaleFromWidth(unscaledWidth) {
    if (!(unscaledWidth > 0)) return null;
    const avail = getAvailablePaneWidth();
    if (!(avail > FIT_MIN_CONTENT_WIDTH)) return null;
    return clampFitScale(avail / unscaledWidth);
  }

  function updateFitButtonState() {
    if (!dom.zoomFitBtn) return;
    dom.zoomFitBtn.classList.toggle('auto-fit-on', autoFitEnabled);
    dom.zoomFitBtn.title = autoFitEnabled
      ? '已开启：PDF 自动适应窗口宽度（可继续 Ctrl+滚轮手动缩放）'
      : '适合宽度：当前为手动缩放，点击恢复自动适应';
  }

  /** 用户手动缩放后关闭自动适应，否则下一次容器变化就会把手动比例冲掉 */
  function markManualZoom() {
    if (!autoFitEnabled) return;
    autoFitEnabled = false;
    updateFitButtonState();
  }

  /** 按当前容器宽度贴合一次（异步版：首次渲染前拿到未缩放宽度时用） */
  async function applyAutoFit() {
    if (!autoFitEnabled || !pdfDoc) return;
    let unscaledWidth = renderedUnscaledWidth;
    if (!(unscaledWidth > 0)) {
      try {
        const page = await pdfDoc.getPage(currentPage);
        unscaledWidth = page.getViewport({ scale: 1.0 }).width;
      } catch (e) {
        return;
      }
    }
    const fit = computeFitScaleFromWidth(unscaledWidth);
    if (fit === null) return;
    if (Math.abs(fit - currentScale) > 0.003) {
      currentScale = fit;
      updateZoomLabel();
    }
    renderPage(currentPage);
  }

  /** 监听左栏尺寸变化：拖分割线/改窗口/展开侧栏都会触发 */
  function setupAutoFitResize() {
    if (!dom.pdfPane || dom.pdfPane._autoFitObserved) return;
    dom.pdfPane._autoFitObserved = true;

    const onPaneResize = () => {
      // 手动缩放模式下不动用户的比例
      const fit = computeFitScaleFromWidth(renderedUnscaledWidth);
      if (autoFitEnabled && fit !== null) {
        // 拖动过程中先用 CSS transform 给即时视觉反馈（重渲染开销大，放到停稳之后）
        currentScale = fit;
        updateZoomLabel();
        const wrapper = document.getElementById(`pageWrapper_${currentPage}`);
        if (wrapper && renderedScale > 0) {
          wrapper.style.transform = `scale(${fit / renderedScale})`;
          wrapper.style.transformOrigin = 'top center';
          wrapper.style.transition = 'none';
        }
        clearTimeout(autoFitResizeTimer);
        autoFitResizeTimer = setTimeout(() => {
          if (autoFitEnabled) applyAutoFit();
        }, 220);
      }
      updateFitButtonState();
    };

    if (typeof ResizeObserver !== 'undefined') {
      // 用 ResizeObserver 而不是 window.resize：拖动分割线并不改变窗口尺寸，
      // 但它会改变左栏宽度，window.resize 完全收不到这个事件。
      const ro = new ResizeObserver(onPaneResize);
      ro.observe(dom.pdfPane);
      window._academicAutoFitObserver = ro;
    } else {
      window.addEventListener('resize', onPaneResize);
    }
    updateFitButtonState();
  }

  function zoomBy(step) {
    markManualZoom();
    const newScale = Math.min(3.5, Math.max(0.5, Math.round((currentScale + step) * 100) / 100));
    if (Math.abs(newScale - currentScale) < 0.01) return;
    currentScale = newScale;
    updateZoomLabel();

    const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);
    if (pageWrapper && renderedScale > 0) {
      const ratio = currentScale / renderedScale;
      pageWrapper.style.transform = `scale(${ratio})`;
      pageWrapper.style.transformOrigin = 'top center';
      pageWrapper.style.transition = 'none';
    }

    clearTimeout(wheelZoomTimer);
    wheelZoomTimer = setTimeout(() => {
      renderPage(currentPage);
    }, 160);
  }

  dom.zoomInBtn.addEventListener('click', () => {
    zoomBy(0.2);
  });
  dom.zoomOutBtn.addEventListener('click', () => {
    zoomBy(-0.2);
  });
  dom.zoomFitBtn.addEventListener('click', () => {
    // 「适合宽度」= 重新进入自动适应模式，此后跟随左栏宽度
    autoFitEnabled = true;
    updateFitButtonState();
    applyAutoFit();
  });

  function updateZoomLabel() {
    dom.zoomPercent.textContent = `${Math.round(currentScale * 100)}%`;
  }

  // ====================== 支持按住 Ctrl 滚动鼠标滚轮平滑缩放 PDF ======================
  let wheelZoomTimer = null;
  const handleCtrlWheelZoom = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    markManualZoom();

    // 缩放步长计算：传统滚轮向上滚动为负(放大)，向下滚动为正(缩小)
    let delta = 0;
    if (Math.abs(e.deltaY) >= 40) {
      // 鼠标格档滚动：固定 ±0.12 步长，保证滚轮来回滚动严格对称
      delta = e.deltaY < 0 ? 0.12 : -0.12;
    } else {
      // 笔记本触控板平滑捏合/捏放 (Pinch-to-zoom)
      delta = -e.deltaY * 0.008;
    }

    const newScale = Math.min(4.0, Math.max(0.4, Math.round((currentScale + delta) * 100) / 100));
    if (Math.abs(newScale - currentScale) < 0.01) return;

    const container = dom.pdfViewerContainer;
    const pageWrapper = document.getElementById(`pageWrapper_${currentPage}`);

    if (container && pageWrapper) {
      const containerRect = container.getBoundingClientRect();
      const mouseX = e.clientX - containerRect.left;
      const mouseY = e.clientY - containerRect.top;

      const scrollX = container.scrollLeft;
      const scrollY = container.scrollTop;

      const scaleRatio = newScale / currentScale;

      currentScale = newScale;
      updateZoomLabel();

      // 60fps 瞬间响应：通过 CSS transform 进行平滑视觉拉伸
      const visualRatio = currentScale / renderedScale;
      pageWrapper.style.transform = `scale(${visualRatio})`;
      pageWrapper.style.transformOrigin = 'top center';
      pageWrapper.style.transition = 'none';

      // 保持鼠标所指文档位置稳定不变
      container.scrollLeft = Math.max(0, (scrollX + mouseX) * scaleRatio - mouseX);
      container.scrollTop = Math.max(0, (scrollY + mouseY) * scaleRatio - mouseY);
    } else {
      currentScale = newScale;
      updateZoomLabel();
    }

    // 200ms 防抖重绘，高保真矢量重新栅格化并无缝替换
    clearTimeout(wheelZoomTimer);
    wheelZoomTimer = setTimeout(() => {
      renderPage(currentPage);
    }, 200);
  };

  // 全局捕获监听，防止 VSCode 拦截滚轮或页面默认缩放
  window.addEventListener('wheel', handleCtrlWheelZoom, { passive: false, capture: true });
  document.addEventListener('wheel', handleCtrlWheelZoom, { passive: false, capture: true });
  if (dom.pdfPane) dom.pdfPane.addEventListener('wheel', handleCtrlWheelZoom, { passive: false, capture: true });
  if (dom.pdfViewerContainer) dom.pdfViewerContainer.addEventListener('wheel', handleCtrlWheelZoom, { passive: false, capture: true });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomBy(0.15);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomBy(-0.15);
      } else if (e.key === '0') {
        e.preventDefault();
        markManualZoom();
        currentScale = 1.0;
        updateZoomLabel();
        renderPage(currentPage);
      }
    }
  });

  dom.translateAllBtn.addEventListener('click', () => {
    switchTab('trans');
    if (!currentParagraphs || currentParagraphs.length === 0) return;
    vscode.postMessage({ type: 'showInfo', message: `正在使用大模型并行翻译第 ${currentPage} 页所有段落...` });
    currentParagraphs.forEach((para) => {
      triggerParagraphTranslate(currentPage, para, false);
    });
  });

  // 「视觉重排」手动按钮已移除：视觉判断在每一页渲染时默认就做（见 buildAcademicLayout 的调度）。
  // 想重判某一页 → 换一个视觉模型（设置 academicReader.visionModel），缓存会自动判废重判；
  // 想完全不要视觉改写分段 → 关掉 academicReader.visionSurgery。

  dom.refreshTransBtn.addEventListener('click', () => {
    switchTab('trans');
    if (!currentParagraphs || currentParagraphs.length === 0) return;
    vscode.postMessage({ type: 'showInfo', message: `正在重新翻译第 ${currentPage} 页所有段落...` });
    currentParagraphs.forEach((para) => {
      triggerParagraphTranslate(currentPage, para, true);
    });
  });

  dom.exportNotesBtn.addEventListener('click', () => {
    // 交给宿主弹一个小菜单：① 全文双语精读稿（Markdown） ② 高光批注 PDF
    vscode.postMessage({ type: 'exportNotes' });
  });

  const handleOpenSettings = () => {
    vscode.postMessage({ type: 'openSettings' });
  };
  if (dom.openSettingsBtn) dom.openSettingsBtn.addEventListener('click', handleOpenSettings);
  if (dom.btnSettingsRightPane) dom.btnSettingsRightPane.addEventListener('click', handleOpenSettings);

  // ====================== 可拖拽分栏 (Splitter) ======================
  let isDraggingSplitter = false;
  dom.splitter.addEventListener('mousedown', () => {
    isDraggingSplitter = true;
    dom.splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDraggingSplitter) return;
    const containerWidth = document.querySelector('.main-container').clientWidth;
    const newRightWidth = containerWidth - e.clientX;
    if (newRightWidth > 260 && newRightWidth < containerWidth * 0.75) {
      dom.rightPane.style.width = `${newRightWidth}px`;
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDraggingSplitter) {
      isDraggingSplitter = false;
      dom.splitter.classList.remove('dragging');
      document.body.style.cursor = 'default';
    }
  });

  function escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ====================== AI 学术文献导师深度问答模块 (AI Assistant) ======================
  let currentAiContext = {
    selectedText: '',
    contextText: '',
    page: 1,
    noteType: '疑难待查'
  };

  /** 真·多轮对话历史：追问时会一并送给模型（旧版每次提问都是孤立的） */
  let aiConversation = [];
  /** 当前正在进行或已完成的请求：requestId -> 回调与累积文本 */
  const aiPending = new Map();
  let aiLastModel = '';
let aiEngineIsOpenAI = false;
/** 当前上下文的预设分析问题：只预填、不自动发送，由「开始分析」按钮触发 */
let aiPresetQuestion = '';
  /** 当前翻译引擎标识（扩展侧下发），参与段落缓存键，切换引擎即失效 */
  let currentEngineTag = '';

  /**
   * 行内 Markdown。关键点：**先转义纯文本、再插入标签**。
   * 旧实现是「先整体 escapeHtml 再正则替换」，导致 `>` 引用变成 &gt;、
   * 代码块里的 `**` 被误加粗、$公式$ 被吃掉。
   */
  /**
   * 把文里的数学片段渲染成真正的公式（KaTeX，本地打包）。
   *
   * 支持的写法：`$$...$$`（独立公式）、`$...$`（行内）、`\[...\]`、`\(...\)`。
   * 渲染失败**绝不吞掉**原文：退回等宽样式显示原始写法（旧行为），
   * 因为"公式看不见"比"公式没排版"严重得多。
   */
  function renderMathSpan(tex, displayMode) {
    const src = String(tex == null ? '' : tex).trim();
    if (!src) return '';
    const katex = typeof window !== 'undefined' ? window.katex : undefined;
    if (katex && typeof katex.renderToString === 'function') {
      try {
        const html = katex.renderToString(src, {
          displayMode: !!displayMode,
          throwOnError: false, // 语法有误也渲染出可读结果，而不是整块消失
          strict: false,
          trust: false,
          output: 'html'
        });
        return `<span class="md-math-rendered${displayMode ? ' md-math-display' : ''}">${html}</span>`;
      } catch (e) {
        /* 落到下面的原样显示 */
      }
    }
    const escaped = escapeHtml(displayMode ? `$$${src}$$` : `$${src}$`);
    return `<span class="md-math md-math-fallback">${escaped}</span>`;
  }

  /**
   * 文本层公式残渣的兜底识别与转写。
   *
   * 【为什么需要它】PDF 抽出来的公式永远是残渣形式（`Y ̂ t`、`Y 1`、`Y^t`），
   * 原文侧不可能有 `$...$`；视觉模型给的替换表只覆盖它标注到的那几处（实测第 5 页 8 段里
   * 只有 2 段给了表），老译文里抄下来的残渣同样没表可查。于是总有一些"漏掉"。
   * 而残渣的形态其实很规则，可以确定性转写，且**误伤风险极低**：
   *   · 组合抑扬符（U+0302/0303）出现在正文里，几乎只可能是公式残渣；
   *   · 单个大写字母 + 空格 + 1~2 位数字（`Y 1`）在学术中文/英文里就是下标写法；
   *   · ASCII 上标（`Y^t`、`x^2`）。
   * 所以这三类一律转成 LaTeX——比"等模型给表"可靠，也比"不渲染"好。
   */
  const RESIDUE_HAT_RE = /([A-Za-z])((?:\s*[\u0302\u0303])+)(\s*(?:[A-Za-z]|\d{1,2}))?/g;
  const RESIDUE_CARET_RE = /(?<![A-Za-z0-9\\])([A-Za-z])\^(\{[^}]{1,14}\}|[A-Za-z0-9]{1,4})/g;
  /*
   * 裸下标（`Y 1`、`X t`）的判据要**故意收紧**，否则会误伤普通英文：
   *   · 只认**大写**字母——"a 2-fold increase" 里的 "a 2" 不是变量；
   *   · 后面不许紧跟小数点/百分号/连字符——"A 2.5%"、"a 2-fold" 都不该转；
   *   · 下标只取一个 token（1~2 位数字或单个小写字母），
   *     不吞逗号列表：`Y ̂ 1, Y 1` 里的 "1, Y" 会被错当成下标（实测踩过 `_{1,Y}`）。
   */
  const RESIDUE_SUB_RE = /(?<![A-Za-z0-9])([A-Z])\s(\d{1,2}|[a-z])(?![A-Za-z0-9.%-])/g;

  /** 把残渣的各个片段拼成 LaTeX（帽子可能叠两层，实测出现过 "Y ̂ ̂"） */
  function residueToLatex(letter, hatCount, sub) {
    let core = letter;
    for (let i = 0; i < hatCount; i++) core = `\\hat{${core}}`;
    const token = String(sub || '').replace(/\s+/g, '');
    return token ? `${core}_{${token}}` : core;
  }

  /** 纯文本里夹 $...$ / $$...$$ / \(...\) / \[...\] 的渲染（先转义纯文本，再把公式塞回去） */
  function renderTextWithMath(text) {
    const maths = [];
    let s = escapeHtml(String(text == null ? '' : text));
    const stash = (tex, display) => {
      maths.push(renderMathSpan(tex, display));
      return `\u0000M${maths.length - 1}\u0000`;
    };
    s = s.replace(/\$\$([^$]+?)\$\$/g, (m, tex) => stash(tex, true));
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => stash(tex, true));
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => stash(tex, false));
    /*
     * 单个 $...$：必须成对、不跨行，**且内容确实像公式**（否则 "价格 $5 和 $6" 会被当成公式）。
     *
     * 这里还要处理两种"看起来像公式、其实不该/不该拆"的情况：
     *   ① 内容只是**一个字母**（`$N$`、`$t$`）：模型会把散文里的变量名也包起来，
     *      而 KaTeX 的斜体夹在中文里很扎眼，用户明确要求"单独的 N 就按文字处理"→ 去掉定界符、按普通文字显示。
     *   ② 公式后面紧跟着**上标写法**（`$\hat{Y}_t$^N`）：那是同一个符号被拆成了两半
     *      （模型只把主体包进 $...$），要**折进同一个公式**成 $\hat{Y}_t^{N}$，
     *      否则界面上会看到"一个排版好的 Ŷ_t"外加一个吊在外面的 N。
     */
    s = s.replace(
      /\$([^$\n]+?)\$(\s*\^\s*(?:\{[^}]{1,14}\}|[A-Za-z0-9]{1,3}))?/g,
      (m, tex, sup) => {
        if (!looksLikeMath(tex)) return m;
        const bare = String(tex).trim();
        if (/^[A-Za-z]$/.test(bare) && !sup) return bare; // ① 单字母 → 普通文字
        if (sup) {
          const inner = String(sup).replace(/^\s*\^\s*/, '').replace(/^\{|\}$/g, '');
          return stash(`${bare}^{${inner}}`, false);
        }
        return stash(tex, false);
      }
    );

    /*
     * 兜底：文本层残渣（顺序很重要——帽子优先，它最不可能是普通文本；
     * 剩下的裸下标再处理，避免 "Y ̂ t" 被下标规则先吃掉一半）。
     */
    s = s.replace(RESIDUE_HAT_RE, (m, letter, hats, sub) => {
      const hatCount = (hats.match(/[\u0302\u0303]/g) || []).length || 1;
      return `<span class="vision-residue-math" title="按文本层残渣转写的公式（原文侧没有 LaTeX 写法）">${renderMathSpan(
        residueToLatex(letter, hatCount, sub),
        false
      )}</span>`;
    });
    s = s.replace(RESIDUE_CARET_RE, (m, letter, exp) =>
      `<span class="vision-residue-math" title="按文本层残渣转写的公式（原文侧没有 LaTeX 写法）">${renderMathSpan(
        `${letter}^{${String(exp).replace(/^\{|\}$/g, '')}}`,
        false
      )}</span>`
    );
    s = s.replace(RESIDUE_SUB_RE, (m, letter, sub) =>
      `<span class="vision-residue-math" title="按文本层残渣转写的公式（原文侧没有 LaTeX 写法）">${renderMathSpan(
        `${letter}_{${sub}}`,
        false
      )}</span>`
    );

    return s.replace(/\u0000M(\d+)\u0000/g, (m, i) => maths[Number(i)]);
  }

  /** 这段内容看起来像公式吗（用于行内 `$...$` 的取舍，避免把普通文本当公式） */
  function looksLikeMath(tex) {
    const t = String(tex == null ? '' : tex).trim();
    if (!t) return false;
    if (/[\\^_{}=]/.test(t)) return true;
    return /^[A-Za-z]{1,3}$/.test(t); // "$R$" / "$x$" 这种单字母变量
  }

  /**
   * 这段文字像"公式残渣"（而不是一句散文）吗？判据与 isFormulaLikePara 同源：
   * 符号/数字占主导、字母很少。用于决定"很长的一条 find 要不要照渲染"。
   */
  function looksLikeMathResidue(s) {
    const t = String(s == null ? '' : s);
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const symbols = (t.match(/[=+\-*/^_{}[\]()<>≤≥≈≠∈∑∫∂∇×·|\\]/g) || []).length;
    const digits = (t.match(/\d/g) || []).length;
    const denom = letters + symbols + digits;
    if (denom === 0) return false;
    return (symbols + digits) / denom >= 0.35;
  }

  /**
   * 英文原文里的行内公式渲染（**只影响显示**：charMap 坐标与送翻译的原文都不变，
   * 所以划线高亮、点中文跳英文、逐句对齐一律不受影响）。
   *
   * 两个来源：① 视觉模型给的替换表（find = 文本层残渣写法，latex = 可渲染写法）；
   * ② 文本里本来就写成 $...$ / \(...\) 的。
   * 替换表是先按 find 在原文里定位、再按区间拼接，所以绝不会动到定位之外的字。
   */
  function renderEnTextHtml(text, inline) {
    const src = String(text == null ? '' : text);
    if (!src) return '';
    const cands = [];
    (Array.isArray(inline) ? inline : []).forEach(item => {
      const find = item && item.find ? String(item.find) : '';
      const latex = item && item.latex ? String(item.latex) : '';
      if (!find || !latex || find.length < 2) return;
      // 过长的 find 会把"逐字替换"变成"整句重排"（实测模型会这么标）→ 一般直接不采纳。
      // 但**纯公式残渣**是例外：模型常把一整条公式（如 "{ Y 1 } { Y i | i ∈ [2, t − 1] }"）
      // 当成一个 find 给出来 —— 那正是"该被渲染成公式"的东西，长度不该拦它。
      // 真正要拦的是"一句散文被整句替换成一条公式"。
      const maxFind = Math.min(30, Math.max(8, src.length * 0.5));
      if (find.length > maxFind && !(find.length <= 120 && looksLikeMathResidue(find))) return;
      const at = locateAnchorIndex(src, find, 0);
      if (at < 0) return;
      cands.push({ start: at, end: at + find.length, latex, len: find.length });
    });
    /*
     * 【最长匹配优先】同一个位置经常有长短两条替换表——例如 "Y ̂ t"（来自上一段）
     * 与 "Y ̂ t − 1"（本段，更精确）。若按列表顺序取，短的那条会先命中、把更精确的长条目
     * 挤掉：实测 Ŷ_{t−1} 只渲染成了 Ŷ_t，后面还吊着一个裸的 "− 1"。
     * 所以先按"长的优先"接受，再按位置组装。
     */
    cands.sort((a, b) => b.len - a.len || a.start - b.start);
    const reps = [];
    cands.forEach(c => {
      if (reps.some(r => c.start < r.end && c.end > r.start)) return;
      reps.push(c);
    });
    reps.sort((a, b) => a.start - b.start);
    /*
     * 替换区间后面**紧跟着裸上标**时（`$\hat{Y}_t$^N` / 视觉表的 `Y ̂ t` + `^N`），
     * 把它并进同一条公式——那是同一个符号被拆成了两半；
     * 不并的话界面上就是"一个排版好的 Ŷ_t"外加一个吊在外面的 N（用户实测反馈）。
     * 只认带 `^` 的写法，裸的 " N" 不碰（那更像散文里的变量名）。
     */
    reps.forEach((r, i) => {
      const next = reps[i + 1];
      const limit = next ? next.start : src.length;
      const m = /^\s*\^\s*(\{[^}]{1,14}\}|[A-Za-z0-9]{1,3})/.exec(src.slice(r.end));
      if (!m) return;
      const end = r.end + m[0].length;
      if (end > limit) return; // 越到下一个替换区间里去了 → 不动
      r.end = end;
      r.latex = `${String(r.latex).trim()}^{${m[1].replace(/^\{|\}$/g, '')}}`;
    });
    if (reps.length === 0) return renderTextWithMath(src);

    let out = '';
    let cursor = 0;
    reps.forEach(r => {
      out += renderTextWithMath(src.slice(cursor, r.start));
      out += `<span class="vision-inline-math" title="行内公式（视觉模型从页面图像转写，仅影响显示）">${renderMathSpan(
        r.latex,
        false
      )}</span>`;
      cursor = r.end;
    });
    out += renderTextWithMath(src.slice(cursor));
    return out;
  }

  function renderInlineMarkdown(text) {
    let s = escapeHtml(text || '');

    // 行内代码先抽出占位，避免其中的 * _ 被当作强调语法
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return `\u0000C${codes.length - 1}\u0000`;
    });

    // 数学公式也先抽成占位：① 避免 KaTeX 生成的 HTML 被后续转义/强调语法破坏
    // ② 顺序必须在 escapeHtml 之后（此时 $ 仍是原文的 $）
    const maths = [];
    const stashMath = (tex, displayMode) => {
      maths.push(renderMathSpan(tex, displayMode));
      return `\u0000M${maths.length - 1}\u0000`;
    };
    s = s.replace(/\$\$([^$]+?)\$\$/g, (m, tex) => stashMath(tex, true));
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => stashMath(tex, true));
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => stashMath(tex, false));
    // 单个 $ 必须成对且不跨行：避免把 "价格 $5 和 $6" 这种误当公式
    s = s.replace(/\$([^$\n]+?)\$/g, (m, tex) => stashMath(tex, false));

    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
    );

    s = s.replace(/\u0000M(\d+)\u0000/g, (m, i) => maths[Number(i)]);
    s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => `<code class="md-code">${codes[Number(i)]}</code>`);
    return s;
  }

  /** 块级 Markdown 渲染（标题/列表/引用/代码块/分隔线/段落） */
  function renderMarkdownToHtml(md) {
    if (!md) return '';
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let listBuf = null;
    let paraBuf = [];

    const flushList = () => {
      if (!listBuf) return;
      out.push(
        `<${listBuf.type} class="md-list">` +
          listBuf.items.map(t => `<li>${renderInlineMarkdown(t)}</li>`).join('') +
          `</${listBuf.type}>`
      );
      listBuf = null;
    };
    const flushPara = () => {
      if (paraBuf.length === 0) return;
      out.push(`<p>${renderInlineMarkdown(paraBuf.join(' '))}</p>`);
      paraBuf = [];
    };
    const flushAll = () => {
      flushList();
      flushPara();
    };

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // 围栏代码块
      if (/^```/.test(trimmed)) {
        flushAll();
        const lang = trimmed.replace(/^```/, '').trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        out.push(
          `<pre class="md-pre"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(
            buf.join('\n')
          )}</code></pre>`
        );
        continue;
      }

      if (!trimmed) {
        flushAll();
        i++;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        flushAll();
        out.push('<hr class="md-hr">');
        i++;
        continue;
      }

      const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushAll();
        const level = Math.min(6, h[1].length + 1);
        out.push(`<h${level} class="md-h${level}">${renderInlineMarkdown(h[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        flushAll();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          buf.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        out.push(`<blockquote class="md-quote">${renderMarkdownToHtml(buf.join('\n'))}</blockquote>`);
        continue;
      }

      const ol = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
      const ul = trimmed.match(/^[-*+]\s+(.*)$/);
      if (ol || ul) {
        flushPara();
        const type = ol ? 'ol' : 'ul';
        if (!listBuf || listBuf.type !== type) {
          flushList();
          listBuf = { type, items: [] };
        }
        listBuf.items.push(ol ? ol[2] : ul[1]);
        i++;
        continue;
      }

      paraBuf.push(trimmed);
      i++;
    }

    flushAll();
    return out.join('');
  }

  /** 把对话历史整理成模型可接受的形式（合并连续同角色，避免请求被拒） */
  function buildAiHistory() {
    const turns = [];
    aiConversation.forEach(t => {
      if (!t || !t.text || t.error) return;
      const role = t.role === 'model' ? 'model' : 'user';
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.text += `\n\n${t.text}`;
      else turns.push({ role, text: t.text });
    });
    while (turns.length && turns[0].role !== 'user') turns.shift();
    return turns.slice(-8);
  }

  function setAiLoading(on, text) {
    const loadingEl = dom.aiModalLoading || document.getElementById('aiModalLoading');
    if (!loadingEl) return;
    loadingEl.style.display = on ? 'flex' : 'none';
    const txt = loadingEl.querySelector('.ai-loading-text');
    if (txt && text) txt.textContent = text;
  }

  function setAiStreaming(on) {
    const sendBtn = dom.btnSendAiModalQuestion || document.getElementById('btnSendAiModalQuestion');
    const stopBtn = dom.btnStopAiModalQuestion || document.getElementById('btnStopAiModalQuestion');
    if (sendBtn) sendBtn.disabled = on;
    if (stopBtn) stopBtn.style.display = on ? 'inline-flex' : 'none';
  }

  /** 重新渲染整段对话（刻意保持朴素：无气泡、无 emoji、无配色强调） */
  function renderAiTranscript() {
    const wrap = dom.aiModalTranscript || document.getElementById('aiModalTranscript');
    if (!wrap) return;

    if (aiConversation.length === 0) {
      wrap.innerHTML =
        '<div class="ai-transcript-empty">可直接提问，或点上面的快捷提问。有预设分析时点「开始分析」——打开本窗口不会自动发起提问。</div>';
      return;
    }

    wrap.innerHTML = aiConversation
      .map((turn, idx) => {
        if (turn.role === 'user') {
          return `<div class="ai-turn ai-turn-user" data-turn-idx="${idx}">
            <div class="ai-turn-role">你</div>
            <div class="ai-turn-body">${renderInlineMarkdown(turn.text)}</div>
          </div>`;
        }
        const body = turn.error
          ? `<div class="ai-turn-body ai-turn-error">${escapeHtml(turn.text)}</div>`
          : `<div class="ai-turn-body markdown-body">${renderMarkdownToHtml(turn.text)}</div>`;
        const actions =
          turn.streaming || turn.error
            ? ''
            : `<div class="ai-turn-actions">
              <button type="button" data-ai-copy="${idx}" title="复制这条回答">复制</button>
              <button type="button" data-ai-note="${idx}" title="保存为聚焦原句的批注笔记">存为批注</button>
              <button type="button" data-ai-regen="${idx}" title="用同样的问题重新问一次">重答</button>
            </div>`;
        const note = turn.note ? `<div class="ai-turn-note">${escapeHtml(turn.note)}</div>` : '';
        const metaTitle = turn.meta ? ` title="${escapeHtml(turn.meta)}"` : '';
        return `<div class="ai-turn ai-turn-model${
          turn.streaming ? ' ai-turn-streaming' : ''
        }" data-turn-idx="${idx}"${metaTitle}>
          <div class="ai-turn-role">AI</div>
          ${body}
          ${note}
          ${actions}
        </div>`;
      })
      .join('');

    wrap.scrollTop = wrap.scrollHeight;
  }

  /** 流式增量：只更新最后一条回答，避免整段对话重排 */
  function updateStreamingTurn() {
    const wrap = dom.aiModalTranscript || document.getElementById('aiModalTranscript');
    if (!wrap) return;
    const el = wrap.querySelector('.ai-turn-model.ai-turn-streaming');
    if (!el) return;
    const body = el.querySelector('.ai-turn-body');
    if (!body) return;
    const text = aiStreamingTurn ? aiStreamingTurn.text : '';
    body.innerHTML = text
      ? renderMarkdownToHtml(text)
      : '<span class="ai-typing"><span></span><span></span><span></span></span>';
    wrap.scrollTop = wrap.scrollHeight;
  }

  let aiStreamingTurn = null;
  let aiCurrentRequestId = '';

  function openAiAssistantModal(options = {}) {
    ensureAllToolbarsExist();
    const modal = dom.aiAssistantModal || document.getElementById('aiAssistantModal');
    if (!modal) return;

    const prevKey = `${currentAiContext.page}|${currentAiContext.selectedText}`;
    currentAiContext = {
      selectedText: options.selectedText || '',
      contextText: options.contextText || options.selectedText || '',
      page: options.page || currentPage,
      noteType: options.noteType || '疑难待查'
    };
    const newKey = `${currentAiContext.page}|${currentAiContext.selectedText}`;
    const contextChanged = prevKey !== newKey;

    // 聚焦对象换了 → 开新话题；同一个对象 → 保留对话，方便连续追问
    if (!options.keepConversation && contextChanged) {
      aiConversation = [];
    }

    // 预设的分析问题只**预填**到输入框，不再自动发送：
    // 很多时候读者只是想回来翻一下之前的问答，一打开就烧 token 去"深度剖析"既费钱又碍事。
    aiPresetQuestion = options.presetQuestion || '';

    const quoteEl = dom.aiModalQuote || document.getElementById('aiModalQuote');
    if (quoteEl) {
      quoteEl.textContent =
        currentAiContext.selectedText ||
        currentAiContext.contextText ||
        '(未选定特定句子，将基于当前上下文解答)';
    }

    const input = dom.aiModalQuestionInput || document.getElementById('aiModalQuestionInput');
    if (input) {
      // 已有对话时留空，方便直接追问；新话题才预填分析问题
      input.value = aiConversation.length > 0 ? '' : aiPresetQuestion;
    }
    // 有预设分析问题时，把它显示成一颗快捷提问芯片（原先那个「开始分析」按钮已移除：
    // 它与「发送」重复，而且会无视用户在输入框里的修改）
    renderPresetChip(dom.aiAssistantModal || document.getElementById('aiAssistantModal'), aiPresetQuestion);

    renderAiTranscript();
    setAiLoading(false);
    setAiStreaming(aiPending.size > 0);

    vscode.postMessage({ type: 'requestModelInfo' });

    modal.style.display = 'flex';
    modal.style.zIndex = '1000000';
    bindAiAssistantModalEvents();

    if (input) input.focus();
    // 注意：这里**不再**主动调用 sendAiModalQuestion。
    // 只有调用方显式要求自动发送时才会发问（保留该开关供将来自动化场景使用）。
    if (options.autoSend === true) {
      sendAiModalQuestion(aiPresetQuestion || (input ? input.value : ''));
    }
  }

  // ====================== 回答风格切换（所有 AI 入口共用一份定义） ======================
  /**
   * 三档风格的**定义已前移到文件顶部**（AI_STYLES，必须早于任何调用点，
   * 否则初始化阶段会因暂时性死区报错）。这里只放行为函数。
   *
   * 为什么要共用：AI 提问有两个入口（问答弹窗、批注卡片的「AI 提问」栏），
   * 之前把按钮硬编码在弹窗 HTML 里，批注入口就漏掉了——用户从批注点进去没有切换控件。
   * 现在任何新增的 AI 入口只要 append 一个 createAiStyleSwitch() 即可，不会再漏。
   */

  /** 切换风格：立即生效（本地 aiStyle）+ 写回设置（重载后保留） */
  function applyAiStyle(style) {
    const valid = AI_STYLES.some(s => s.key === style);
    const next = valid ? style : 'standard';
    aiStyle = next;
    syncAiStyleButtons();
    vscode.postMessage({ type: 'setAnswerStyle', style: next });
    const item = AI_STYLES.find(s => s.key === next) || AI_STYLES[1];
    showReaderToast(`回答风格：${item.label}（${item.tip}）`);
  }

  /** 生成一个「回答风格」切换控件；可反复调用，多处入口共用样式与逻辑 */
  function createAiStyleSwitch() {
    const wrap = document.createElement('div');
    wrap.className = 'ai-style-switch';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', '回答风格');
    wrap.innerHTML =
      '<span class="ai-style-label">回答风格</span>' +
      AI_STYLES.map(s => `<button type="button" class="ai-style-btn" data-style="${s.key}" title="${s.tip}">${s.label}</button>`).join('');
    wrap.querySelectorAll('.ai-style-btn').forEach(btn => {
      btn.onclick = () => applyAiStyle(btn.getAttribute('data-style'));
    });
    syncAiStyleButtons();
    return wrap;
  }

  /** 让所有入口的风格按钮都高亮当前档位 */
  function syncAiStyleButtons() {
    const cur = aiStyle || 'standard';
    document.querySelectorAll('.ai-style-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-style') === cur);
    });
  }

  // ====================== 右下角提示条（自动消失） ======================
  /**
   * 旧实现走宿主 vscode.window.showInformationMessage：VS Code 的原生通知
   * 不会自己消失，必须手动点叉，高频操作（加高亮、加批注）时很烦。
   * 现在改成 webview 内自绘的提示条：几秒后自动淡出，鼠标悬停暂停计时。
   */
  function ensureReaderToast() {
    if (dom.readerToast && dom.readerToast.isConnected) return dom.readerToast;
    const el = document.createElement('div');
    el.id = 'readerToast';
    el.className = 'reader-toast';
    document.body.appendChild(el);
    dom.readerToast = el;
    return el;
  }

  function hideReaderToast() {
    const box = dom.readerToast;
    if (!box) return;
    box.classList.remove('show');
    setTimeout(() => {
      if (box && !box.classList.contains('show')) box.style.display = 'none';
    }, 220);
  }

  function showReaderToast(text, level) {
    if (!text) return;
    const box = ensureReaderToast();
    box.textContent = text;
    box.className = `reader-toast show${level === 'error' ? ' error' : ''}`;
    box.style.display = 'block';
    // 强制回流，保证连续提示也能重放淡入动画
    void box.offsetWidth;
    box.classList.add('show');

    clearTimeout(readerToastTimer);
    const life = level === 'error' ? 6000 : 3600;
    readerToastTimer = setTimeout(hideReaderToast, life);

    box.onmouseenter = () => clearTimeout(readerToastTimer);
    box.onmouseleave = () => {
      clearTimeout(readerToastTimer);
      readerToastTimer = setTimeout(hideReaderToast, 1000);
    };
    box.onclick = () => {
      clearTimeout(readerToastTimer);
      hideReaderToast();
    };
  }

  function closeAiAssistantModal() {
    const modal = dom.aiAssistantModal || document.getElementById('aiAssistantModal');
    if (modal) modal.style.display = 'none';
  }

  /** 统一的流式提问入口：弹窗与批注气泡共用同一套回调协议 */
  function streamAiQuestion(opts) {
    aiPending.set(opts.requestId, opts);
    vscode.postMessage({
      type: 'requestAiQuestion',
      requestId: opts.requestId,
      question: opts.question,
      selectedText: opts.selectedText || '',
      contextText: opts.contextText || '',
      page: opts.page || currentPage,
      noteType: opts.noteType || '疑难待查',
      answerStyle: aiStyle || '',
      history: opts.history || []
    });
  }

  function sendAiModalQuestion(customQuestion) {
    const input = dom.aiModalQuestionInput || document.getElementById('aiModalQuestionInput');
    const question = ((customQuestion || (input ? input.value : '') || '') + '').trim();

    if (!question) {
      vscode.postMessage({ type: 'showInfo', message: '请输入你的学术疑问，或点击上方快捷提问' });
      return;
    }
    if (aiPending.size > 0) {
      vscode.postMessage({ type: 'showInfo', message: '⏳ 上一条还在回答中，请先点「停止」再提问' });
      return;
    }

    if (input) input.value = '';

    const history = buildAiHistory();
    aiConversation.push({ role: 'user', text: question });
    const modelTurn = { role: 'model', text: '', streaming: true, meta: '' };
    aiConversation.push(modelTurn);
    aiStreamingTurn = modelTurn;
    renderAiTranscript();

    setAiLoading(true, '已发送，正在等待模型响应...');
    setAiStreaming(true);

    const requestId = 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    aiCurrentRequestId = requestId;

    streamAiQuestion({
      requestId,
      question,
      selectedText: currentAiContext.selectedText,
      contextText: currentAiContext.contextText,
      page: currentAiContext.page,
      noteType: currentAiContext.noteType,
      history,
      onStart: () => {
        setAiStreaming(true);
        setAiLoading(true, '模型正在生成回答...');
      },
      onDelta: chunk => {
        setAiLoading(false);
        modelTurn.text += chunk;
        updateStreamingTurn();
      },
      onDone: msg => {
        aiCurrentRequestId = '';
        modelTurn.text = msg.answer || modelTurn.text;
        modelTurn.streaming = false;
        modelTurn.note = msg.note || '';
        const secs = msg.totalMs ? (msg.totalMs / 1000).toFixed(1) : '';
        modelTurn.meta = [
          msg.model,
          msg.ttftMs ? `首字 ${(msg.ttftMs / 1000).toFixed(1)}s` : '',
          secs ? `共 ${secs}s` : ''
        ]
          .filter(Boolean)
          .join(' · ');
        renderAiTranscript();
        setAiLoading(false);
        setAiStreaming(false);
        const tag = dom.aiModalModelTag || document.getElementById('aiModalModelTag');
        if (tag && msg.model) {
          tag.textContent = msg.model;
          tag.classList.remove('ai-model-tag-warn');
        }
      },
      onError: msg => {
        aiCurrentRequestId = '';
        modelTurn.streaming = false;
        modelTurn.error = true;
        modelTurn.text = `⚠️ ${msg.errorText || '回答失败'}`;
        renderAiTranscript();
        setAiLoading(false);
        setAiStreaming(false);
      }
    });
  }

  function stopAiModalQuestion() {
    if (!aiCurrentRequestId) return;
    vscode.postMessage({ type: 'cancelAiQuestion', requestId: aiCurrentRequestId });
    const turn = aiStreamingTurn;
    if (turn && turn.streaming) {
      turn.streaming = false;
      turn.note = '已被你停止（上面是已生成的部分内容）';
      if (!turn.text) turn.text = '_（已停止，未生成内容）_';
      renderAiTranscript();
    }
    aiCurrentRequestId = '';
    aiStreamingTurn = null;
    setAiLoading(false);
    setAiStreaming(false);
  }

  function handleAiQuestionStart(msg) {
    const req = aiPending.get(msg.requestId);
    if (req && req.onStart) req.onStart();
  }

  function handleAiQuestionDelta(msg) {
    const req = aiPending.get(msg.requestId);
    if (req && req.onDelta) req.onDelta(msg.chunk || '');
  }

  function handleAiQuestionDone(msg) {
    const req = aiPending.get(msg.requestId);
    aiPending.delete(msg.requestId);
    // 落盘一条答疑记录：以前 AI 讲解只活在内存里，关掉阅读器就没了。
    // 这里是**所有** AI 入口（问答弹窗 / 批注气泡）的唯一收口，所以不会漏。
    if (req && msg.answer && String(msg.answer).trim()) {
      recordAiQa({
        page: req.page,
        selectedText: req.selectedText || '',
        question: req.question || '',
        answer: msg.answer,
        model: msg.model || '',
        style: req.answerStyle || aiStyle || ''
      });
    }
    if (req && req.onDone) req.onDone(msg);
  }

  function handleAiQuestionError(msg) {
    const req = aiPending.get(msg.requestId);
    aiPending.delete(msg.requestId);
    if (req && req.onError) req.onError(msg);
  }

  function handleModelInfo(msg) {
    aiLastModel = msg.configuredAiModel || msg.configuredModel || '';
    aiEngineIsOpenAI = !!msg.isOpenAI;
    // 回答风格改为由设置项 academicReader.aiAnswerStyle 驱动，弹窗里不再放下拉框
    if (msg.answerStyle) aiStyle = msg.answerStyle;
    // 版面分割引擎（vision / auto / local）
    if (msg.segmentationEngine) visionEngine = msg.segmentationEngine;
    // 视觉手术开关（关掉 = 只改类型/顺序/丢弃，不动分段）
    if (msg.visionSurgery !== undefined) visionSurgeryAllowed = msg.visionSurgery !== false;
    if (msg.visionModel !== undefined) configuredVisionModel = String(msg.visionModel || '');
    syncAiStyleButtons();
    // 引擎标识变化 → 此后段落用新引擎重新翻译（旧引擎的缓存键不再命中）
    if (msg.engineTag && msg.engineTag !== currentEngineTag) {
      currentEngineTag = msg.engineTag;
      console.log('[Viewer] 翻译引擎已变化，段落缓存键切换为', currentEngineTag);
    }
    const tag = dom.aiModalModelTag || document.getElementById('aiModalModelTag');
    // 在弹窗标题旁显示扩展版本号：用户截图时就能确认实际运行的是哪一版，
    // 避免"改了却没生效 / 跑的还是旧版"这类问题反复靠猜。
    // 版本号优先取宿主注入的 window.__EXT_VERSION__（不依赖消息到达），消息里的作为补充。
    const versionEl = document.getElementById('aiModalVersion');
    if (versionEl) {
      const injected = typeof window.__EXT_VERSION__ === 'string' ? window.__EXT_VERSION__ : '';
      const fromMsg = typeof msg.extensionVersion === 'string' ? msg.extensionVersion : '';
      const ver = injected || fromMsg;
      versionEl.textContent = ver ? `v${ver}` : 'v?';
    }
    if (!tag) return;
    // 提示文案跟随引擎：OpenAI 兼容接口走的是 apiKey + modelName，不该提示"设置 Gemini API Key"
    const settingsCmd = '配置学术翻译引擎与 API Key';
    if (!msg.hasKey) {
      tag.textContent = '未配置 API Key';
      tag.classList.add('ai-model-tag-warn');
      tag.title = aiEngineIsOpenAI
        ? `请执行命令「${settingsCmd}」填入自定义大模型 API Key（academicReader.apiKey）`
        : `请执行命令「${settingsCmd}」填入 Google Gemini API Key（academicReader.geminiApiKey）`;
    } else if (msg.listError) {
      tag.textContent = aiLastModel || '模型未知';
      tag.classList.add('ai-model-tag-warn');
      tag.title = `无法获取可用模型列表：${msg.listError}`;
    } else {
      tag.textContent = aiLastModel || '默认模型';
      tag.classList.remove('ai-model-tag-warn');
      tag.title = aiEngineIsOpenAI
        ? `当前使用 OpenAI 兼容接口的模型 ${aiLastModel || '(未设置)'}（端点在设置里配置，点击右上角翻译设置可修改）`
        : `该 Key 下可用于 generateContent 的模型共 ${
            msg.available ? msg.available.length : 0
          } 个（点击右上角的翻译设置可切换）`;
    }
  }

  function regenerateAiAnswer(idx) {
    const turn = aiConversation[idx];
    if (!turn || turn.role !== 'model') return;
    let q = '';
    for (let i = idx - 1; i >= 0; i--) {
      if (aiConversation[i].role === 'user') {
        q = aiConversation[i].text;
        break;
      }
    }
    if (!q) return;
    if (aiPending.size > 0) {
      vscode.postMessage({ type: 'showInfo', message: '⏳ 上一条还在回答中，请先点「停止」' });
      return;
    }
    aiConversation = aiConversation.slice(0, Math.max(0, idx - 1));
    renderAiTranscript();
    sendAiModalQuestion(q);
  }

  function copyAiTurn(idx) {
    const turn = aiConversation[idx];
    if (!turn) return;
    navigator.clipboard
      .writeText(turn.text)
      .then(() => vscode.postMessage({ type: 'showInfo', message: '已复制该条解答' }))
      .catch(() => vscode.postMessage({ type: 'showInfo', message: '复制失败，请手动选择文本复制' }));
  }

  function saveAiTurnAsNote(idx) {
    const turn = aiConversation[idx];
    if (!turn || turn.role !== 'model' || !turn.text) return;
    const text =
      currentAiContext.selectedText ||
      currentAiContext.contextText ||
      `第 ${currentAiContext.page} 页疑难探究`;
    addAnnotation({
      text: text,
      color: 'pink',
      note: `【AI导师解答】\n${turn.text}`,
      page: currentAiContext.page,
      rawRects: [],
      paraIndex: activeFocusPara ? activeFocusPara.id : undefined
    });
    vscode.postMessage({ type: 'showInfo', message: '已保存为【疑难待查】批注笔记！' });
  }

  /** 批注气泡里的「疑点向 AI 提问」：与弹窗共用流式协议 */
  function askAiFromPopover() {
    const quoteEl = dom.annotQuoteText || document.getElementById('annotQuoteText');
    const quoteText = quoteEl ? quoteEl.textContent : '';
    const input = dom.annotTextInput || document.getElementById('annotTextInput');
    const noteText = input ? input.value.trim() : '';

    const hintEl = dom.annotAiStatusHint || document.getElementById('annotAiStatusHint');
    const askBtn = dom.btnAskAiPopover || document.getElementById('btnAskAiPopover');
    const answerBox = dom.annotAiAnswerBox || document.getElementById('annotAiAnswerBox');
    const answerContent = dom.annotAiAnswerContent || document.getElementById('annotAiAnswerContent');

    if (aiPending.size > 0) {
      vscode.postMessage({ type: 'showInfo', message: '⏳ 已有一条问答在进行中，请稍候' });
      return;
    }

    let contextText = quoteText;
    if (currentNoteContext && currentNoteContext.paraId !== undefined) {
      const matchP = currentParagraphs.find(p => p.id === currentNoteContext.paraId);
      if (matchP) contextText = matchP.cleanText;
    } else if (activeFocusPara) {
      contextText = activeFocusPara.cleanText;
    }

    const question = noteText || '请针对这段论文原句给出深度学术解析：核心逻辑、技术动机与关键概念。';
    const requestId = 'ai_popover_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    let acc = '';
    if (hintEl) hintEl.textContent = '已发送，等待模型响应...';
    if (askBtn) askBtn.disabled = true;
    if (answerBox) answerBox.style.display = 'block';
    if (answerContent) {
      answerContent.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
      answerContent._rawAnswer = '';
    }

    streamAiQuestion({
      requestId,
      question,
      selectedText: quoteText,
      contextText: contextText,
      page: (currentNoteContext && currentNoteContext.page) || currentPage,
      noteType: selectedHighlightColor === 'pink' ? '疑难待查' : '文献批注',
      history: [],
      onStart: () => {
        if (hintEl) hintEl.textContent = '模型正在生成...';
      },
      onDelta: chunk => {
        acc += chunk;
        if (hintEl) hintEl.textContent = '正在生成...';
        if (answerContent) {
          answerContent.innerHTML = renderMarkdownToHtml(acc);
          answerContent._rawAnswer = acc;
        }
      },
      onDone: msg => {
        acc = msg.answer || acc;
        if (hintEl) hintEl.textContent = msg.model ? `✅ ${msg.model}` : '完成';
        if (askBtn) askBtn.disabled = false;
        if (answerContent) {
          answerContent.innerHTML = renderMarkdownToHtml(acc);
          answerContent._rawAnswer = acc;
        }
      },
      onError: msg => {
        if (hintEl) hintEl.textContent = '';
        if (askBtn) askBtn.disabled = false;
        if (answerContent) {
          answerContent.innerHTML = `<p class="ai-turn-error">⚠️ 解答失败：${escapeHtml(
            msg.errorText || '未知错误'
          )}</p>`;
        }
      }
    });
  }

  function adoptAiAnswerToNote() {
    const answerContent = dom.annotAiAnswerContent || document.getElementById('annotAiAnswerContent');
    const rawAnswer = answerContent ? (answerContent._rawAnswer || answerContent.innerText) : '';
    if (!rawAnswer) return;

    const input = dom.annotTextInput || document.getElementById('annotTextInput');
    if (input) {
      const cur = input.value.trim();
      const aiSection = `\n\n【AI导师答疑】\n${rawAnswer}`;
      input.value = cur ? `${cur}${aiSection}` : `【AI导师答疑】\n${rawAnswer}`;
      input.focus();
    }

    const pinkBtn = document.querySelector('.annot-color-btn[data-color="pink"]');
    if (pinkBtn) pinkBtn.click();

    vscode.postMessage({ type: 'showInfo', message: '已将 AI 深度解析采纳到批注笔记框中！' });
  }

  function bindAiAssistantModalEvents() {
    const modal = dom.aiAssistantModal || document.getElementById('aiAssistantModal');
    if (!modal || modal._eventsBound) return;
    modal._eventsBound = true;

    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) closeAiAssistantModal();
    });

    const closeBtn = dom.btnCloseAiModal || document.getElementById('btnCloseAiModal');
    if (closeBtn) closeBtn.onclick = closeAiAssistantModal;

    const sendBtn = dom.btnSendAiModalQuestion || document.getElementById('btnSendAiModalQuestion');
    if (sendBtn) sendBtn.onclick = () => sendAiModalQuestion();

    // 「开始分析」按钮已移除（和「发送」重复、且无视输入框里的修改），
    // 预设分析问题改为 .ai-chip-preset 芯片，点击事件在 renderPresetChip 里绑定。

    // 回答风格切换控件（与批注入口共用同一份定义，见 createAiStyleSwitch）
    const styleSlot = document.getElementById('aiModalStyleSlot');
    if (styleSlot && !styleSlot.querySelector('.ai-style-switch')) {
      styleSlot.appendChild(createAiStyleSwitch());
    }
    syncAiStyleButtons();

    const stopBtn = dom.btnStopAiModalQuestion || document.getElementById('btnStopAiModalQuestion');
    if (stopBtn) stopBtn.onclick = stopAiModalQuestion;

    const clearBtn = dom.btnClearAiConversation || document.getElementById('btnClearAiConversation');
    if (clearBtn) {
      clearBtn.onclick = () => {
        if (aiPending.size > 0) {
          vscode.postMessage({ type: 'showInfo', message: '⏳ 请先点「停止」再开新话题' });
          return;
        }
        aiConversation = [];
        renderAiTranscript();
      };
    }

    const input = dom.aiModalQuestionInput || document.getElementById('aiModalQuestionInput');
    if (input) {
      input.onkeydown = e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendAiModalQuestion();
        } else if (e.key === 'Escape') {
          closeAiAssistantModal();
        }
      };
    }

    modal.querySelectorAll('.ai-chip').forEach(chip => {
      chip.onclick = e => {
        e.stopPropagation();
        const q = chip.getAttribute('data-q');
        if (input) input.value = q;
        sendAiModalQuestion(q);
      };
    });

    // 每条回答的「复制 / 存为批注 / 重答」用事件委托，避免重渲染后失效
    const transcript = dom.aiModalTranscript || document.getElementById('aiModalTranscript');
    if (transcript && !transcript._delegated) {
      transcript._delegated = true;
      transcript.addEventListener('click', e => {
        const copyBtn = e.target.closest('[data-ai-copy]');
        if (copyBtn) {
          copyAiTurn(Number(copyBtn.getAttribute('data-ai-copy')));
          return;
        }
        const noteBtn = e.target.closest('[data-ai-note]');
        if (noteBtn) {
          saveAiTurnAsNote(Number(noteBtn.getAttribute('data-ai-note')));
          return;
        }
        const regenBtn = e.target.closest('[data-ai-regen]');
        if (regenBtn) {
          regenerateAiAnswer(Number(regenBtn.getAttribute('data-ai-regen')));
          return;
        }
      });
    }
  }
})();
