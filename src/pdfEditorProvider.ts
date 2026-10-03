import * as vscode from 'vscode';
import * as path from 'path';
import { PaperTranslator, applyTermGlossary } from './translator';
import { LlmError, DEFAULT_TRANSLATION_MODEL } from './llmClient';
import { NotesStorageManager, PaperMetadata } from './notesStorage';

/**
 * 段落内容指纹：FNV-1a + 长度。
 * 旧版用「正文前 28 个字母数字」做键，同页两段开头相同的段落会互相串译文，这里彻底修掉。
 */
function hashText(text: string): string {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${s.length}`;
}

export class PdfDualReaderProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'academicReader.pdfEditor';

  private translator: PaperTranslator;
  private storageManager: NotesStorageManager;
  private currentActiveDocUri: vscode.Uri | undefined;
  private currentActivePaperData: PaperMetadata | undefined;

  /**
   * 翻译请求合并队列。
   * 免费档 API Key 的瓶颈是「每分钟请求数(RPM)」——逐段翻译时一页 20 段就是 20 次请求，
   * 必然 429，而重试退避又让每次慢几秒，于是用户感觉"越翻越慢"。
   * 这里把短时间内到达的多个段落合成一次请求（协议不变，仍逐段回包）。
   */
  private translateQueue: {
    page: number;
    paraIndex: number;
    cacheKey: string;
    text: string;
    sentences: string[];
    webview: vscode.Webview;
  }[] = [];
  private translateTimer: NodeJS.Timeout | null = null;
  private static readonly BATCH_SIZE = 4;
  private static readonly BATCH_WINDOW_MS = 120;
  /**
   * 翻译提示词版本，参与缓存键计算。
   * 提示词/校验规则一改，旧译文就不该再命中缓存——否则用户永远看不到改进
   * （改提示词却不改这个版本号 = 改进对已翻译过的论文完全无效）。
   */
  private static readonly PROMPT_VERSION = 'p3-fidelity-wordorder-terms';

  constructor(private readonly context: vscode.ExtensionContext) {
    this.translator = new PaperTranslator((msg) => console.log(`[AcademicReader] ${msg}`));
    this.storageManager = new NotesStorageManager(context);
  }

  public static register(context: vscode.ExtensionContext): {
    provider: PdfDualReaderProvider;
    disposable: vscode.Disposable;
  } {
    const provider = new PdfDualReaderProvider(context);
    const disposable = vscode.window.registerCustomEditorProvider(
      PdfDualReaderProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: false,
          enableFindWidget: true
        },
        supportsMultipleEditorsPerDocument: false
      }
    );
    return { provider, disposable };
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.currentActiveDocUri = document.uri;

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
        vscode.Uri.file(path.dirname(document.uri.fsPath))
      ]
    };

    // 加载已有的批注和翻译数据
    const paperData = await this.storageManager.loadPaperData(document.uri);
    this.currentActivePaperData = paperData;

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document.uri);

    // 处理来自 Webview 的交互消息
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'webviewReady': {
          try {
            const fileData = await vscode.workspace.fs.readFile(document.uri);
            webviewPanel.webview.postMessage({
              type: 'initPdfData',
              data: Array.from(fileData),
              fileName: path.basename(document.uri.fsPath),
              paperData: paperData,
              engineTag: this.engineTag()
            });
          } catch (err: any) {
            vscode.window.showErrorMessage(`加载 PDF 失败: ${err.message}`);
          }
          break;
        }

        case 'requestPageStructure': {
          const { page, rawText } = message;
          try {
            console.log(`[AcademicReader] Requesting Gemini page ${page} structure parsing...`);
            const paragraphs = await this.translator.parseAndTranslatePage(rawText, page);
            console.log(`[AcademicReader] Gemini page ${page} structure parsing succeeded with ${paragraphs.length} paragraphs.`);
            paragraphs.forEach((p, idx) => {
              const sig = hashText(p.original || '');
              if (sig) paperData.translations[`${page}_${sig}`] = p.translation;
            });
            await this.storageManager.savePaperData(document.uri, paperData);

            webviewPanel.webview.postMessage({
              type: 'pageStructureResult',
              page,
              paragraphs
            });
          } catch (err: any) {
            console.warn(`[AcademicReader] Gemini page ${page} structure parsing failed:`, err.message);
            webviewPanel.webview.postMessage({
              type: 'pageStructureError',
              page,
              message: err.message
            });
          }
          break;
        }

        case 'requestPageVisionStructure': {
          const { page, rawText, imageBase64 } = message;
          try {
            console.log(`[AcademicReader] Requesting Gemini Vision structure parsing for page ${page}...`);
            const paragraphs = await this.translator.parseAndTranslatePageVision(imageBase64, rawText, page);
            console.log(`[AcademicReader] Gemini Vision page ${page} returned ${paragraphs.length} paragraphs.`);
            paragraphs.forEach((p, idx) => {
              if (p.translation) {
                const sig = (p.original || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 28);
                if (sig) paperData.translations[`${page}_${sig}`] = p.translation;
                paperData.translations[`${page}_${idx}`] = p.translation;
              }
            });
            await this.storageManager.savePaperData(document.uri, paperData);

            webviewPanel.webview.postMessage({
              type: 'pageVisionStructureResult',
              page,
              paragraphs
            });
          } catch (err: any) {
            console.warn(`[AcademicReader] Gemini Vision structure parsing failed:`, err.message);
            webviewPanel.webview.postMessage({
              type: 'pageVisionStructureError',
              page,
              message: err.message
            });
          }
          break;
        }

        case 'requestVisualLocate': {
          const { page, paraId, text, imageBase64 } = message;
          try {
            const boxes = await this.translator.locateParagraphVisual(imageBase64, text, page);
            webviewPanel.webview.postMessage({
              type: 'visualLocateResult',
              page,
              paraId,
              boxes
            });
          } catch (err: any) {
            console.warn(`[AcademicReader] locateParagraphVisual failed:`, err.message);
            webviewPanel.webview.postMessage({
              type: 'visualLocateError',
              page,
              paraId,
              message: err.message
            });
          }
          break;
        }

        case 'requestTranslate': {
          const { page, paraIndex, cacheKey, text, sentences } = message;
          this.enqueueTranslate(webviewPanel.webview, document.uri, paperData, {
            page,
            paraIndex,
            cacheKey: cacheKey || `${page}_${hashText(text || '')}`,
            text: text || '',
            sentences: sentences || []
          });
          break;
        }

        case 'requestTranslateSelection': {
          const { text } = message;
          try {
            const translated = await this.translator.translateText(text);
            webviewPanel.webview.postMessage({
              type: 'selectionTranslateResult',
              text,
              translated
            });
          } catch (err: any) {
            webviewPanel.webview.postMessage({
              type: 'selectionTranslateResult',
              text,
              translated: '',
              errorText: this.describeError(err),
              isError: true
            });
          }
          break;
        }

        // 让 AI 问答能拿到全文上下文：webview 每解析完一页就同步一次
        case 'syncPageText': {
          this.translator.registerPageText(message.page, message.paragraphs || []);
          break;
        }

        // 流式 AI 问答：先 start，再若干 delta，最后 done / error
        case 'requestAiQuestion': {
          const { requestId, question, selectedText, contextText, page, history, answerStyle } = message;
          const aiAnswerStyle =
            answerStyle || vscode.workspace.getConfiguration('academicReader').get<string>('aiAnswerStyle', 'standard');
          try {
            webviewPanel.webview.postMessage({ type: 'aiQuestionStart', requestId });
            const result = await this.translator.streamAcademicAnswer(
              {
                requestId,
                question,
                selectedText,
                contextParagraph: contextText,
                page,
                noteType: message.noteType,
                history: Array.isArray(history) ? history : [],
                answerStyle: aiAnswerStyle
              },
              (chunk) => {
                webviewPanel.webview.postMessage({ type: 'aiQuestionDelta', requestId, chunk });
              }
            );
            webviewPanel.webview.postMessage({
              type: 'aiQuestionDone',
              requestId,
              answer: result.answer,
              model: result.model,
              ttftMs: result.ttftMs,
              totalMs: result.totalMs,
              note: result.note,
              success: true
            });
          } catch (err: any) {
            webviewPanel.webview.postMessage({
              type: 'aiQuestionError',
              requestId,
              kind: err && err.kind ? err.kind : 'unknown',
              errorText: this.describeError(err),
              success: false
            });
          }
          break;
        }

        case 'cancelAiQuestion': {
          this.translator.cancelAiRequest(message.requestId);
          break;
        }

        case 'requestModelInfo': {
          const cfg = vscode.workspace.getConfiguration('academicReader');
          const service = cfg.get<string>('translationService', 'gemini');
          const isOpenAI = service === 'openai-compatible';
          let available: string[] = [];
          let listError = '';
          if (isOpenAI) {
            // 自定义端点没有统一的"模型列表"接口，不能拿 Gemini 的列表冒充
            const m = (cfg.get<string>('modelName', 'deepseek-chat') || '').trim();
            available = m ? [m] : [];
          } else {
            try {
              available = await this.translator.listModels(!!message.force);
            } catch (err: any) {
              listError = this.describeError(err);
            }
          }
          webviewPanel.webview.postMessage({
            type: 'modelInfo',
            service,
            isOpenAI,
            configuredModel: isOpenAI
              ? cfg.get<string>('modelName', 'deepseek-chat')
              : cfg.get<string>('geminiModel', ''),
            configuredAiModel: cfg.get<string>('aiModel', ''),
            answerStyle: cfg.get<string>('aiAnswerStyle', 'standard'),
            engineTag: this.engineTag(),
            available,
            listError,
            hasKey: isOpenAI
              ? !!(cfg.get<string>('apiKey', '') || '').trim()
              : !!this.translator.getGeminiKey(cfg)
          });
          break;
        }

        case 'setAnswerStyle': {
          // 弹窗里一键切换回答风格 → 写回用户设置，重载或换论文后依然生效
          const style = ['concise', 'standard', 'reviewer'].includes(message.style) ? message.style : 'standard';
          await vscode.workspace
            .getConfiguration('academicReader')
            .update('aiAnswerStyle', style, vscode.ConfigurationTarget.Global);
          break;
        }

        case 'openModelPicker': {
          await vscode.commands.executeCommand('academicReader.pickModel');
          break;
        }

        case 'saveAnnotations': {
          paperData.annotations = message.annotations || [];
          await this.storageManager.savePaperData(document.uri, paperData);
          break;
        }

        case 'exportMarkdown': {
          await this.exportCurrentNotes();
          break;
        }

        case 'configureGeminiKey': {
          await vscode.commands.executeCommand('academicReader.setGeminiApiKey');
          break;
        }

        case 'openSettings': {
          await vscode.commands.executeCommand('academicReader.openSettings');
          break;
        }

        case 'showInfo': {
          vscode.window.showInformationMessage(message.message);
          break;
        }

        case 'showError': {
          vscode.window.showErrorMessage(message.message);
          break;
        }
      }
    });

    webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.currentActiveDocUri = document.uri;
        this.currentActivePaperData = paperData;
      }
    });
  }

  /** 把翻译请求压入合并队列；凑满一批或静默 120ms 后统一发出 */
  private enqueueTranslate(
    webview: vscode.Webview,
    uri: vscode.Uri,
    paperData: PaperMetadata,
    item: {
      page: number;
      paraIndex: number;
      cacheKey: string;
      text: string;
      sentences: string[];
    }
  ): void {
    if (!item.text.trim()) return;
    this.translateQueue.push({ ...item, webview });

    if (this.translateQueue.length >= PdfDualReaderProvider.BATCH_SIZE) {
      void this.flushTranslateQueue(uri, paperData);
      return;
    }
    if (this.translateTimer) clearTimeout(this.translateTimer);
    this.translateTimer = setTimeout(() => {
      void this.flushTranslateQueue(uri, paperData);
    }, PdfDualReaderProvider.BATCH_WINDOW_MS);
  }

  /** 取出一批请求 → 合并成一次 API 调用 → 按原协议逐段回包 */
  private async flushTranslateQueue(uri: vscode.Uri, paperData: PaperMetadata): Promise<void> {
    if (this.translateTimer) {
      clearTimeout(this.translateTimer);
      this.translateTimer = null;
    }
    const batch = this.translateQueue.splice(0, PdfDualReaderProvider.BATCH_SIZE);
    if (batch.length === 0) return;

    // 还有积压就立刻安排下一批
    if (this.translateQueue.length > 0) {
      this.translateTimer = setTimeout(() => {
        void this.flushTranslateQueue(uri, paperData);
      }, 0);
    }

    const webview = batch[0].webview;
    let results: (import('./translator').ParagraphTranslation | Error)[];
    try {
      results = await this.translator.translateParagraphsBatch(
        batch.map(b => ({ text: b.text, sentences: b.sentences }))
      );
    } catch (err: any) {
      const e = err instanceof Error ? err : new Error(String(err));
      results = batch.map(() => e);
    }

    for (let i = 0; i < batch.length; i++) {
      const it = batch[i];
      const r = results[i];

      if (!r || r instanceof Error) {
        webview.postMessage({
          type: 'translateResult',
          page: it.page,
          paraIndex: it.paraIndex,
          cacheKey: it.cacheKey,
          translated: '',
          errorText: this.describeError(r),
          isError: true
        });
        continue;
      }

      // 术语兜底（出站前统一处理，覆盖 JSON 路径与各条降级路径）：
      // 模型把 object-agnostic 硬译成"对象无关"且拒绝附英文原词时，这里补上，
      // 保证读者既读得懂、也能拿英文原词去查证。
      const glossed = applyTermGlossary(it.text, r.translation, it.sentences, r.sentences);
      r.translation = glossed.translation;
      if (glossed.sentences) r.sentences = glossed.sentences;

      paperData.translations[it.cacheKey] = r.translation;
      if (r.sentences && r.sentences.length > 0) {
        (paperData as any).sentenceTranslations = (paperData as any).sentenceTranslations || {};
        (paperData as any).sentenceTranslations[it.cacheKey] = r.sentences;
      }
      (paperData as any).alignment = (paperData as any).alignment || {};
      (paperData as any).alignment[it.cacheKey] = {
        aligned: r.aligned,
        mode: r.mode,
        note: r.note,
        model: r.model,
        at: Date.now()
      };

      webview.postMessage({
        type: 'translateResult',
        page: it.page,
        paraIndex: it.paraIndex,
        cacheKey: it.cacheKey,
        translated: r.translation,
        sentenceTranslations: r.sentences,
        aligned: r.aligned,
        mode: r.mode,
        note: r.note,
        model: r.model
      });
    }

    try {
      await this.storageManager.savePaperData(uri, paperData);
    } catch (err: any) {
      console.warn('[AcademicReader] 保存翻译缓存失败:', err?.message);
    }
  }

  /**
   * 当前翻译引擎的短标识（服务 + 模型名的哈希）。
   * 前端会把它并入段落缓存键：否则换成 DeepSeek 后，之前用 Gemini 翻出来的
   * 旧译文仍然命中缓存，用户会以为"换了引擎却没变化"。
   */
  private engineTag(): string {
    const cfg = vscode.workspace.getConfiguration('academicReader');
    const service = cfg.get<string>('translationService', 'gemini');
    const model =
      service === 'gemini'
        ? cfg.get<string>('geminiModel', '') || 'default'
        : cfg.get<string>('modelName', '') || 'default';
    const raw = `${service}|${model}|${PdfDualReaderProvider.PROMPT_VERSION}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  public listModels(force = false): Promise<string[]> {
    return this.translator.listModels(force);
  }

  /** 从真实可用模型列表中挑选（避免用户手打模型名打错或被旧代码改写） */
  public async pickModel(): Promise<void> {
    const config = vscode.workspace.getConfiguration('academicReader');
    const service = config.get<string>('translationService', 'gemini');

    // OpenAI 兼容端点没有统一的模型列表接口 → 用输入框填写模型名，并写入 modelName
    if (service === 'openai-compatible') {
      const currentName = (config.get<string>('modelName', 'deepseek-chat') || '').trim();
      const pickedName = await vscode.window.showInputBox({
        title: '设置 OpenAI 兼容接口的模型名',
        prompt: '翻译与 AI 问答都会使用这个模型（端点由 academicReader.apiEndpoint 决定）',
        value: currentName || 'deepseek-chat',
        placeHolder: 'deepseek-chat / deepseek-reasoner / qwen-plus / moonshot-v1-8k …',
        validateInput: v =>
          !v || !v.trim() ? '模型名不能为空' : /\s/.test(v.trim()) ? '模型名里不应包含空格' : undefined
      });
      if (pickedName === undefined) return;
      const name = pickedName.trim();
      if (!name) return;
      await config.update('modelName', name, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `已把模型设为 ${name}。当前页翻译会重新计算，请回到阅读器点击右上角的重新翻译按钮。`
      );
      return;
    }

    let models: string[] = [];
    try {
      models = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在向 Gemini 查询可用模型列表...' },
        () => this.translator.listModels(true)
      );
    } catch (err: any) {
      const msg = err instanceof LlmError ? err.toUserMessage() : String(err?.message || err);
      vscode.window.showErrorMessage(`无法获取模型列表：${msg}`);
      return;
    }

    if (models.length === 0) {
      vscode.window.showWarningMessage('该 API Key 下没有可用于 generateContent 的模型。');
      return;
    }

    const current = config.get<string>('geminiModel', '');
    const items = models.map(m => ({
      label: m,
      description:
        m === current
          ? '【当前翻译模型】'
          : m === DEFAULT_TRANSLATION_MODEL
            ? '【插件默认】实测最快且逐句对齐稳定'
            : /pro/.test(m)
              ? '质量优先（较慢）'
              : /flash-lite/.test(m)
                ? '速度优先（质量略低）'
                : '均衡',
      picked: m === current
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: '选择翻译/AI 问答使用的模型',
      placeHolder: `当前：${
        current || `(未设置，插件默认 ${DEFAULT_TRANSLATION_MODEL})`
      } — 输入可过滤；注意：某些模型在该 API Key 上没有配额，调用会返回 429`,
      matchOnDescription: true
    });
    if (!picked) return;

    await config.update('geminiModel', picked.label, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      `已切换模型为 ${picked.label}。当前页翻译会重新计算，请回到阅读器点击右上角的重新翻译按钮。`
    );
  }

  /** 把任意异常翻译成用户能看懂、且不掺假的中文说明 */
  private describeError(err: any): string {
    if (err instanceof LlmError) return err.toUserMessage();
    const msg = (err && err.message) ? String(err.message) : String(err || '未知错误');
    return `调用失败：${msg}`;
  }

  public async exportCurrentNotes(): Promise<void> {
    if (!this.currentActiveDocUri || !this.currentActivePaperData) {
      vscode.window.showWarningMessage('当前没有处于激活状态的文献阅读窗口！');
      return;
    }
    const resultUri = await this.storageManager.exportToMarkdown(
      this.currentActiveDocUri,
      this.currentActivePaperData
    );
    if (resultUri) {
      vscode.window.showInformationMessage(`文献研读笔记已导出至: ${path.basename(resultUri.fsPath)}`);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview, docUri: vscode.Uri): string {
    const extensionUri = this.context.extensionUri;

    const pdfJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs', 'pdf.min.js')
    );
    const pdfWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs', 'pdf.worker.min.js')
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'viewer.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'viewer.js')
    );

    const nonce = getNonce();
    const v = Date.now();

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource} data:; connect-src ${webview.cspSource} blob: data: https:; img-src ${webview.cspSource} data: blob:;">
  <title>双栏文献阅读器</title>
  <link rel="stylesheet" href="${cssUri}?v=${v}">
</head>
<body>
  <!-- 顶部工具栏 -->
  <header class="app-header">
    <div class="header-left">
      <span class="paper-title" id="paperTitle" title="文献标题">加载中...</span>
    </div>

    <div class="header-center">
      <div class="toolbar-group">
        <button id="prevPageBtn" class="btn-tool" title="上一页 (PageUp)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <span class="page-indicator">
          第 <input type="number" id="pageNumberInput" value="1" min="1" /> / <span id="pageCount">--</span> 页
        </span>
        <button id="nextPageBtn" class="btn-tool" title="下一页 (PageDown)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>

      <div class="toolbar-divider"></div>

      <div class="toolbar-group">
        <button id="zoomOutBtn" class="btn-tool" title="缩小 (-)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <span id="zoomPercent" class="zoom-label">125%</span>
        <button id="zoomInBtn" class="btn-tool" title="放大 (+)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button id="zoomFitBtn" class="btn-tool" title="适合宽度">适合宽度</button>
      </div>

      <div class="toolbar-divider"></div>

      <div class="theme-pill-group" title="切换文献纸张护眼底色">
        <span class="theme-pill-title">护眼纸张:</span>
        <button class="btn-theme-pill active" data-theme="default" title="默认白纸">白纸</button>
        <button class="btn-theme-pill" data-theme="sepia" title="护眼暖色">羊皮</button>
        <button class="btn-theme-pill" data-theme="green" title="冷色防眩光">竹青</button>
        <button class="btn-theme-pill" data-theme="dark" title="夜读黑底">暗夜</button>
      </div>
    </div>

    <div class="header-right">
      <div class="tab-switch">
        <button id="tabTransBtn" class="tab-btn active" title="段落双语对照">对照翻译</button>
        <button id="tabNotesBtn" class="tab-btn" title="查看文献高亮与批注">
          批注笔记 (<span id="notesCount">0</span>)
        </button>
      </div>
      <button id="translateAllBtn" class="btn-gemini" title="使用大模型整页翻译">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>
        整页翻译
      </button>
      <button id="exportNotesBtn" class="btn-secondary" title="导出文献笔记为 Markdown 文件">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        导出笔记
      </button>
      <button id="openSettingsBtn" class="btn-secondary" title="配置学术翻译大模型 (Gemini / DeepSeek / 内置引擎) 与 API Key">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        翻译设置
      </button>
    </div>
    <div id="readingProgressBar" class="reading-progress-bar" style="width: 0%;"></div>
  </header>

  <!-- 主双栏工作区 -->
  <main class="main-container">
    <!-- 左栏：PDF 原文阅读区 -->
    <section class="left-pane" id="pdfPane">
      <div id="pdfViewerContainer" class="pdf-viewer-container">
        <div id="loadingOverlay" class="loading-overlay">
          <div class="spinner"></div>
          <p>正在解析文献 PDF，请稍候...</p>
        </div>
      </div>


    </section>

    <!-- 可拖动分割线 (Splitter) -->
    <div class="pane-splitter" id="splitter">
      <div class="splitter-handle"></div>
    </div>

    <!-- 右栏：双语对照翻译 & 批注笔记区 -->
    <section class="right-pane" id="rightPane">
      <!-- 视图 1: 双语段落对照 -->
      <div id="transView" class="pane-view active">
        <div class="pane-view-header">
          <div class="header-info">
            <span class="badge badge-gemini">对照翻译</span>
            <span class="subtitle">划选即译</span>
          </div>
          <div class="view-switch-tools">
            <button id="btnViewCards" class="view-toggle-btn active" title="段落卡片对照视图">卡片对照</button>
            <button id="btnViewArticle" class="view-toggle-btn" title="沉浸式全文双语排版视图">全文精读</button>
          </div>
          <div style="display: flex; align-items: center; gap: 4px;">
            <button id="refreshTransBtn" class="icon-btn" title="重新获取当前页翻译">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            </button>
          </div>
        </div>

        <!-- 视图 A: 卡片对照容器 -->
        <div id="transListContainer" class="trans-list-container">
          <div class="empty-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
            <p>正在解析文献段落与学术排版...</p>
          </div>
        </div>

        <!-- 视图 B: 沉浸全文对照容器 -->
        <div id="articleFlowContainer" class="article-flow-container" style="display: none;">
        </div>
      </div>

      <!-- 视图 2: 文献批注与笔记列表 -->
      <div id="notesView" class="pane-view">
        <div class="pane-view-header">
          <div class="header-info">
            <span class="badge badge-accent">文献批注库</span>
            <span class="subtitle">点击批注卡片即可跳回左侧原段落</span>
          </div>
        </div>

        <!-- 批注搜索与筛选栏 -->
        <div class="notes-filter-bar">
          <div class="notes-search-box">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="notesSearchInput" placeholder="搜索批注心得或原文摘录..." />
            <button id="clearNotesSearch" class="btn-clear-search" style="display: none;" title="清空搜索">&times;</button>
          </div>
          <div class="notes-filter-row">
            <div class="notes-filter-chips">
              <button class="filter-chip active" data-color="all">全部 (<span id="filterCountAll">0</span>)</button>
              <button class="filter-chip chip-yellow" data-color="yellow">要点</button>
              <button class="filter-chip chip-green" data-color="green">数据</button>
              <button class="filter-chip chip-blue" data-color="blue">方法</button>
              <button class="filter-chip chip-pink" data-color="pink">疑难</button>
            </div>
            <button id="btnAddPageNoteQuick" class="btn-mini-add-note" title="记录当前页面的阅读心得或总结">记本页心得</button>
          </div>
        </div>

        <div id="notesListContainer" class="notes-list-container">
          <div class="empty-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            <p>还没有添加批注哦。<br>在左侧 PDF 划选文字后点击【高亮】或【批注】即可保存！</p>
          </div>
        </div>
      </div>
    </section>
  </main>

  <!-- 鼠标划词快捷悬浮菜单 (Floating Action Bar - 顶层视口固定定位) -->
  <div id="selectionToolbar" class="selection-floating-bar" style="display: none;">
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
    <button id="btnSelectionAi" class="action-btn" style="color: #6366f1;" title="针对选中文本向 AI 学术导师提问 (快捷键: Q)">
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
  </div>

  <!-- 核心：段落/句子点击聚焦快捷工具条 (无需手动拖选，点击段落即可操作) -->
  <div id="paraFocusBar" class="para-focus-bar" style="display: none;">
    <span class="focus-bar-label" id="focusBarLabel">当前段落</span>
    <button id="btnFocusHighlight" class="focus-action-btn" title="为此段落/句子添加高亮 (快捷键: H)">
      高亮
    </button>
    <button id="btnFocusNote" class="focus-action-btn" title="为此段落添加批注心得 (快捷键: N)">
      批注
    </button>
    <button id="btnFocusTranslate" class="focus-action-btn" title="查看对应中文译文 (快捷键: T)">
      翻译
    </button>
    <button id="btnFocusCopy" class="focus-action-btn" title="复制当前段落文本 (快捷键: C)">
      复制
    </button>
    <button id="btnFocusAi" class="focus-action-btn focus-ai-btn" title="向 AI 咨询此句疑点与深度解析 (快捷键: Q)">
      问AI
    </button>
    <button id="btnCloseFocusBar" class="focus-close-btn" title="关闭">&times;</button>
  </div>

  <!-- 核心：就近批注便签编辑气泡 (Inline Annotation Editor Popover) -->
  <div id="annotationPopover" class="annotation-editor-popover" style="display: none;">
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
    <div class="annot-input-wrapper">
      <textarea id="annotTextInput" placeholder="记录你的文献理解、公式推导、实验疑点或创新灵感..." rows="4"></textarea>
    </div>
    <div class="annot-ai-bar">
      <button id="btnAskAiPopover" class="btn-ask-ai" type="button" title="结合选句与论文上下文，向 AI 导师请教解答疑难">
        AI 提问
      </button>
      <span id="annotAiStatusHint" class="ai-status-hint"></span>
    </div>
    <div id="annotAiAnswerBox" class="annot-ai-answer-box" style="display: none;">
      <div class="ai-answer-header">
        <span class="ai-answer-badge">AI 解答</span>
        <div class="ai-answer-actions">
          <button id="btnAdoptAiToNote" class="btn-mini-adopt" type="button" title="将 AI 解答追加进批注输入框">采纳进批注</button>
          <button id="btnCloseAiAnswer" class="btn-mini-close" type="button" title="收起解答">&times;</button>
        </div>
      </div>
      <div id="annotAiAnswerContent" class="ai-answer-content markdown-body"></div>
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
  </div>

  <!-- 核心：AI 学术文献导师问答弹窗 (AI Academic Assistant Dialog) -->
  <div id="aiAssistantModal" class="ai-assistant-modal" style="display: none;">
    <div class="ai-modal-card">
      <div class="ai-modal-header">
        <div class="ai-modal-title">
          <span>AI 学术文献导师</span>
          <span class="ai-model-tag" id="aiModalModelTag">未连接</span>
        </div>
        <div class="ai-modal-header-actions">
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
          <div class="ai-transcript-empty">可直接提问，或点上面的快捷提问。回答过程中可随时停止。</div>
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
      </div>
    </div>
  </div>

  <!-- 原文高亮批注悬停预览卡片 (Note Hover Tooltip) -->
  <div id="noteHoverTooltip" class="note-hover-tooltip" style="display: none;">
    <div class="tooltip-header">
      <span class="tooltip-badge" id="tooltipBadge">核心要点</span>
      <span class="tooltip-time" id="tooltipTime">刚刚</span>
    </div>
    <div class="tooltip-quote" id="tooltipQuote"></div>
    <div class="tooltip-content" id="tooltipContent"></div>
    <div class="tooltip-actions">
      <button id="tooltipBtnEdit" class="btn-tooltip-act">编辑批注</button>
      <button id="tooltipBtnJump" class="btn-tooltip-act">笔记库</button>
      <button id="tooltipBtnDelete" class="btn-tooltip-act text-danger">删除</button>
    </div>
  </div>

  <!-- 快速划词翻译弹出气泡 -->
  <div id="quickTranslatePopover" class="popover-card" style="display: none;">
    <div class="popover-header">
      <span class="popover-tag">即时译文</span>
      <button id="closePopoverBtn" class="btn-close">&times;</button>
    </div>
    <div class="popover-source" id="popoverSourceText"></div>
    <div class="popover-result" id="popoverResultText">
      <div class="mini-spinner"></div> 正在翻译中...
    </div>
  </div>

  <!-- 自定义学术 PDF 右键快捷上下文菜单 (Custom Context Menu) -->
  <div id="pdfContextMenu" class="pdf-context-menu" style="display: none;">
    <!-- 针对已有批注/高亮的操作区域 -->
    <div id="ctxAnnotSection" style="display: none;">
      <div class="context-menu-header">
        <span class="context-menu-label">已有批注操作</span>
        <div class="color-picker-mini" id="ctxAnnotColorPicker">
          <span class="ctx-color-dot yellow" data-color="yellow" title="修改为核心要点 (黄色)"></span>
          <span class="ctx-color-dot green" data-color="green" title="修改为论据数据 (绿色)"></span>
          <span class="ctx-color-dot blue" data-color="blue" title="修改为公式方法 (蓝色)"></span>
          <span class="ctx-color-dot pink" data-color="pink" title="修改为疑难待查 (粉色)"></span>
        </div>
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" id="ctxBtnEditAnnot">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span>编辑此条批注</span>
        <span class="context-shortcut">E</span>
      </div>
      <div class="context-menu-item" id="ctxBtnCopyAnnot">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        <span>复制批注与引文</span>
      </div>
      <div class="context-menu-item" id="ctxBtnFocusAnnot">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>
        <span>在右侧笔记列表中定位</span>
      </div>
      <div class="context-menu-item" id="ctxBtnDeleteAnnot">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        <span style="color: #ff6b6b;">删除此条批注/高亮</span>
        <span class="context-shortcut">Del</span>
      </div>
      <div class="context-menu-divider"></div>
    </div>

    <!-- 针对选区/段落文本的操作区域 -->
    <div id="ctxTextSection">
      <div class="context-menu-header">
        <span class="context-menu-label">高亮荧光笔</span>
        <div class="color-picker-mini">
          <span class="ctx-color-dot yellow active" data-color="yellow" title="核心要点 (黄色)"></span>
          <span class="ctx-color-dot green" data-color="green" title="论据数据 (绿色)"></span>
          <span class="ctx-color-dot blue" data-color="blue" title="公式方法 (蓝色)"></span>
          <span class="ctx-color-dot pink" data-color="pink" title="疑难待查 (粉色)"></span>
        </div>
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" id="ctxBtnHighlight">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L15 4a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8z"/></svg>
        <span>荧光笔高亮</span>
        <span class="context-shortcut">H</span>
      </div>
      <div class="context-menu-item" id="ctxBtnAddNote">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span id="ctxBtnAddNoteLabel">添加批注便签</span>
        <span class="context-shortcut">N</span>
      </div>
      <div class="context-menu-item" id="ctxBtnAskAi">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><rect width="18" height="12" x="3" y="6" rx="2"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M9 15h6"/></svg>
        <span style="color: #6366f1; font-weight: 500;">AI 答疑</span>
        <span class="context-shortcut">Q</span>
      </div>
      <div class="context-menu-item" id="ctxBtnTranslate">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
        <span>即时翻译</span>
        <span class="context-shortcut">T</span>
      </div>
      <div class="context-menu-item" id="ctxBtnCopy">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        <span>复制英文原文</span>
        <span class="context-shortcut">Ctrl+C</span>
      </div>
      <div class="context-menu-item" id="ctxBtnLocate">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/></svg>
        <span>定位翻译卡片</span>
      </div>
      <div class="context-menu-divider"></div>
    </div>

    <!-- 全局快捷操作 (无论是否有选区均可使用) -->
    <div class="context-menu-item" id="ctxBtnAddPageNote">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      <span>记录本页心得</span>
    </div>
    <div class="context-menu-item" id="ctxBtnTranslatePage">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>
      <span>整页翻译</span>
    </div>
    <div class="context-menu-item" id="ctxBtnFitWidth">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      <span>适合页面宽度</span>
    </div>
    <div class="context-menu-item" id="ctxBtnPrevPage">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
      <span>上一页</span>
      <span class="context-shortcut">PgUp</span>
    </div>
    <div class="context-menu-item" id="ctxBtnNextPage">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      <span>下一页</span>
      <span class="context-shortcut">PgDn</span>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item" id="ctxBtnExportNotes">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      <span>导出笔记</span>
    </div>
  </div>

  <!-- 便签编辑弹窗 (Modal 备用/全屏模式) -->
  <div id="noteModal" class="modal-overlay" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <h3>添加批注</h3>
        <button id="closeModalBtn" class="btn-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-quote">
          <span class="quote-label">原文摘录：</span>
          <p id="modalQuoteText"></p>
        </div>
        <textarea id="modalNoteInput" placeholder="写下你的理解、推导、疑问或与其它论文的关联思考..." rows="5"></textarea>
      </div>
      <div class="modal-footer">
        <button id="cancelNoteBtn" class="btn-secondary">取消</button>
        <button id="saveNoteBtn" class="btn-primary">保存批注</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    window.PDF_WORKER_URL = "${pdfWorkerUri}";
  </script>
  <script nonce="${nonce}" src="${pdfJsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}?v=${v}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
