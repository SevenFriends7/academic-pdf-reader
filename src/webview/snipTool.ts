/**
 * Interactive PDF Region Snipping & Multimodal Vision Overlay (`src/webview/snipTool.ts`)
 *
 * Usage:
 * - Click toolbar `#snipToolBtn` ("框选识别") or press `Alt+S` to enter snip mode
 * - OR hold `Shift + Left-Drag` on any PDF page at ANY time for instant box-select!
 * - Actions on crop:
 *   1. `∑ 公式转 LaTeX` (Instant offline 2D LaTeX + optional VLM OCR upgrade + KaTeX preview + 1-click copy)
 *   2. `译 区域视觉翻译` (Multimodal visual OCR & translation for complex tables, figures, dense math)
 *   3. `✦ 带图问 AI` (Opens AI Tutor modal with cropped PNG attached + visual preview)
 *   4. `⎘ 复制截图` (Copies crisp high-DPI PNG to clipboard)
 */

import {
  ClassifiedPageVectors,
  DecodedGlyphItem,
  TopDownRect,
} from '../core/types';
import { reconstructMath2D } from '../core/math/mathEngine2D';

export interface PageMathCacheEntry {
  glyphs: DecodedGlyphItem[];
  vectors: ClassifiedPageVectors;
  bodyFontSize: number;
  pageW: number;
  pageH: number;
}

export interface SnipToolBridge {
  getPdfDoc: () => any;
  getCurrentPage: () => number;
  getPageMathCache: (pageNum: number) => PageMathCacheEntry | undefined;
  isVisionConfigured: () => boolean;
  postMessage: (msg: any) => void;
  renderKatexHtml: (latex: string, displayMode: boolean) => string;
  renderMarkdownHtml: (md: string) => string;
  openAiWithImage: (opts: {
    imageDataUrl: string;
    page: number;
    focusMath?: string;
    selectedText?: string;
    presetQuestion?: string;
  }) => void;
}

interface ActiveSnipState {
  pageNum: number;
  pageWrap: HTMLElement;
  pdfRect: TopDownRect;
  cssRect: { left: number; top: number; width: number; height: number };
  imageDataUrl: string;
  localLatex: string;
  localText: string;
  requestId: string;
}

export class PdfSnipToolController {
  private snipModeActive = false;
  private isDragging = false;
  private dragPageWrap: HTMLElement | null = null;
  private dragPageNum = 1;
  private startClientX = 0;
  private startClientY = 0;

  private selectionBoxEl: HTMLDivElement | null = null;
  private popoverEl: HTMLDivElement | null = null;
  private bannerEl: HTMLDivElement | null = null;
  private activeSnip: ActiveSnipState | null = null;
  private streamingBuffer = '';

  constructor(private readonly bridge: SnipToolBridge) {}

  public init(): void {
    const btn = document.getElementById('snipToolBtn');
    if (btn && !btn.getAttribute('data-snip-bound')) {
      btn.setAttribute('data-snip-bound', '1');
      btn.addEventListener('click', () => {
        this.toggleSnipMode();
      });
    }

    const pdfPane =
      document.getElementById('pdfPane') ||
      document.getElementById('pdfViewerContainer') ||
      document.getElementById('pdfContainer') ||
      document.querySelector('.pdf-pane');
    if (pdfPane && !pdfPane.getAttribute('data-snip-pane-bound')) {
      pdfPane.setAttribute('data-snip-pane-bound', '1');
      pdfPane.addEventListener('mousedown', (ev) => this.onMouseDown(ev as MouseEvent), true);
    }

    window.addEventListener('mousemove', (ev) => this.onMouseMove(ev), true);
    window.addEventListener('mouseup', (ev) => this.onMouseUp(ev), true);
    window.addEventListener('keydown', (ev) => {
      if (ev.altKey && (ev.key === 's' || ev.key === 'S')) {
        ev.preventDefault();
        this.toggleSnipMode();
      } else if (ev.key === 'Escape') {
        if (this.isDragging || this.snipModeActive || this.popoverEl) {
          this.cancelActiveSnip();
          this.setSnipMode(false);
        }
      }
    });
  }

  public isActive(): boolean {
    return this.snipModeActive;
  }

  public toggle(on?: boolean): void {
    this.setSnipMode(typeof on === 'boolean' ? on : !this.snipModeActive);
  }

  public toggleSnipMode(): void {
    this.setSnipMode(!this.snipModeActive);
  }

  public setSnipMode(on: boolean): void {
    this.snipModeActive = on;
    const btn = document.getElementById('snipToolBtn');
    if (btn) btn.classList.toggle('active', on);
    document.body.classList.toggle('snip-mode-active', on);

    if (on) {
      this.showModeBanner('框选模式：在左侧 PDF 拖拽框选公式、表格或架构图（Esc 退出，平时也可直接按住 Shift+左键拖拽）');
    } else {
      this.hideModeBanner();
    }
  }

  private showModeBanner(msg: string): void {
    if (!this.bannerEl) {
      this.bannerEl = document.createElement('div');
      this.bannerEl.className = 'snip-mode-banner';
      const pane = document.getElementById('pdfPane') || document.querySelector('.pdf-pane') || document.body;
      pane.appendChild(this.bannerEl);
    }
    this.bannerEl.textContent = msg;
    this.bannerEl.style.display = 'flex';
  }

  private hideModeBanner(): void {
    if (this.bannerEl) this.bannerEl.style.display = 'none';
  }

  private findPageWrapper(target: EventTarget | null): { wrap: HTMLElement; pageNum: number } | null {
    let el = target as HTMLElement | null;
    while (el && el !== document.body) {
      if (el.id && el.id.startsWith('pageWrapper_')) {
        const num = parseInt(el.id.replace('pageWrapper_', ''), 10);
        if (Number.isFinite(num) && num > 0) return { wrap: el, pageNum: num };
      }
      if (el.classList && el.classList.contains('pdf-page-wrapper')) {
        const num = parseInt(el.getAttribute('data-page') || '', 10) || this.bridge.getCurrentPage();
        return { wrap: el, pageNum: num };
      }
      el = el.parentElement;
    }
    const cur = this.bridge.getCurrentPage();
    const fallback = document.getElementById(`pageWrapper_${cur}`);
    return fallback ? { wrap: fallback, pageNum: cur } : null;
  }

  private onMouseDown(ev: MouseEvent): void {
    if (ev.button !== 0) return;
    // Do not intercept clicks inside an existing snip popover
    if (this.popoverEl && this.popoverEl.contains(ev.target as Node)) return;

    const wantSnip = this.snipModeActive || ev.shiftKey;
    if (!wantSnip) {
      if (this.popoverEl) this.cancelActiveSnip();
      return;
    }

    const found = this.findPageWrapper(ev.target);
    if (!found) return;

    ev.preventDefault();
    ev.stopPropagation();

    this.cancelActiveSnip();
    this.isDragging = true;
    this.dragPageWrap = found.wrap;
    this.dragPageNum = found.pageNum;
    this.startClientX = ev.clientX;
    this.startClientY = ev.clientY;

    const box = document.createElement('div');
    box.className = 'snip-rubber-band';
    found.wrap.appendChild(box);
    this.selectionBoxEl = box;
    this.updateRubberBand(ev.clientX, ev.clientY);
  }

  private updateRubberBand(clientX: number, clientY: number): { left: number; top: number; width: number; height: number } | null {
    if (!this.dragPageWrap || !this.selectionBoxEl) return null;
    const wr = this.dragPageWrap.getBoundingClientRect();
    const x1 = Math.max(0, Math.min(wr.width, this.startClientX - wr.left));
    const y1 = Math.max(0, Math.min(wr.height, this.startClientY - wr.top));
    const x2 = Math.max(0, Math.min(wr.width, clientX - wr.left));
    const y2 = Math.max(0, Math.min(wr.height, clientY - wr.top));

    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    this.selectionBoxEl.style.left = `${left}px`;
    this.selectionBoxEl.style.top = `${top}px`;
    this.selectionBoxEl.style.width = `${width}px`;
    this.selectionBoxEl.style.height = `${height}px`;
    return { left, top, width, height };
  }

  private onMouseMove(ev: MouseEvent): void {
    if (!this.isDragging) return;
    ev.preventDefault();
    this.updateRubberBand(ev.clientX, ev.clientY);
  }

  private onMouseUp(ev: MouseEvent): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    ev.preventDefault();
    ev.stopPropagation();

    const cssRect = this.updateRubberBand(ev.clientX, ev.clientY);
    const wrap = this.dragPageWrap;
    const pageNum = this.dragPageNum;
    this.dragPageWrap = null;

    if (!cssRect || !wrap || cssRect.width < 10 || cssRect.height < 10) {
      this.removeSelectionBox();
      return;
    }

    // Exit persistent snip mode after completing a selection so normal clicks resume smoothly
    if (this.snipModeActive) {
      this.setSnipMode(false);
    }

    void this.finalizeSnipSelection(pageNum, wrap, cssRect);
  }

  private async finalizeSnipSelection(
    pageNum: number,
    wrap: HTMLElement,
    cssRect: { left: number; top: number; width: number; height: number }
  ): Promise<void> {
    const canvas = (wrap.querySelector('canvas.pdf-canvas') || wrap.querySelector('canvas')) as HTMLCanvasElement | null;
    if (!canvas || !canvas.width) {
      this.removeSelectionBox();
      return;
    }

    const wrapBounds = wrap.getBoundingClientRect();
    const canvasBounds = canvas.getBoundingClientRect();
    const offsetX = canvasBounds.left - wrapBounds.left;
    const offsetY = canvasBounds.top - wrapBounds.top;

    // Normalized [0..1] coordinates relative to the rendered PDF page canvas
    const nx0 = Math.max(0, Math.min(1, (cssRect.left - offsetX) / Math.max(1, canvasBounds.width)));
    const ny0 = Math.max(0, Math.min(1, (cssRect.top - offsetY) / Math.max(1, canvasBounds.height)));
    const nx1 = Math.max(0, Math.min(1, (cssRect.left + cssRect.width - offsetX) / Math.max(1, canvasBounds.width)));
    const ny1 = Math.max(0, Math.min(1, (cssRect.top + cssRect.height - offsetY) / Math.max(1, canvasBounds.height)));

    if (nx1 - nx0 < 0.01 || ny1 - ny0 < 0.008) {
      this.removeSelectionBox();
      return;
    }

    // 1. Render crisp high-DPI crop (2.6x PDF resolution, falling back to onscreen canvas)
    let imageDataUrl = '';
    let pageW = 612;
    let pageH = 792;
    const pdfDoc = this.bridge.getPdfDoc();
    if (pdfDoc && typeof pdfDoc.getPage === 'function') {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const baseVp = page.getViewport({ scale: 1 });
        pageW = baseVp.width;
        pageH = baseVp.height;

        const hiScale = 2.6;
        const hiVp = page.getViewport({ scale: hiScale });
        const sw = Math.max(8, Math.ceil((nx1 - nx0) * hiVp.width));
        const sh = Math.max(8, Math.ceil((ny1 - ny0) * hiVp.height));

        // Render ONLY the cropped sub-viewport via PDF.js transform offset (fast & low memory!)
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = sw;
        cropCanvas.height = sh;
        const ctx = cropCanvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, sw, sh);
          ctx.save();
          ctx.translate(-Math.floor(nx0 * hiVp.width), -Math.floor(ny0 * hiVp.height));
          await page.render({ canvasContext: ctx, viewport: hiVp }).promise;
          ctx.restore();
          imageDataUrl = cropCanvas.toDataURL('image/png');
        }
      } catch {
        /* fallback to onscreen canvas below */
      }
    }

    if (!imageDataUrl) {
      const sx = Math.floor(nx0 * canvas.width);
      const sy = Math.floor(ny0 * canvas.height);
      const sw = Math.max(4, Math.ceil((nx1 - nx0) * canvas.width));
      const sh = Math.max(4, Math.ceil((ny1 - ny0) * canvas.height));
      const c = document.createElement('canvas');
      c.width = sw;
      c.height = sh;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, sw, sh);
        ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        imageDataUrl = c.toDataURL('image/png');
      }
    }

    const pdfRect: TopDownRect = {
      x0: nx0 * pageW,
      y0: ny0 * pageH,
      x1: nx1 * pageW,
      y1: ny1 * pageH,
    };

    // 2. Instant offline 2D spatial extraction from cached page glyphs + vector math bars!
    const { localLatex, localText } = this.extractLocalMathAndText(pageNum, pdfRect, pageW, pageH);

    this.activeSnip = {
      pageNum,
      pageWrap: wrap,
      pdfRect,
      cssRect,
      imageDataUrl,
      localLatex,
      localText,
      requestId: `snip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    };

    this.renderSnipActionPopover(this.activeSnip);
  }

  private extractLocalMathAndText(
    pageNum: number,
    topDownRect: TopDownRect,
    fallbackW: number,
    fallbackH: number
  ): { localLatex: string; localText: string } {
    const cache = this.bridge.getPageMathCache(pageNum);
    if (!cache || !cache.glyphs.length) {
      return { localLatex: '', localText: '' };
    }
    const pH = cache.pageH || fallbackH;
    // Convert top-down [x0, y0, x1, y1] -> PDF bottom-up [minX, minBottom, maxX, maxTop]
    const minX = topDownRect.x0 - 2;
    const maxX = topDownRect.x1 + 2;
    const maxTop = pH - topDownRect.y0 + 2;
    const minBottom = pH - topDownRect.y1 - 2;

    const hitGlyphs = cache.glyphs.filter((g) => {
      const cx = g.x + g.w / 2;
      const cy = g.y + g.h * 0.25;
      return cx >= minX && cx <= maxX && cy >= minBottom && cy <= maxTop;
    });
    if (hitGlyphs.length === 0) return { localLatex: '', localText: '' };

    const hitBars = cache.vectors.mathBars.filter(
      (b) => b.x2 >= minX && b.x1 <= maxX && b.y >= minBottom && b.y <= maxTop
    );

    const { latex, equationTag } = reconstructMath2D(hitGlyphs, hitBars, cache.bodyFontSize);
    const fullLatex = equationTag && latex ? `${latex} \\qquad ${equationTag}` : latex;
    const localText = hitGlyphs
      .slice()
      .sort((a, b) => (Math.abs(a.y - b.y) > 4 ? b.y - a.y : a.x - b.x))
      .map((g) => g.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return { localLatex: fullLatex, localText };
  }

  private renderSnipActionPopover(snip: ActiveSnipState): void {
    this.removePopoverOnly();

    const pop = document.createElement('div');
    pop.className = 'snip-action-popover';

    // Position neatly below selection (or above if near bottom of page)
    const wrapH = snip.pageWrap.clientHeight || 800;
    const wrapW = snip.pageWrap.clientWidth || 600;
    const left = Math.max(8, Math.min(wrapW - 360, snip.cssRect.left));
    const placeAbove = snip.cssRect.top + snip.cssRect.height + 210 > wrapH && snip.cssRect.top > 180;

    pop.style.left = `${left}px`;
    if (placeAbove) {
      pop.style.top = `${Math.max(6, snip.cssRect.top - 46)}px`;
    } else {
      pop.style.top = `${snip.cssRect.top + snip.cssRect.height + 8}px`;
    }

    pop.innerHTML = `
      <div class="snip-toolbar-row">
        <button type="button" class="snip-act-btn snip-act-primary" data-snip-act="latex" title="识别框选公式为标准 LaTeX">∑ 转 LaTeX</button>
        <button type="button" class="snip-act-btn" data-snip-act="translate" title="视觉识别并翻译框选区域（支持表格/图表/混排段落）">译 区域翻译</button>
        <button type="button" class="snip-act-btn snip-act-ai" data-snip-act="ask-ai" title="带着这张高清截图向 AI 提问">✦ 带图问 AI</button>
        <button type="button" class="snip-act-btn" data-snip-act="copy-img" title="复制高清截图到剪贴板">⎘ 复制图</button>
        <button type="button" class="snip-act-close" data-snip-act="close" title="关闭 (Esc)">&times;</button>
      </div>
      <div class="snip-result-drawer" id="snipResultDrawer" style="display: none;"></div>
    `;

    pop.addEventListener('click', (ev) => {
      const target = (ev.target as HTMLElement).closest('[data-snip-act]') as HTMLElement | null;
      if (!target) return;
      ev.stopPropagation();
      const act = target.getAttribute('data-snip-act');
      if (act === 'close') {
        this.cancelActiveSnip();
      } else if (act === 'latex') {
        this.triggerLatexAction(snip);
      } else if (act === 'translate') {
        this.triggerTranslateAction(snip);
      } else if (act === 'ask-ai') {
        const presetQ = snip.localLatex
          ? '请结合这张公式/图表截图，把其中的每个符号含义、推导直觉和作用讲透。'
          : '请结合这张论文局部截图，帮我解读其中的核心机制与关键信息。';
        this.bridge.openAiWithImage({
          imageDataUrl: snip.imageDataUrl,
          page: snip.pageNum,
          focusMath: snip.localLatex || undefined,
          selectedText: snip.localText || `第 ${snip.pageNum} 页框选截图`,
          presetQuestion: presetQ,
        });
        this.cancelActiveSnip();
      } else if (act === 'copy-img') {
        void this.copyImageToClipboard(snip.imageDataUrl, target);
      } else if (act === 'config-vision') {
        this.bridge.postMessage({ type: 'openVisionSettings' });
      }
    });

    snip.pageWrap.appendChild(pop);
    this.popoverEl = pop;
  }

  private triggerLatexAction(snip: ActiveSnipState): void {
    const drawer = this.popoverEl?.querySelector('#snipResultDrawer') as HTMLDivElement | null;
    if (!drawer) return;
    drawer.style.display = 'block';

    const hasVision = this.bridge.isVisionConfigured();
    if (snip.localLatex) {
      this.renderLatexDrawerContent(
        drawer,
        snip.localLatex,
        hasVision ? '本地 2D 秒出 · 正在请求视觉模型精校…' : '本地 2D 空间公式重建（离线零延迟）',
        !hasVision
      );
    } else if (hasVision) {
      drawer.innerHTML = `<div class="snip-loading">正在调用多模态视觉模型识别公式 LaTeX…</div>`;
    } else {
      drawer.innerHTML = `
        <div class="snip-notice">
          该选区未检测到矢量文本层（可能是扫描图或位图公式）。请配置独立视觉模型以启用图像 OCR：
          <button type="button" class="snip-inline-cfg-btn" data-snip-act="config-vision">⚙ 配置视觉模型</button>
        </div>`;
      return;
    }

    if (hasVision) {
      snip.requestId = `snip_tex_${Date.now()}`;
      this.bridge.postMessage({
        type: 'requestSnipRecognition',
        requestId: snip.requestId,
        mode: 'latex',
        page: snip.pageNum,
        imageDataUrl: snip.imageDataUrl,
        localHintLatex: snip.localLatex || undefined,
      });
    }
  }

  private triggerTranslateAction(snip: ActiveSnipState): void {
    const drawer = this.popoverEl?.querySelector('#snipResultDrawer') as HTMLDivElement | null;
    if (!drawer) return;
    drawer.style.display = 'block';
    this.streamingBuffer = '';

    if (this.bridge.isVisionConfigured()) {
      drawer.innerHTML = `<div class="snip-loading">正在进行多模态区域视觉识别与学术翻译…</div>`;
      snip.requestId = `snip_tr_${Date.now()}`;
      this.bridge.postMessage({
        type: 'requestSnipRecognition',
        requestId: snip.requestId,
        mode: 'translate',
        page: snip.pageNum,
        imageDataUrl: snip.imageDataUrl,
        localHintText: snip.localText || undefined,
      });
    } else if (snip.localText) {
      // Offline/text-only fallback: use text translation + prompt option for visual OCR
      drawer.innerHTML = `
        <div class="snip-loading">正在翻译选区文本…</div>
        <div class="snip-sub-hint">提示：配置独立视觉模型（如 Qwen-VL）后可直接识别复杂表格与无文本层架构图 <button type="button" class="snip-inline-cfg-btn" data-snip-act="config-vision">⚙ 配置视觉</button></div>
      `;
      this.bridge.postMessage({
        type: 'requestTranslateSelection',
        text: snip.localText,
      });
    } else {
      drawer.innerHTML = `
        <div class="snip-notice">
          该选区是纯图像（无 PDF 文本层）。请配置多模态视觉模型（如通义 Qwen-VL / Gemini / GPT-4o）直接看图翻译：
          <button type="button" class="snip-inline-cfg-btn" data-snip-act="config-vision">⚙ 一键配置独立视觉引擎</button>
        </div>`;
    }
  }

  private renderLatexDrawerContent(
    drawer: HTMLElement,
    latex: string,
    badgeText: string,
    showVisionUpgradeHint: boolean
  ): void {
    const katexHtml = this.bridge.renderKatexHtml(latex, true);
    drawer.innerHTML = `
      <div class="snip-drawer-meta">
        <span class="snip-badge">${this.escapeHtml(badgeText)}</span>
        ${
          showVisionUpgradeHint
            ? `<button type="button" class="snip-inline-cfg-btn" data-snip-act="config-vision" title="搭配 Qwen-VL / Gemini 等多模态模型解锁像素级公式 OCR">⚙ 配置视觉精校</button>`
            : ''
        }
      </div>
      <div class="snip-katex-preview">${katexHtml}</div>
      <textarea class="snip-latex-box" rows="2" spellcheck="false"></textarea>
      <div class="snip-copy-row">
        <button type="button" class="snip-copy-btn" data-copy-wrap="raw">复制 LaTeX</button>
        <button type="button" class="snip-copy-btn" data-copy-wrap="inline">复制 $...$</button>
        <button type="button" class="snip-copy-btn" data-copy-wrap="block">复制 $$...$$</button>
      </div>
    `;
    const ta = drawer.querySelector('.snip-latex-box') as HTMLTextAreaElement | null;
    if (ta) ta.value = latex;

    drawer.querySelectorAll('.snip-copy-btn').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = ta ? ta.value.trim() : latex;
        const wrap = (b as HTMLElement).getAttribute('data-copy-wrap');
        const out = wrap === 'inline' ? `$${val}$` : wrap === 'block' ? `$$\n${val}\n$$` : val;
        void navigator.clipboard?.writeText(out);
        const orig = b.textContent;
        b.textContent = '✓ 已复制';
        setTimeout(() => {
          b.textContent = orig;
        }, 1200);
      });
    });
  }

  /** Handle Host -> Webview streaming & final messages for snip recognition */
  public handleHostMessage(msg: any): boolean {
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'snipRecognitionDelta') {
      if (!this.activeSnip || msg.requestId !== this.activeSnip.requestId) return true;
      this.streamingBuffer += String(msg.chunk || '');
      const drawer = this.popoverEl?.querySelector('#snipResultDrawer') as HTMLDivElement | null;
      if (drawer) {
        drawer.style.display = 'block';
        drawer.innerHTML = `<div class="snip-md-body">${this.bridge.renderMarkdownHtml(this.streamingBuffer)}</div>`;
      }
      return true;
    }

    if (msg.type === 'snipRecognitionResult') {
      // Check if this is a card-level formula OCR result (paraIndex !== undefined)
      if (typeof msg.paraIndex === 'number') {
        return false; // let viewer.js card handler also process card OCR updates
      }
      if (!this.activeSnip || msg.requestId !== this.activeSnip.requestId) return true;
      const drawer = this.popoverEl?.querySelector('#snipResultDrawer') as HTMLDivElement | null;
      if (!drawer) return true;
      drawer.style.display = 'block';

      if (msg.mode === 'latex' && msg.latex) {
        this.activeSnip.localLatex = msg.latex;
        this.renderLatexDrawerContent(drawer, msg.latex, `视觉精校完成 · ${msg.model || 'VLM'}`, false);
      } else {
        const finalMd = String(msg.text || this.streamingBuffer || '').trim();
        drawer.innerHTML = `
          <div class="snip-drawer-meta">
            <span class="snip-badge">视觉翻译 · ${this.escapeHtml(msg.model || 'VLM')}</span>
            <button type="button" class="snip-copy-btn snip-copy-md">复制译文</button>
          </div>
          <div class="snip-md-body">${this.bridge.renderMarkdownHtml(finalMd)}</div>
        `;
        const copyBtn = drawer.querySelector('.snip-copy-md');
        copyBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(finalMd);
          copyBtn.textContent = '✓ 已复制';
        });
      }
      return true;
    }

    if (msg.type === 'snipRecognitionError') {
      if (typeof msg.paraIndex === 'number') return false;
      if (!this.activeSnip || msg.requestId !== this.activeSnip.requestId) return true;
      const drawer = this.popoverEl?.querySelector('#snipResultDrawer') as HTMLDivElement | null;
      if (drawer) {
        drawer.style.display = 'block';
        // Keep local 2D formula if already rendered, and append clear notice
        const errDiv = document.createElement('div');
        errDiv.className = 'snip-notice';
        errDiv.innerHTML = `${this.escapeHtml(msg.errorText || '视觉识别失败')} ${
          msg.needsVisionConfig
            ? `<button type="button" class="snip-inline-cfg-btn" data-snip-act="config-vision">⚙ 配置独立视觉模型</button>`
            : ''
        }`;
        drawer.appendChild(errDiv);
      }
      return true;
    }

    return false;
  }

  private async copyImageToClipboard(dataUrl: string, btnEl: HTMLElement): Promise<void> {
    const orig = btnEl.textContent;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        btnEl.textContent = '✓ 已复制';
      } else {
        await navigator.clipboard?.writeText(dataUrl);
        btnEl.textContent = '✓ 已复制';
      }
    } catch {
      btnEl.textContent = '复制失败';
    }
    setTimeout(() => {
      btnEl.textContent = orig;
    }, 1300);
  }

  public cancelActiveSnip(): void {
    if (this.activeSnip?.requestId) {
      this.bridge.postMessage({ type: 'cancelSnipRecognition', requestId: this.activeSnip.requestId });
    }
    this.activeSnip = null;
    this.streamingBuffer = '';
    this.removeSelectionBox();
    this.removePopoverOnly();
  }

  private removeSelectionBox(): void {
    if (this.selectionBoxEl) {
      this.selectionBoxEl.remove();
      this.selectionBoxEl = null;
    }
  }

  private removePopoverOnly(): void {
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }
  }

  private escapeHtml(s: string): string {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
