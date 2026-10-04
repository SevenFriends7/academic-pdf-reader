import * as vscode from 'vscode';
import * as path from 'path';
import { PaperTranslator, applyTermGlossary } from './translator';
import { LlmError, DEFAULT_TRANSLATION_MODEL } from './llmClient';
import { NotesStorageManager, PaperMetadata } from './notesStorage';
import { buildAnnotatedPdf } from './pdfExport';
import { mergeArchivedParagraphs } from './pageArchive';
import { ZoteroClient, ZoteroLink, ZoteroDetectResult, toViewerAnnotations, ViewerAnnotation } from './zoteroClient';

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
  /** 当前激活阅读窗口的 webview：命令面板触发导出时需要它生成文稿 */
  private currentActiveWebview: vscode.Webview | undefined;

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
    /** 标题/摘要等已确认可翻的段落：跳过 looksNonProse 短路 */
    forceTranslate?: boolean;
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
  /**
   * 翻译提示词 / 段落类型语义的版本号，参与缓存键计算。
   *
   * 提示词、校验规则，或**"哪些段落该翻"的语义**一改，旧译文就不该再命中缓存 ——
   * 否则用户永远看不到改进（改了却不改版本号 = 对已翻译过的论文完全无效）。
   *
   * p4（1.6.3）：视觉回包编号兜底修复后，标题/作者块/图内文字终于能被正确分类；
   * 同时标题类段落开了"强制翻译"直通路。这两件事都会改变已有段落的**处理方式**，
   * 所以必须换版本号让旧译文失效重来（旧缓存里那些"译文=英文原文"的标题就在此列）。
   */
  private static readonly PROMPT_VERSION = 'p4-vision-index-title-force';

  /**
   * Zotero 只读客户端（本文件生命周期内共用一个：条目列表与探测结果都在它里面缓存，
   * 每次打开论文都新建会重复打本地接口）。
   */
  private readonly zotero = new ZoteroClient();
  /** 当前阅读窗口认领到的 Zotero 论文（用于把 Zotero 全文喂给 AI 问答的上下文） */
  private zoteroLink: ZoteroLink | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.translator = new PaperTranslator((msg) => console.log(`[AcademicReader] ${msg}`));
    this.storageManager = new NotesStorageManager(context);
  }

  /**
   * 把本地 PDF 认领到 Zotero 条目（只读）。
   *
   * 这些事都**不能**让它挡住阅读器打开：探测超时 4 秒、任何异常都吞掉并只记日志。
   * 认领成功后会做两件有实效的事：
   *   ① 把 Zotero 的**逐页全文**注册进 translator 的页面索引 —— AI 问答能引用用户还没翻到的页
   *      （Zotero 已经索引全书，等于白送一份全文上下文）；
   *   ② 把结果发给 webview 显示一行"已认领 + 元数据"。
   * 页数不一致时**只发提示、不注册全文** —— 错位的上下文比没有上下文更坏。
   */
  private async linkZoteroPaper(
    webview: vscode.Webview,
    document: vscode.Uri,
    expectedPages?: number,
    withFullText = true,
    pdfPageHeights?: Record<number, number>
  ): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('academicReader').get<boolean>('zoteroIntegration', true);
    if (!enabled) return;
    try {
      const fileSize = await vscode.workspace.fs.stat(document).then(s => s.size, () => undefined);
      const { link, detect } = await this.zotero.linkPdf(document.fsPath, { fileSize, expectedPages, withFullText });
      this.zoteroLink = link;
      if (link?.fullText && !link.fullText.pageCountMismatch) {
        for (let i = 0; i < link.fullText.pages.length; i++) {
          const text = (link.fullText.pages[i] || '').trim();
          if (!text) continue;
          this.translator.registerPageText(i + 1, [{ type: 'body', text }]);
        }
        console.log(
          `[AcademicReader] Zotero 已认领《${link.meta.title}》，注册 ${link.fullText.pages.length} 页全文作为问答上下文`
        );
      } else if (link) {
        console.log('[AcademicReader] Zotero 认领成功，但没有可用的逐页全文（未索引或页数不一致）');
      }

      /*
       * 批注转换需要**每页的 PDF 高度**（Zotero 的 rects 是左下原点，要翻 y）。
       * 页高只有 webview 侧的 pdf.js 给得出来，所以第一趟（webviewReady，没有页高）不转换，
       * 等 pdfOpened 那一趟带着 pageHeights 回来再转 —— 没有页高就宁可不画。
       */
      const viewerAnnotations: ViewerAnnotation[] =
        link && pdfPageHeights && Object.keys(pdfPageHeights).length > 0
          ? toViewerAnnotations(link.annotations, pdfPageHeights, link.attachmentKey)
          : [];
      if (link && link.annotations.length > 0 && viewerAnnotations.length === 0) {
        console.log(
          `[AcademicReader] Zotero 有 ${link.annotations.length} 条批注，但这一趟拿不到页高（或坐标不可用），暂不导入`
        );
      }

      webview.postMessage({
        type: 'zoteroData',
        link: link
          ? {
              attachmentKey: link.attachmentKey,
              parentKey: link.parentKey,
              matchedBy: link.matchedBy,
              fileName: link.fileName,
              meta: link.meta,
              annotationCount: link.annotations.length,
              importedAnnotations: viewerAnnotations.length,
              annotations: viewerAnnotations,
              fullTextPages: link.fullText ? link.fullText.pages.length : 0,
              pageCountMismatch: link.fullText ? link.fullText.pageCountMismatch : false
            }
          : null,
        detect
      });
    } catch (err: any) {
      console.warn('[AcademicReader] Zotero 认领失败（不影响阅读）:', err?.message);
      webview.postMessage({
        type: 'zoteroData',
        link: null,
        detect: { available: false, reason: 'error', message: String(err?.message || err), prefsPath: null, baseUrl: '' } as ZoteroDetectResult
      });
    }
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
    // 每个阅读窗口的 Zotero 认领从零开始：换论文时必须清掉上一篇的引用，
    // 否则"这篇没认领成功"时会残留上一篇的全文上下文（AI 会拿 A 论文的原文回答 B 论文的问题）。
    this.zoteroLink = null;
    // 记住当前 webview：命令面板的「导出笔记」也要能触达它（精读稿由 webview 侧生成，
    // 因为只有它手里有段落切分、句级译文和 AI 答疑上下文）
    this.currentActiveWebview = webviewPanel.webview;
    webviewPanel.onDidDispose(() => {
      if (this.currentActiveWebview === webviewPanel.webview) {
        this.currentActiveWebview = undefined;
      }
    });

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

    /**
     * 一次性清理历史遗留的"假译文"。
     *
     * 1.3.0 及以前的 looksNonProse() 会把"以冒号/逗号结尾的正文片段"误判成图表标签，
     * 于是把**原文本身**当译文写进缓存（alignment 里留着"已原样保留（未调用翻译接口）"）。
     * 判据修好之后，这些旧条目仍会按内容指纹命中缓存 —— 用户会一直看到"这段没翻译"，
     * 除非手动逐页重译。所以每次打开论文时做一次**定向**清理：
     * 只有"note 写着原样保留"且"内容确实像在叙述"的条目才删；
     * 真正的标题/机构/图注/公式残渣一个字都不动。幂等，不写盘也没关系（下次再算一遍）。
     */
    try {
      const pruned = this.translator.pruneStaleNonProseCache(paperData as any);
      if (pruned > 0) {
        console.log(`[AcademicReader] 清理了 ${pruned} 条"原文当译文"的历史缓存（判据已修正，重新翻译这些段）`);
        await this.storageManager.savePaperData(document.uri, paperData);
      }
    } catch (err: any) {
      console.warn('[AcademicReader] 清理历史假译文失败（不影响阅读）:', err?.message);
    }

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
              // 版面分割引擎要在首屏渲染前就位，否则设成 local 的用户也会被发一次视觉请求
              segmentationEngine: vscode.workspace
                .getConfiguration('academicReader')
                .get<string>('segmentationEngine', 'vision'),
              // 视觉结果能不能真的改写分段（合并/拆分）：默认允许，关掉 = 只改类型/顺序/丢弃
              visionSurgery: vscode.workspace.getConfiguration('academicReader').get<boolean>('visionSurgery', true),
              // 视觉模型名要在首屏渲染前就位：换模型后每页的视觉缓存要自动判废重判
              visionModel: vscode.workspace.getConfiguration('academicReader').get<string>('visionModel', '')
            });
            // Zotero 认领是"锦上添花"，绝不 await 在这个分支里：
            // 本地接口探测最长 4 秒，放在这里会让首屏白屏 4 秒。
            // 这一趟**只取元数据、不取全文**：此时还不知道 PDF 真实页数，
            // 没有页数就没法校验 Zotero 全文有没有错位，取了也可能白取。
            // 真正的全文注册在 pdfOpened 那一趟（带着真实页数）。
            void this.linkZoteroPaper(webviewPanel.webview, document.uri, undefined, false);
          } catch (err: any) {
            vscode.window.showErrorMessage(`加载 PDF 失败: ${err.message}`);
          }
          break;
        }

        /**
         * webview 加载完 PDF 后会把真实页数报上来。
         * 为什么要它：Zotero 全文按页存，只有拿真实页数比才能发现"只索引了前 N 页"，
         * 否则按页码取上下文会**静默错位**。宿主侧不去自己解析 PDF（多一份解析器就多一处不一致）。
         */
        case 'pdfOpened': {
          const pages = Number(message.pageCount) || 0;
          // pageHeights 由 webview 从 pdf.js 的 viewport 里取（键是 1 基页码）。
          // 没有它就无法把 Zotero 的批注坐标从"左下原点"翻成"左上原点"，所以这一趟才做批注导入。
          const heights: Record<number, number> = {};
          if (message.pageHeights && typeof message.pageHeights === 'object') {
            for (const [k, v] of Object.entries(message.pageHeights as Record<string, unknown>)) {
              const page = Number(k);
              const h = Number(v);
              if (Number.isFinite(page) && page > 0 && Number.isFinite(h) && h > 0) heights[page] = h;
            }
          }
          void this.linkZoteroPaper(
            webviewPanel.webview,
            document.uri,
            pages > 0 ? pages : undefined,
            true,
            heights
          );
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
          const { page, paraIndex, cacheKey, text, sentences, forceTranslate } = message;
          this.enqueueTranslate(webviewPanel.webview, document.uri, paperData, {
            page,
            paraIndex,
            cacheKey: cacheKey || `${page}_${hashText(text || '')}`,
            text: text || '',
            sentences: sentences || [],
            // 标题/摘要/章节标题即使很短也必须翻 —— 否则会被"非叙述内容原样保留"短路成英文
            forceTranslate: forceTranslate === true
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

        /**
         * 视觉版面判断结果落盘：同一页只花一次钱。
         * （visionModel 变了或页面内容变了才会重新请求，判断逻辑在 webview 侧。）
         */
        case 'syncVisionStructure': {
          if (message.page && message.structure) {
            const anyData = paperData as any;
            anyData.visionStructure = anyData.visionStructure || {};
            anyData.visionStructure[String(message.page)] = message.structure;
            try {
              await this.storageManager.savePaperData(document.uri, paperData);
            } catch (err: any) {
              console.warn('[AcademicReader] 保存视觉结构失败:', err?.message);
            }
          }
          break;
        }

        /**
         * 视觉版面判断：webview 把当前页渲成图，连同本地分段编号一起发来，
         * 由支持图片的模型判断「每段是什么类型、阅读顺序、该合该拆」。
         * 坐标不经过视觉模型 —— 划线高亮仍用本地文本层，见 segmentPageWithVision 的注释。
         */
        case 'requestVisionSegmentation': {
          const { page, imageBase64, mimeType, segments } = message;
          try {
            const result = await this.translator.segmentPageWithVision({
              imageBase64,
              mimeType,
              pageNum: page,
              segments: Array.isArray(segments) ? segments : []
            });
            webviewPanel.webview.postMessage({ type: 'visionSegmentationResult', page, result });
            vscode.window.setStatusBarMessage(
              `$(eye) 视觉分割：第 ${page} 页 ${result.segments.length} 段 · ${result.model} · ${(result.totalMs / 1000).toFixed(1)}s`,
              4000
            );
          } catch (err: any) {
            const errorText = this.describeError(err);
            console.warn('[AcademicReader] 视觉分割失败:', errorText);
            webviewPanel.webview.postMessage({ type: 'visionSegmentationError', page, errorText });
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
          const { requestId, question, selectedText, contextText, page, history, answerStyle, fullText, focusMath } = message;
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
                answerStyle: aiAnswerStyle,
                // 规范公式（视觉模型从页面图像转写的 LaTeX）：文本层抽出来的公式是残渣，
                // 不给模型规范式它就只能猜记号（读者问公式时答案会含糊、符号对不上号）
                focusMath: typeof focusMath === 'string' ? focusMath : '',
                // 专家模式：webview 现抽的**整篇文献**（所有页）——宿主自己只有用户翻过的页
                fullText: typeof fullText === 'string' ? fullText : ''
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
            // 版面分割引擎：webview 据此决定是否请视觉模型判断本页结构
            segmentationEngine: cfg.get<string>('segmentationEngine', 'vision'),
            // 视觉手术开关（真的按模型判断合并/拆分段落）
            visionSurgery: cfg.get<boolean>('visionSurgery', true),
            visionModel: cfg.get<string>('visionModel', ''),
            engineTag: this.engineTag(),
            available,
            listError,
            // 把扩展版本号一起下发，弹窗标题旁会显示：用户截图即可确认实际运行的版本，
            // 避免"改了没生效 / 跑的仍是旧版"这类问题反复排查。
            extensionVersion: (this.context?.extension?.packageJSON?.version as string) || '',
            hasKey: isOpenAI
              ? !!(cfg.get<string>('apiKey', '') || '').trim()
              : !!this.translator.getGeminiKey(cfg)
          });
          break;
        }

        case 'setAnswerStyle': {
          // 弹窗里一键切换回答风格 → 写回用户设置，重载或换论文后依然生效
          // 'reviewer'（审稿）是旧档位名，写回时统一成 'expert'（专家），免得设置里留着一个不存在的档位
          const raw = message.style === 'reviewer' ? 'expert' : message.style;
          const style = ['concise', 'standard', 'expert'].includes(raw) ? raw : 'standard';
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

        /**
         * AI 答疑记录落盘。
         * webview 每完成一次回答就发一条；以前问答只活在 webview 内存里，关窗即失。
         */
        case 'recordAiQa': {
          if (message.item && message.item.answer) {
            await this.storageManager.appendAiQa(document.uri, paperData, message.item);
          }
          break;
        }

        /**
         * 导出「全文双语精读稿」。
         * 文稿由 webview 侧生成（只有它手里有段落切分、句级译文与答疑上下文），
         * 宿主只负责问路径、写文件、打开。按钮与命令面板走的是同一条路。
         */
        case 'exportMarkdown': {
          // 兼容：旧版 webview 的按钮发的是这个消息，仍然走 Markdown 文稿
          this.requestReadingDoc(webviewPanel.webview);
          break;
        }

        /** 「导出笔记」按钮：让用户挑 Markdown 精读稿 还是 高光批注 PDF */
        case 'exportNotes': {
          await this.showExportMenu(webviewPanel.webview);
          break;
        }

        /** 命令面板触发的 PDF 导出 */
        case 'exportPdf': {
          await this.exportAnnotatedPdf();
          break;
        }

        case 'saveReadingDoc': {
          if (message.errorText) {
            vscode.window.showErrorMessage(`生成精读稿失败：${message.errorText}`);
            break;
          }
          await this.saveReadingDoc(document.uri, String(message.markdown || ''), message.suggestedName);
          break;
        }

        /**
         * 段落快照落盘（webview 每解析完一页发一次）。
         * 有了它，下次打开插件直接导出精读稿也仍然是"整篇"，而不是只剩最后一页。
         */
        case 'syncPageArchive': {
          if (message.page && Array.isArray(message.paragraphs) && message.paragraphs.length > 0) {
            paperData.pageArchive = paperData.pageArchive || {};
            const key = String(message.page);
            // 合并而不是覆盖：重开插件重读同一页时，新快照可能还没回填译文，
            // 直接替换会把之前存好的译文抹掉（导出 PDF 就只剩"（本段尚未翻译）"）。
            paperData.pageArchive[key] = mergeArchivedParagraphs(paperData.pageArchive[key], message.paragraphs);
            try {
              await this.storageManager.savePaperData(document.uri, paperData);
            } catch (err: any) {
              console.warn('[AcademicReader] 保存段落快照失败:', err?.message);
            }
          }
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
          // 不再用 VS Code 原生通知：它不会自动消失，用户必须手动点叉，
          // 而加高亮/加批注这类高频操作会迅速堆一串通知。
          // 改为在 webview 内自绘提示条（见 viewer.js 的 showReaderToast）。
          webviewPanel.webview.postMessage({ type: 'showToast', message: message.message, level: 'info' });
          break;
        }

        case 'showError': {
          vscode.window.showErrorMessage(message.message);
          break;
        }

        case 'webviewFatal': {
          // webview 侧发生未捕获异常：它会把错误画在界面上，这里再写一份到扩展日志，
          // 便于事后排查（命令面板 → Developer: Show Logs → Extension Host）。
          const text = String(message.message || '未知错误');
          console.error('[Bilingual Paper Reader] webview fatal:', text);
          vscode.window.showErrorMessage(
            '阅读器初始化出错，界面右下角有详细信息；也可在「Developer: Show Logs → Extension Host」查看日志。'
          );
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
      forceTranslate?: boolean;
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
        // forceTranslate 必须逐项透传：标题/摘要即使很短也不能被"非叙述内容"短路成英文
        batch.map(b => ({ text: b.text, sentences: b.sentences, forceTranslate: b.forceTranslate }))
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

  /**
   * 导出当前文献的「全文双语精读稿」。
   *
   * 真正生成文稿的是 webview（见 viewer.js 的 buildReadingDocMarkdown）：
   * 段落切分、句级译文对齐、批注挂段落、AI 答疑挂句子，这些信息只有它手里有。
   * 宿主这里只负责转发请求，收到 markdown 后再问路径写盘。
   * 命令面板（academicReader.exportNotesMarkdown）与阅读器里的「导出笔记」按钮共用它。
   */
  public async exportCurrentNotes(): Promise<void> {
    if (!this.currentActiveDocUri || !this.currentActiveWebview) {
      vscode.window.showWarningMessage('当前没有处于激活状态的文献阅读窗口，请先打开一篇 PDF。');
      return;
    }
    this.requestReadingDoc(this.currentActiveWebview);
  }

  /**
   * 询问这一次导出要不要「高光译文」，并把选择记忆到设置里。
   * 默认问一次而不是写死：有人要的是"我标注过的原文"（更小、更接近原论文），
   * 有人要的是"每条高光都配中文"。两者差别很大，交给用户自己决定。
   */
  private async askPdfTranslationMode(): Promise<boolean | undefined> {
    const cfg = vscode.workspace.getConfiguration('academicReader');
    const current = cfg.get<boolean>('pdfExportIncludeTranslation', true);
    const withTrans = {
      label: `$(book) 原文 + 高光译文${current ? '（上次的选择）' : ''}`,
      detail: '每条高光在左页边距标序号，紧跟一页给出 原文摘录 / 译文 / 我的批注 / AI 答疑',
      value: true
    };
    const withoutTrans = {
      label: `$(file-pdf) 只要高光后的原文${current ? '' : '（上次的选择）'}`,
      detail: '只保留原样原文页 + 高亮，体积更小；不需要中文字体，任何机器都能导',
      value: false
    };
    const items = current ? [withTrans, withoutTrans] : [withoutTrans, withTrans];
    const pick = await vscode.window.showQuickPick(items, {
      title: '导出高光批注 PDF',
      placeHolder: '要不要把高光对应的译文也放进 PDF？'
    });
    if (!pick) return undefined;
    if (pick.value !== current) {
      // 记住这次的选择，下次把它排在第一位
      await cfg.update('pdfExportIncludeTranslation', pick.value, vscode.ConfigurationTarget.Global);
    }
    return pick.value;
  }

  /**
   * 导出「高光批注 PDF」。
   *
   * 形态：**原封不动的全部原文页**（高亮按原坐标画回原位，颜色/透明度/混合模式与阅读器一致）；
   * 选"带高光译文"时，另外给每条高光在左页边距标序号，并在该原文页**紧跟一页**逐条给出
   * 原文摘录 → 译文 → 我的批注 → AI 答疑；末尾一页是导出说明。
   * 原文页用 copyPages 原样搬运，所以是矢量的、可搜索的，体积也小。
   */
  public async exportAnnotatedPdf(): Promise<void> {
    const uri = this.currentActiveDocUri;
    const paperData = this.currentActivePaperData;
    if (!uri || !paperData) {
      vscode.window.showWarningMessage('当前没有处于激活状态的文献阅读窗口，请先打开一篇 PDF。');
      return;
    }

    const includeTranslation = await this.askPdfTranslationMode();
    if (includeTranslation === undefined) return;

    try {
      const done = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在生成高光批注 PDF…', cancellable: false },
        async () => {
          const originalBytes = await vscode.workspace.fs.readFile(uri);
          const cfg = vscode.workspace.getConfiguration('academicReader');
          const result = await buildAnnotatedPdf({
            originalBytes,
            paperData,
            paperName: path.basename(uri.fsPath),
            fontPathOverride: cfg.get<string>('pdfExportFontPath', ''),
            includeAllPages: true,
            includeTranslation,
            // 译文缓存键里带着引擎标识；不传的话，重开插件后（段落快照里没有译文时）
            // 就查不到 `${page}_${引擎标识}_${指纹}` 的译文 —— 用户看到的就是"译文没同步"
            engineTag: this.engineTag()
          });

          const baseName = path.basename(uri.fsPath, path.extname(uri.fsPath));
          const defaultUri = vscode.Uri.file(path.join(path.dirname(uri.fsPath), `${baseName}-高光批注.pdf`));
          const target = await vscode.window.showSaveDialog({
            defaultUri,
            saveLabel: '导出 PDF',
            filters: { PDF: ['pdf'] }
          });
          if (!target) return;

          await vscode.workspace.fs.writeFile(target, result.bytes);
          const summary = [
            `原文 ${result.sourcePages} 页`,
            includeTranslation
              ? result.appendixPages > 0
                ? `高光译文 ${result.appendixPages} 页`
                : '未附译文'
              : '仅原文与高亮',
            `高亮 ${result.drawnAnnotations} 条`,
            // 让"译文只覆盖了一部分"这件事一眼可见，而不是让用户翻到译文页才发现
            includeTranslation && result.sourcePages > 0
              ? `译文覆盖 ${result.translatedPages.length}/${result.sourcePages} 页`
              : ''
          ]
            .filter(Boolean)
            .join(' · ');
          // 【不要自动用系统程序打开】用户机器上 .pdf 可能根本没有关联程序，
          // openExternal 失败时 VS Code 会自己弹一个"打开外部程序时出错"的对话框，
          // 我们的 try/catch 拦不住它（实测：0x2 系统找不到指定的文件）。
          // 改成给按钮，由用户自己决定。
          const action = await vscode.window.showInformationMessage(
            `高光批注 PDF 已导出：${path.basename(target.fsPath)}（${summary}）`,
            '在文件夹中显示',
            '打开 PDF'
          );
          if (action === '在文件夹中显示') {
            try {
              await vscode.commands.executeCommand('revealFileInOS', target);
            } catch (e: any) {
              vscode.window.showWarningMessage(`打开文件夹失败：${e?.message || e}`);
            }
          } else if (action === '打开 PDF') {
            // 用户明确要求打开才尝试；失败与否交给 VS Code 自己提示
            await vscode.env.openExternal(target);
          }
          result.warnings.forEach(w => vscode.window.showWarningMessage(w));
        }
      );
      void done;
    } catch (e: any) {
      vscode.window.showErrorMessage(`导出高光批注 PDF 失败：${e?.message || e}`);
    }
  }

  /**
   * 「导出笔记」按钮的菜单：两条出口（Markdown 精读稿 / 高光批注 PDF）。
   * 这两个功能形态差别很大，用菜单比塞两个工具栏按钮清楚。
   */
  private async showExportMenu(webview: vscode.Webview): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(markdown) 全文双语精读稿（Markdown）',
          detail: '原文 / 译文 / 我的批注 / AI 答疑 按段落交织，Obsidian 友好',
          key: 'md'
        },
        {
          label: '$(file-pdf) 高光批注 PDF（全篇原文 + 译文附录）',
          detail: '原文页原样保留、高亮画回原位；后面附逐页译文与笔记',
          key: 'pdf'
        }
      ],
      { title: '导出笔记', placeHolder: '选择导出格式' }
    );
    if (!pick) return;
    if (pick.key === 'pdf') {
      await this.exportAnnotatedPdf();
    } else {
      this.requestReadingDoc(webview);
    }
  }

  /** 请 webview 生成精读稿（结果通过 saveReadingDoc 消息回来） */
  private requestReadingDoc(webview: vscode.Webview): void {
    webview.postMessage({ type: 'buildReadingDoc' });
  }

  /**
   * 把 webview 生成好的精读稿写盘。
   * 用「另存为」对话框而不是直接写到 PDF 旁边：文献目录通常是要保持干净的，
   * 用户也可能想把精读稿放进自己的笔记库。
   */
  private async saveReadingDoc(pdfUri: vscode.Uri, markdown: string, suggestedName?: string): Promise<void> {
    if (!markdown.trim()) {
      vscode.window.showWarningMessage('精读稿是空的：请先翻阅几页，让插件解析并翻译段落。');
      return;
    }
    const baseName = path.basename(pdfUri.fsPath, path.extname(pdfUri.fsPath));
    const defaultUri = vscode.Uri.file(
      path.join(path.dirname(pdfUri.fsPath), suggestedName || `${baseName}-双语精读稿.md`)
    );
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      saveLabel: '导出精读稿',
      filters: { Markdown: ['md'] }
    });
    if (!target) return;

    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(`双语精读稿已导出：${path.basename(target.fsPath)}`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`导出精读稿失败：${e?.message || e}`);
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
    // KaTeX：本地打包（含字体），不走 CDN —— 论文里的公式必须离线可渲染
    const katexCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'katex', 'katex.min.css')
    );
    const katexJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'katex', 'katex.min.js')
    );

    const nonce = getNonce();
    const v = Date.now();
    // 把扩展版本号直接注入页面（不走消息，避免"消息没到 → 看不出跑的哪一版"）。
    // webview 会把它显示在 AI 弹窗标题旁，用户截图即可确认实际运行的版本。
    const extVersion = String(this.context?.extension?.packageJSON?.version || '');

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource} data:; connect-src ${webview.cspSource} blob: data: https:; img-src ${webview.cspSource} data: blob:;">
  <title>双栏文献阅读器</title>
  <link rel="stylesheet" href="${cssUri}?v=${v}">
  <link rel="stylesheet" href="${katexCssUri}?v=${v}">
  <script nonce="${nonce}">window.__EXT_VERSION__ = ${JSON.stringify(extVersion)};</script>
  <script nonce="${nonce}" src="${katexJsUri}?v=${v}"></script>
</head>
<body>
  <!-- 顶部工具栏 -->
  <header class="app-header">
    <div class="header-left">
      <span class="paper-title" id="paperTitle" title="文献标题">加载中...</span>
      <!-- 当前实际加载的扩展版本号：由宿主 HTML 直接渲染（不依赖 viewer.js），
           因此它能可靠地回答"VS Code 到底加载了哪一版扩展"。
           若这里显示的不是刚安装的版本，说明 VS Code 尚未重新加载扩展（需完全退出后重开）。 -->
      <span class="ext-version-badge" id="extVersionBadge" title="当前加载的扩展版本；若与刚安装的版本不符，说明 VS Code 还没有重新加载扩展">v${extVersion || '?'}</span>
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
        <button id="tabIndexBtn" class="tab-btn" title="全文公式与符号索引（读论文时查符号最常用）">
          公式·符号 (<span id="indexCount">0</span>)
        </button>
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
            <!-- 【没有「视觉重排」按钮】视觉判断是每一页渲染时默认就做的（见 buildAcademicLayout 的调度），
                 不需要手动触发；想重判某一页就换一个视觉模型，或关掉/打开 academicReader.visionSurgery。 -->
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

      <!-- 视图 2: 全文公式与符号索引 -->
      <div id="indexView" class="pane-view">
        <div class="pane-view-header">
          <div class="header-info">
            <span class="badge badge-accent">公式·符号索引</span>
            <span class="subtitle" id="indexSubtitle">读过的页会自动收录</span>
          </div>
          <div class="view-switch-tools">
            <button id="indexFilterFormula" class="view-toggle-btn active" title="只列公式">公式</button>
            <button id="indexFilterSymbol" class="view-toggle-btn" title="只列符号">符号</button>
          </div>
        </div>
        <div class="index-toolbar">
          <input id="indexSearchInput" class="index-search-input" type="search" placeholder="搜索符号或公式，例如 W^l、\alpha、AttID" />
        </div>
        <div id="indexListContainer" class="index-list-container">
          <div class="empty-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/></svg>
            <p>还没有可索引的公式。<br>翻过几页（视觉模型判过版式的页）就会自动收录在这里。</p>
          </div>
        </div>
      </div>

      <!-- 视图 3: 文献批注与笔记列表 -->
      <div id="notesView" class="pane-view">        <div class="pane-view-header">
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

  <!-- 核心：AI 学术文献导师问答弹窗 (AI Academic Assistant Dialog)
       ⚠️ 这里的结构必须与 media/viewer.js 的 ensureAiModalControls() 保持一致：
       所有「问AI」入口（划词浮条 / 右键菜单 / 段落聚焦条 / 译文卡片 / 笔记卡片 / 快捷键 Q）
       最终都打开这一个弹窗，**回答风格切换必须出现在它的固定头部里**，
       否则用户会以为"功能没做"。两条路径都有回归测试：
       scratch/host_html_smoke.js（真实宿主 HTML）与 scratch/smoke_init.js（viewer 自建弹窗）。 -->
  <div id="aiAssistantModal" class="ai-assistant-modal" style="display: none;">
    <div class="ai-modal-card">
      <div class="ai-modal-header">
        <div class="ai-modal-title">
          <span>AI 学术文献导师</span>
          <span class="ai-model-tag" id="aiModalModelTag">未连接</span>
          <!-- 扩展版本号：打开即显示（由 viewer.js 依据 window.__EXT_VERSION__ 填值），截图即可确认跑的哪一版 -->
          <span class="ai-modal-version" id="aiModalVersion"></span>
        </div>
        <div class="ai-modal-header-actions">
          <!-- 回答风格切换放在**固定头部**：弹窗主体是滚动区域，
               此前放在主体底部/输入框上方都会被长对话滚出视野（用户反馈"有代码但看不到"）。 -->
          <div id="aiModalStyleSlot"></div>
          <button id="btnClearAiConversation" class="ai-text-btn" type="button" title="清空对话，另起一个话题">新话题</button>
          <button id="btnCloseAiModal" class="btn-close-mini" title="关闭 (Esc)">&times;</button>
        </div>
      </div>
      <div class="ai-modal-body">
        <div class="ai-modal-context">
          <div class="ai-context-text" id="aiModalQuote"></div>
          <!-- 聚焦的公式会带上"规范 LaTeX"一起提问：这里让读者看得见这件事（默认隐藏） -->
          <div class="ai-math-badge" id="aiModalMathBadge" style="display: none;"></div>
          <!-- 规范公式本身就排版在弹窗里：读者聚焦的就是这条式子，别再让他看残渣 -->
          <div class="ai-math-preview" id="aiModalMathPreview" style="display: none;"></div>
        </div>
        <div class="ai-prompt-chips">
          <button type="button" class="ai-chip" data-q="这句话的真实技术意图与核心动机是什么？请用通俗中文讲透。">核心动机</button>
          <button type="button" class="ai-chip" data-q="作者在此处与以往前人方法有何本质区别？优势在哪里？">与前人区别</button>
          <button type="button" class="ai-chip" data-q="这句话里涉及的术语、公式或方法背后的数学原理是什么？">术语与公式</button>
          <!-- 公式专用：逐符号讲透（聚焦公式本身，不跑题到论文背景） -->
          <button type="button" class="ai-chip ai-chip-math" data-q="请把这条公式讲透：先用 $$...$$ 写出规范形式，再逐符号列表说明（符号、含义、形状或取值范围、在哪里定义），然后说清它在做什么，最后代一个具体的小例子走一遍。">讲透这条公式</button>
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
