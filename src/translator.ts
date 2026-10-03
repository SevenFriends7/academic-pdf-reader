import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import {
  generate,
  callOpenAICompatStream,
  LlmError,
  listAvailableModels,
  DEFAULT_TRANSLATION_MODEL,
  DEFAULT_ASSISTANT_MODEL,
  filterUsableModel,
  KNOWN_GOOD_MODELS,
  type LlmTurn
} from './llmClient';

export interface StructuredParagraph {
  type: 'title' | 'abstract' | 'keywords' | 'significance' | 'body' | string;
  original: string;
  translation: string;
  boxes?: number[][];
}

/** 逐句对齐的取得方式——UI 需要如实告知用户，不能假装对齐成功 */
export type AlignmentMode = 'sentence-json' | 'per-sentence' | 'unaligned';

/**
 * 容易被硬译成中文生造词的英文构词后缀（如 object-agnostic → "对象无关"）。
 * 这类词硬译后读者既无法理解、也无法拿去查证原文，必须保留英文原词。
 */
const RISKY_TERM_RE = /-(\s*)(agnostic|free|invariant|aware|based|driven|guided|specific|conditional|dependent|independent)\b/gi;

/** 找出源文本里"必须保留英文原词"、但译文里缺失的术语 */
export function missingRiskyTerms(source: string, out: string): string[] {
  const src = source || '';
  const terms = new Set<string>();
  RISKY_TERM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RISKY_TERM_RE.exec(src)) !== null) {
    // 取整个连字符词组（object-agnostic / category-specific）
    const head = src.slice(0, m.index).match(/[A-Za-z]+$/);
    terms.add(`${head ? head[0] : ''}${m[0]}`.replace(/\s+/g, ''));
  }
  if (terms.size === 0) return [];
  const lower = (out || '').toLowerCase();
  return [...terms].filter(t => !lower.includes(t.toLowerCase()));
}

/**
 * 术语兜底：模型拒绝在译文里保留英文原术语时，在**出站前**补上英文原词。
 *
 * 为什么放在这里而不是只靠提示词：实测 DeepSeek 即使被明确要求"必须用括号附英文原词"，
 * 仍会写成"与对象无关"；而且在 JSON 路径失败退化为逐句翻译后，提示词的约束还会进一步变弱。
 * 出站前统一兜底可以覆盖所有翻译路径，保证读者至少能查到原术语。
 */
export function applyTermGlossary(
  source: string,
  translation: string,
  sourceSentences?: string[],
  translatedSentences?: string[]
): { translation: string; sentences?: string[] } {
  let out = translation || '';
  const missingInWhole = missingRiskyTerms(source, out);
  if (missingInWhole.length > 0) {
    out = `${out}\n\n（术语原文：${missingInWhole.join('、')}）`;
  }

  let sentences = translatedSentences;
  if (sentences && sentences.length > 0 && sourceSentences && sourceSentences.length > 0) {
    sentences = sentences.map((zh, i) => {
      const en = sourceSentences[Math.min(i, sourceSentences.length - 1)] || '';
      const miss = missingRiskyTerms(en, zh);
      if (miss.length === 0) return zh;
      // 逐句译文结尾补上英文原词，读者一眼能看到该查什么
      return `${String(zh).replace(/\s+$/, '')}（${miss.join('、')}）`;
    });
  }

  return { translation: out, sentences };
}

export interface ParagraphTranslation {
  translation: string;
  sentences: string[];
  /** true 表示 sentences[i] 确实对应第 i 句英文 */
  aligned: boolean;
  mode: AlignmentMode;
  model?: string;
  /** 非致命异常的说明（模型回退、对齐重试等），UI 可直接展示 */
  note?: string;
}

/** `action=split` 时：拆出来的**每一片**（顺序即阅读顺序） */
export interface VisionPart {
  /** 这一片的真实类型 */
  type: string;
  /** 这一片开头的原文文字（**按文本层残渣写法**给出，webview 据此在 cleanText 上定位切点；第一片可省） */
  at?: string;
  /** 这一片是公式时，看图转写的 LaTeX */
  latex?: string;
}

/** 正文里夹着的行内公式：把文本层残渣替换成可渲染的 LaTeX（只影响显示） */
export interface VisionInlineMath {
  /** 必须在该段 cleanText 里**逐字出现**的残渣子串 */
  find: string;
  /** 可渲染的 LaTeX */
  latex: string;
}

/** 视觉模型对"本地某一段"的判断 */
export interface VisionSegment {
  /** 与请求里 segments[].id 对应的编号 */
  index: number;
  /** 模型判断的真实类型 */
  type: string;
  /** 阅读顺序（1 起） */
  order?: number;
  /**
   * 图块编号：同一张图/表的**图内文字与它的图注**共享同一个正整数。
   * webview 据此把图注留成一张卡片、把图内文字整片丢掉，并让它们排在一起。
   */
  group?: number;
  /** 建议动作：保留 / 与**紧随其后的那一段**合并 / 需要拆分 / 丢弃（页眉页脚页码等） */
  action?: 'keep' | 'merge_next' | 'split' | 'drop';
  /** 一句话理由（模型给的） */
  why?: string;
  /** 公式的 LaTeX 转写（模型看图写的；文本层抽不出可渲染的 LaTeX） */
  latex?: string;
  /** action=split 时：拆出来的每一片（含各自的类型与 LaTeX） */
  parts?: VisionPart[];
  /** action=split 时：新片段开头的原文文字（旧协议字段，仍解析；无 parts 时按它兜底拆分） */
  splitAt?: string[];
  /** 段内行内公式的替换表（显示层渲染，不动坐标、不改送翻译的原文） */
  inline?: VisionInlineMath[];
}

export interface VisionSegmentationResult {
  /** 协议版本：2 起才有 parts/group/inline（旧缓存据此判废，见 webview 的 isUsableVisionCache） */
  version: number;
  /** 模型判断的栏数（1/2/3…） */
  columns?: number;
  segments: VisionSegment[];
  /** 一句话总结改了什么 */
  fixes?: string;
  model: string;
  totalMs: number;
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

/** 视觉协议版本（升协议必须同时升它，否则旧缓存会被当成新结果用） */
export const VISION_PROTOCOL_VERSION = 2;

export interface AcademicAnswer {
  answer: string;
  model: string;
  ttftMs?: number;
  totalMs: number;
  note?: string;
}

/**
 * 公式输出格式的统一要求（所有翻译提示词共用这一份，避免六处提示词各写一句、以后改漏）。
 *
 * 【为什么必须写死 LaTeX】PDF 文本层抽出来的公式是 "Y ̂ t = S θ (X t)" 这种残渣：
 * 上下标全丢、希腊字母变普通字符。若只要求"原样保留"，模型就把残渣抄进中文译文——
 * 那种文本 KaTeX 无从渲染，界面上怎么都排不出公式（用户实测反馈的原话：
 * "右边应该还是有 latex 渲染"）。
 * 要求模型把公式**转写成 $...$ 的 LaTeX**，译文侧就再也不依赖"视觉模型额外给一张替换表"，
 * 而且导出的 Markdown 精读稿在 Obsidian / Typora 里也能直接渲染。
 */
const FORMULA_LATEX_RULE =
  '公式一律转写成 LaTeX 并用 $...$ 包起来（独立成行的公式用 $$...$$），例如 $\\hat{Y}_t = S_\\theta(X_t)$，' +
  '不要保留 "Y ̂ t" 这种从 PDF 文本层抄来的残渣；数学符号、变量名、缩写、文献引用编号仍原样保留';

const EN_LANGS: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  'en': '英文',
  'ja': '日语',
  'ko': '韩语',
  'de': '德语',
  'fr': '法语'
};

function langName(code?: string): string {
  const c = (code || 'zh-CN').trim();
  return EN_LANGS[c] || c;
}

function isUsable(s: string | undefined): boolean {
  return !!s && !!s.trim() && !s.startsWith('[未能') && !s.startsWith('[翻译出错');
}

/** 极简并发闸门：把整页 30 个并行请求压到可控并发，避免触发 429 后整体退化 */
class ConcurrencyGate {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/** 同内容去重：同一段落在多处同时触发翻译时只打一次 API */
function contentKey(text: string, lang: string, model: string): string {
  // FNV-1a 32bit + 长度，避免旧版"前 28 字符"签名导致的不同段落碰撞
  let h = 0x811c9dc5;
  const s = `${lang}|${model}|${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${s.length}`;
}

export class PaperTranslator {
  private cache: Map<string, string> = new Map();
  private paraCache: Map<string, ParagraphTranslation> = new Map();
  private inflight: Map<string, Promise<ParagraphTranslation>> = new Map();
  private gate: ConcurrencyGate;
  private log: (msg: string) => void;
  /** 页面文本索引（page -> 段落数组），用于 AI 问答注入全文上下文 */
  private pageTextIndex: Map<number, { type: string; text: string }[]> = new Map();
  /** 正在进行的 AI 问答，用于取消 */
  private aiRequests: Map<string, AbortController> = new Map();

  constructor(log?: (msg: string) => void) {
    this.log = log || ((m: string) => console.log(`[Translator] ${m}`));
    const cfg = vscode.workspace.getConfiguration('academicReader');
    const limit = Math.max(1, Math.min(8, cfg.get<number>('translateConcurrency', 3)));
    this.gate = new ConcurrencyGate(limit);
  }

  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('academicReader');
  }

  public getGeminiKey(config?: vscode.WorkspaceConfiguration): string {
    const c = config || this.cfg();
    const fromConfig = (c.get<string>('geminiApiKey', '') || '').trim();
    if (fromConfig) return fromConfig;
    return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  }

  /** 用户配置的翻译模型；不做任何"智能改写"，只过滤已明确下线的模型 */
  private translationModel(): string {
    const raw = (this.cfg().get<string>('geminiModel', '') || '').trim();
    const usable = filterUsableModel(raw);
    if (raw && !usable) {
      this.log(`配置的翻译模型 ${raw} 已下线，改用 ${DEFAULT_TRANSLATION_MODEL}`);
    }
    return usable || DEFAULT_TRANSLATION_MODEL;
  }

  private assistantModel(): string {
    const raw = (this.cfg().get<string>('aiModel', '') || '').trim();
    const usable = filterUsableModel(raw);
    if (usable) return usable;
    // 未单独配置 AI 模型时，沿用翻译模型（用户可能已换成自己喜欢的）
    const t = filterUsableModel((this.cfg().get<string>('geminiModel', '') || '').trim());
    return t || DEFAULT_ASSISTANT_MODEL;
  }

  /**
   * 翻译用的思考配置。默认「关闭思考」（thinkingBudget: 0）：
   * 实测 gemini-3.5-flash 默认思考会额外消耗约 1000 个思考 token、首字延迟从 ~1s 变成 ~19s，
   * 而翻译这种确定性任务并不需要推理。设为 -1 可恢复模型默认。
   */
  private thinkingConfig(): object | undefined {
    const budget = this.cfg().get<number>('translationThinkingBudget', 0);
    if (typeof budget === 'number' && budget >= 0) {
      return { thinkingBudget: budget };
    }
    return undefined;
  }

  /**
   * AI 问答用的思考配置。默认「交给模型自己决定」：
   * 问答需要推理，且流式输出下用户能立刻看到首字，值得换更好的答案质量。
   */
  private assistantThinkingConfig(): object | undefined {
    const budget = this.cfg().get<number>('aiThinkingBudget', -1);
    if (typeof budget === 'number' && budget >= 0) {
      return { thinkingBudget: budget };
    }
    return undefined;
  }

  private fallbackChain(): string[] {
    return KNOWN_GOOD_MODELS.slice();
  }

  public listModels(force = false): Promise<string[]> {
    return listAvailableModels(this.getGeminiKey(), force);
  }

  // ==========================================================================
  // 段落翻译：一次请求拿到「整段译文 + 严格逐句译文」
  // ==========================================================================

  public async translateParagraph(
    text: string,
    sentences: string[],
    targetLang?: string
  ): Promise<ParagraphTranslation> {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      return { translation: '', sentences: [], aligned: true, mode: 'sentence-json' };
    }

    const cfg = this.cfg();
    const lang = targetLang || cfg.get<string>('targetLanguage', 'zh-CN');
    const service = cfg.get<string>('translationService', 'gemini');

    // 非叙述性内容（人名名单、机构、图表标签、公式片段）不送去翻译：
    // 模型会把它们原样返回，随后被"照搬原文"校验拦下、在界面上弹出红色报错。
    // 直接原样保留并说明原因，既省一次 API 调用，也不产生假错误。
    if (this.looksNonProse(trimmed)) {
      return {
        translation: trimmed,
        sentences: sentences.length === 1 ? [trimmed] : [],
        aligned: true,
        mode: sentences.length === 1 ? 'sentence-json' : 'unaligned',
        note: '该段像是人名/机构/图表标签等非叙述内容，已原样保留（未调用翻译接口）'
      };
    }

    // 缓存与并发去重对所有引擎生效。
    // （旧版非 Gemini 引擎在这段之前就 return 了，导致 DeepSeek 每次都要重新打 API）
    const engineKey =
      service === 'gemini' ? this.translationModel() : (cfg.get<string>('modelName', '') || 'default');
    const key = contentKey(trimmed, lang, `${service}:${engineKey}`);

    const cached = this.paraCache.get(key);
    if (cached) return cached;

    const running = this.inflight.get(key);
    if (running) return running;

    const task = this.gate.run(() =>
      service !== 'gemini'
        ? this.translateWithoutGemini(trimmed, sentences || [], lang, service)
        : this.doTranslateParagraph(trimmed, sentences || [], lang)
    );
    this.inflight.set(key, task);
    try {
      const result = await task;
      this.paraCache.set(key, result);
      return result;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * 判断一段内容是否"不是叙述性正文"——人名名单、机构、图表标签、公式片段。
   * 这类内容翻不翻都一样，送去翻译只会换来一句"照抄原文"和一次红色报错。
   */
  private looksNonProse(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    // 以句末标点收尾 → 当作正文，照常翻译
    if (/[.!?。！？]["'”’)\]]?\s*$/.test(t)) return false;
    // 章节标题（"2. Related Work" / "III. Method"）照常翻译
    if (/^(\d+(\.\d+)*\.?|[IVXLC]+\.)\s+\S/.test(t)) return false;
    // 通篇没有任何句末标点、却有相当长度 → 过去一律当成"图表内部标签簇"
    // （坐标轴标签、图例、子图编号被拼成一段）。
    //
    // 【踩过的坑】正文被**从中间切开**的片段也长这样：以 `:` / `,` 结尾、内部一个句号都没有。
    // 视觉手术把"正文 + 公式 + 正文"拆成三段之后，这种片段会大量出现，于是它们全被
    // "原样保留、不调用翻译接口"——用户看到的就是"这一段的译文是英文原文"。
    // 所以再加一条判据：有逗号/分号，且有 the/we/can/of 这类虚词 → 人家在叙述，不是标签。
    if (t.length > 60 && !/[.!?。！？]/.test(t)) return !this.looksLikeClauseRun(t);
    if (t.length > 200) return false;

    const words = (t.match(/[A-Za-z][A-Za-z'\-]*/g) || []).length;
    if (words < 3) return true; // "Figure 2"、"(a) (b)" 这类
    const proper = (t.match(/\b[A-Z][a-z]+\b/g) || []).length;
    if (proper / Math.max(1, words) > 0.5) return true; // 大写词占多数 → 名单/机构
    return t.length < 60; // 短且无句末标点 → 标签
  }

  /**
   * 像"在叙述"而不是"一堆标签"吗？
   *
   * 图表标签簇是 `Extra data OL J S (%) J U (%) F S (%) FPS` / `Segmentation Network Loss`：
   * 既没有逗号分号，也没有 the/we/can/of 这类虚词。而"正文被切开"的片段是
   * `With the cyclic reference set, we can obtain the prediction for the initial reference mask in the
   * same manner as sequential processing:` —— 逗号 + 一串虚词，明显在叙述。
   * 两条同时满足才算叙述，宁严不宽：把标签误送去翻译只是多一次请求，
   * 把正文误判成标签则会让用户看到"整段没翻译"。
   */
  private looksLikeClauseRun(t: string): boolean {
    const commas = (t.match(/[,;:，；：]/g) || []).length;
    if (commas < 1) return false;
    const funcWords = (
      t.match(
        /\b(?:the|a|an|of|to|in|for|and|or|that|this|these|those|we|our|us|is|are|was|were|be|been|being|can|could|will|would|should|may|might|must|with|as|by|on|at|from|it|its|which|where|when|while|than|then|thus|hence|however|also|if|but|so|such|each|both|all|not|no|more|most|other|into|over|after|before|during|between|without|via)\b/gi
      ) || []
    ).length;
    const words = (t.match(/[A-Za-z][A-Za-z'\-]*/g) || []).length;
    return funcWords >= 3 && funcWords / Math.max(1, words) >= 0.15;
  }

  /**
   * 清掉历史遗留的"假译文"缓存（详见 pdfEditorProvider 里的调用注释）。
   *
   * 两条判据取并集，都要求"内容确实像在叙述"（真正的标题/机构/图注/公式残渣没有从句结构，
   * 不会被误伤）：
   *   ① alignment 的 note 写着"未调用翻译接口"——这是当年那条 looksNonProse 短路路径留下的；
   *   ② 值里**一个汉字都没有**、却明显是英文散文 —— 目标是中文时，这种值必然是假的
   *      （模型不可能把英文"译"成英文还通过校验，只可能是"原文被当成了译文"）。
   * 只有目标语言是中文时才做，避免把"翻成英文"的正常结果删掉。
   *
   * @returns 清理掉的条目数
   */
  public pruneStaleNonProseCache(data: {
    translations?: Record<string, string>;
    sentenceTranslations?: Record<string, string[]>;
    alignment?: Record<string, { note?: string }>;
  }): number {
    if (!data || typeof data !== 'object') return 0;
    let lang = 'zh-CN';
    try {
      lang = this.cfg().get<string>('targetLanguage', 'zh-CN') || 'zh-CN';
    } catch {
      /* 配置读不到就按默认的中文处理 */
    }
    if (!lang.startsWith('zh')) return 0;

    const align = data.alignment || {};
    // 键取"有译文的"与"有 alignment 记录的"并集：
    // 有些假译文是更早的版本写下的，压根没有 alignment 记录（实测第 4 页就有两条），
    // 只看 alignment 会漏掉它们。
    const allKeys = new Set<string>([
      ...Object.keys(data.translations || {}),
      ...Object.keys(align)
    ]);
    const stale = Array.from(allKeys).filter(k => {
      const note = String((align[k] && align[k].note) || '');
      const whole = (data.translations && data.translations[k]) || '';
      const perSentence = ((data.sentenceTranslations && data.sentenceTranslations[k]) || []).join(' ');
      // 这些条目的"译文"就是原文本身，所以直接拿它当原文来判断是不是在叙述
      const text = whole || perSentence;
      if (String(text).length <= 60) return false; // 短的多半是"标签原样保留"，合法
      if (!this.looksLikeClauseRun(text)) return false;
      const markedByOldShortcut = note.indexOf('未调用翻译接口') >= 0;
      const noCjkAtAll = this.countCjk(text) === 0;
      return markedByOldShortcut || noCjkAtAll;
    });
    stale.forEach(k => {
      if (data.translations) delete data.translations[k];
      if (data.sentenceTranslations) delete data.sentenceTranslations[k];
      if (data.alignment) delete data.alignment[k];
    });
    return stale.length;
  }

  /**
   * 批量翻译：把同一页的多个段落合并成**一次** API 请求。
   *
   * 为什么需要它：免费档 API Key 的真正瓶颈是「每分钟请求数(RPM)」。
   * 逐段翻译时一页 20 段就是 20 次请求，必然触发 429，而重试退避又把每次都拖慢几秒——
   * 用户感受到的就是"越翻越慢"。合并成 4 段一次请求，请求数直接降到 1/4。
   *
   * 返回数组与 inputs 一一对应；某一项是 Error 表示该段需要单独重试/上报。
   */
  public async translateParagraphsBatch(
    inputs: { text: string; sentences: string[] }[],
    targetLang?: string
  ): Promise<(ParagraphTranslation | Error)[]> {
    const cfg = this.cfg();
    const lang = targetLang || cfg.get<string>('targetLanguage', 'zh-CN');
    const service = cfg.get<string>('translationService', 'gemini');

    const results: (ParagraphTranslation | Error | null)[] = inputs.map(() => null);

    // 非 Gemini 引擎（自定义大模型 / 内置）走各自的单段实现，避免两套逻辑分叉。
    // 注意：这里必须**并行**（旧版写成串行 for-await，一页 20 段 × 每次 1~3s 会拖到几十秒）。
    if (service !== 'gemini') {
      const CONCURRENCY = 3;
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const i = cursor++;
          if (i >= inputs.length) return;
          try {
            results[i] = await this.translateParagraph(inputs[i].text, inputs[i].sentences, lang);
          } catch (e: any) {
            results[i] = e instanceof Error ? e : new Error(String(e));
          }
        }
      };
      await Promise.all(new Array(Math.min(CONCURRENCY, inputs.length)).fill(0).map(() => worker()));
      return results as (ParagraphTranslation | Error)[];
    }

    const apiKey = this.getGeminiKey(cfg);
    if (!apiKey) throw new LlmError({ kind: 'no-key' });

    const model = this.translationModel();

    // 1) 先吃掉缓存里已有的
    const pending: number[] = [];
    inputs.forEach((it, i) => {
      const key = contentKey((it.text || '').trim(), lang, model);
      const cached = this.paraCache.get(key);
      if (cached) {
        results[i] = cached;
      } else {
        pending.push(i);
      }
    });
    if (pending.length === 0) return results as (ParagraphTranslation | Error)[];

    // 2) 只有一个待翻段落时不必绕道批量，直接走单段（含重试与降级）
    if (pending.length === 1) {
      const i = pending[0];
      try {
        results[i] = await this.translateParagraph(inputs[i].text, inputs[i].sentences, lang);
      } catch (e: any) {
        results[i] = e instanceof Error ? e : new Error(String(e));
      }
      return results as (ParagraphTranslation | Error)[];
    }

    // 3) 合并成一次请求；整批失败或个别段落不合格的，再单独补
    try {
      const batched = await this.gate.run(() =>
        this.doTranslateBatch(pending.map(i => inputs[i]), lang, apiKey, model)
      );
      batched.forEach((r, k) => {
        if (r) results[pending[k]] = r;
      });
    } catch (err: any) {
      this.log(`批量翻译整批失败，回退为逐段翻译：${err?.message}`);
    }

    // 4) 仍为 null 的段落单独重试（每段自己如实报错）
    for (let k = 0; k < pending.length; k++) {
      const i = pending[k];
      if (results[i]) continue;
      try {
        results[i] = await this.translateParagraph(inputs[i].text, inputs[i].sentences, lang);
      } catch (e: any) {
        results[i] = e instanceof Error ? e : new Error(String(e));
      }
    }

    return results as (ParagraphTranslation | Error)[];
  }

  /** 一次请求翻译多个段落；返回 null 表示该段需要单独重试 */
  private async doTranslateBatch(
    batch: { text: string; sentences: string[] }[],
    lang: string,
    apiKey: string,
    model: string
  ): Promise<(ParagraphTranslation | null)[]> {
    const target = langName(lang);
    const K = batch.length;
    const expected = batch.map(b => (b.sentences || []).length);

    const body = batch
      .map((b, i) => {
        const list = (b.sentences || []).map((s, j) => `[${i + 1}.${j + 1}] ${s}`).join('\n');
        return `【第 ${i + 1} 段】共 ${expected[i]} 句\n${list}`;
      })
      .join('\n\n');

    const prompt = `下面是一篇学术论文同一页的 ${K} 个段落。请逐段翻译为${target}，并给出每段的逐句译文。

${body}

【输出要求】
返回一个 JSON 对象，形如 {"items":[ … ]}。
"items" 数组**必须恰好 ${K} 个元素**，顺序与上面段落顺序一致。每项包含：
- "index"：段号，从 1 开始
- "translation"：该段整段连贯、严谨的中文学术译文
- "sentences"：该段逐句译文数组，**长度必须等于该段标注的句数**，第 j 项只对应第 j 句，不得合并或拆分

【翻译铁律】（逐条遵守，违反任何一条都算不合格）
1. **忠实优先于流畅**：不得增删原意，不得省略限定词（all / only / not / may / must 等），
   不得改变逻辑关系（因果、转折、条件、让步）。宁可句子长一点，也不要漏掉信息。
2. **必须换成中文语序，禁止照搬英文语序**。典型错误：把英语的后置状语原样拖到句尾，
   写出「……，给定引导信息。」这种悬空状语。时间/条件/方式/伴随状语要按中文习惯前置，
   长句按中文习惯拆分重组。
3. **术语不得生造直译**。带连字符、或含 -agnostic / -free / -invariant / -aware / -based 等构词的专业术语，
   中文译法后**必须用括号附上英文原词**（例：与目标类别无关（object-agnostic））。
   拿不准中文译法时就直接保留英文原词，**不要硬译成中文生造词**。
   反例：把 object-agnostic 单独译成"对象无关"——中文没有这个说法，读者既无法理解也无法查证原文。
   有通行译法的术语（如 key-value addressing → 键值寻址）用通行译法，并同样附一次原文。
4. ${FORMULA_LATEX_RULE}；必须输出中文译文，绝对不要复制英文原文；
   只输出 JSON，不要任何解释。`;

    let res;
    try {
      res = await generate(
        apiKey,
        {
          model,
          fallbackModels: this.fallbackChain(),
          systemInstruction:
            '你是世界顶尖学术期刊的专业文献翻译专家，输出必须是严格合法的 JSON，且逐句译文与原文严格一一对应。',
          turns: [{ role: 'user', text: prompt }],
          temperature: 0.2,
          maxOutputTokens: 16384,
          jsonSchema: this.batchSchema(K),
          thinkingConfig: this.thinkingConfig(),
          idleTimeoutMs: 60000,
          totalTimeoutMs: 240000
        },
        this.log
      );
    } catch (err: any) {
      // schema 不被支持时降级为纯提示词约束
      if (err instanceof LlmError && err.kind === 'invalid-request') {
        this.log(`批量 JSON schema 被拒绝（${err.apiMessage}），改用宽松模式重试`);
        res = await generate(
          apiKey,
          {
            model,
            fallbackModels: this.fallbackChain(),
            systemInstruction: '你是学术翻译专家，只输出严格合法的 JSON 对象。',
            turns: [{ role: 'user', text: prompt }],
            temperature: 0.2,
            maxOutputTokens: 16384,
            thinkingConfig: this.thinkingConfig(),
            idleTimeoutMs: 60000,
            totalTimeoutMs: 240000
          },
          this.log
        );
      } else {
        throw err;
      }
    }

    const note = this.fallbackNote(res);
    const raw = (res.text || '').trim();
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim());
    } catch {
      const a = raw.indexOf('{');
      const b = raw.lastIndexOf('}');
      if (a >= 0 && b > a) {
        try {
          parsed = JSON.parse(raw.slice(a, b + 1));
        } catch {}
      }
    }

    const out: (ParagraphTranslation | null)[] = batch.map(() => null);
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
    if (!items) {
      this.log('批量返回无法解析为 {items:[…]}，整批转逐段重试');
      return out;
    }

    items.forEach((item: any) => {
      const idx = Number(item && item.index) - 1;
      if (!(idx >= 0 && idx < K)) return;
      const n = expected[idx];
      const translation = typeof item.translation === 'string' ? item.translation.trim() : '';
      const sentences = Array.isArray(item.sentences)
        ? item.sentences.map((v: any) => String(v == null ? '' : v).trim())
        : [];

      if (n <= 1) {
        if (!isUsable(translation)) return;
        if (this.checkTranslationSanity(batch[idx].text, translation, lang)) return;
        const key = contentKey(batch[idx].text.trim(), lang, res.model);
        const r: ParagraphTranslation = {
          translation,
          sentences: n === 1 ? [translation] : [],
          aligned: true,
          mode: n === 1 ? 'sentence-json' : 'unaligned',
          model: res.model,
          note
        };
        this.paraCache.set(key, r);
        out[idx] = r;
        return;
      }

      if (sentences.length !== n || !sentences.every(isUsable)) return;
      if (!isUsable(translation)) return;
      if (
        this.checkTranslationSanity(batch[idx].text, translation, lang) ||
        this.checkTranslationSanity(batch[idx].text, sentences.join(' '), lang)
      ) {
        return;
      }
      const key = contentKey(batch[idx].text.trim(), lang, res.model);
      const r: ParagraphTranslation = {
        translation,
        sentences,
        aligned: true,
        mode: 'sentence-json',
        model: res.model,
        note
      };
      this.paraCache.set(key, r);
      out[idx] = r;
    });

    const okCount = out.filter(Boolean).length;
    this.log(`批量翻译：${K} 段中 ${okCount} 段一次成功，其余将逐段重试`);
    return out;
  }

  private batchSchema(k: number): object {
    return {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              translation: { type: 'string' },
              sentences: { type: 'array', items: { type: 'string' } }
            },
            required: ['index', 'translation', 'sentences']
          },
          minItems: k,
          maxItems: k
        }
      },
      required: ['items']
    };
  }

  private async doTranslateParagraph(
    text: string,
    sentences: string[],
    lang: string
  ): Promise<ParagraphTranslation> {
    const apiKey = this.getGeminiKey();
    if (!apiKey) throw new LlmError({ kind: 'no-key' });

    const model = this.translationModel();
    const target = langName(lang);
    const N = sentences.length;

    // 无句子信息（极短段落或切句失败）：只求整段译文
    if (N <= 1) {
      const res = await generate(
        apiKey,
        {
          model,
          fallbackModels: this.fallbackChain(),
          systemInstruction: `你是世界顶尖学术期刊的专业文献翻译专家。只输出译文正文，不要输出任何解释、备选或引用块。`,
          turns: [
            {
              role: 'user',
              text: `请将下面的学术英文内容翻译为${target}，保持术语准确、符合中文学术写作规范；${FORMULA_LATEX_RULE}；文献引用编号（如 [1]、Smith et al.）原样保留：\n\n${text}`
            }
          ],
          temperature: 0.2,
          maxOutputTokens: 8192,
          thinkingConfig: this.thinkingConfig(),
          idleTimeoutMs: 60000,
          totalTimeoutMs: 180000
        },
        this.log
      );
      const t = this.cleanTranslation(res.text);
      if (!t) throw new LlmError({ kind: 'empty', model: res.model, apiMessage: '整段翻译返回空' });
      return {
        translation: t,
        sentences: N === 1 ? [t] : [],
        aligned: true,
        mode: N === 1 ? 'sentence-json' : 'unaligned',
        model: res.model,
        note: this.fallbackNote(res)
      };
    }

    // 主路径：JSON schema 强约束，一次拿到整段 + 严格 N 条逐句译文
    let mismatch: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const schema = attempt === 0 ? this.sentenceSchema(N) : this.sentenceSchemaLoose(N);
      const correction =
        attempt === 0
          ? ''
          : `\n\n注意：上一次输出不合格（${mismatch}）。这一次请务必让 "sentences" 数组恰好包含 ${N} 个元素，每个元素对应下面一句英文，不得合并、不得拆分、不得遗漏；并且必须输出**中文译文**，绝对不要把英文原文复制回来。`;

      let res;
      try {
        res = await generate(
          apiKey,
          {
            model,
            fallbackModels: this.attemptFallback(attempt),
            systemInstruction: `你是世界顶尖学术期刊的专业文献翻译专家。你的输出必须是严格合法的 JSON，且逐句译文与原文句子严格一一对应。`,
            turns: [
              {
                role: 'user',
                text: `请把下面这段英文学术论文内容翻译为${target}。

【英文原句，共 ${N} 句】
${sentences.map((s, i) => `[${i + 1}] ${s}`).join('\n')}

【输出要求】
1. "translation"：整段连贯、严谨的中文学术译文（不要逐句拼贴，要通顺）。
2. "sentences"：逐句译文数组，长度**必须恰好为 ${N}**。第 i 项只能对应第 i 句英文，一句对一句，不得合并或拆分。
3. 同一段落内的人称代词、术语译法保持前后一致（如 "the model" 统一译法）。
4. ${FORMULA_LATEX_RULE}。
5. 只输出 JSON，不要任何解释。

【翻译铁律】
- **忠实优先于流畅**：不增删原意，不漏掉限定词（all / only / not / may / must 等），不改变逻辑关系。
- **必须换成中文语序，禁止照搬英文语序**：不要把英语的后置状语原样拖到句尾，
  写出「……，给定引导信息。」这类悬空状语；状语按中文习惯前置，长句按中文习惯重组。
- **术语不得生造直译**：带连字符、或含 -agnostic / -free / -invariant / -aware / -based 等构词的专业术语，
  中文译法后**必须用括号附上英文原词**（例：与目标类别无关（object-agnostic））。
  拿不准中文译法时直接保留英文原词，不要硬译成中文生造词。
  反例：把 object-agnostic 单独译成"对象无关"（中文无此说法，读者无法理解也无法查证）。${correction}`
              }
            ],
            temperature: 0.2,
            maxOutputTokens: 8192,
            jsonSchema: schema,
            thinkingConfig: this.thinkingConfig(),
            idleTimeoutMs: 60000,
            totalTimeoutMs: 180000
          },
          this.log
        );
      } catch (err: any) {
        // schema 不被支持（部分模型对 minItems/propertyOrdering 挑剔）→ 降级重试
        if (attempt === 0 && err instanceof LlmError && err.kind === 'invalid-request') {
          this.log(`JSON schema 被拒绝（${err.apiMessage}），改用宽松 schema 重试`);
          mismatch = 'JSON schema 不被该模型支持';
          continue;
        }
        throw err;
      }

      const parsed = this.parseSentenceJson(res.text, N);
      if (parsed.ok) {
        // 旧版只校验句数，模型把英文原样吐回来也会被当成"翻译成功"直接显示。
        // 这里补上语言/照搬校验，不合格就带着原因重试。
        const bad =
          this.checkTranslationSanity(text, parsed.translation, lang) ||
          this.checkTranslationSanity(text, parsed.sentences.join(' '), lang) ||
          // 术语硬译校验：object-agnostic 被译成"对象无关"这类生造词，读者既读不懂也查不到原文。
          // 提示词压不住（实测反复重试仍会硬译），所以用代码定向校验 + 带原因的定向重试。
          this.checkTermFidelity(text, `${parsed.translation} ${parsed.sentences.join(' ')}`);
        if (!bad) {
          return {
            translation: parsed.translation,
            sentences: parsed.sentences,
            aligned: true,
            mode: 'sentence-json',
            model: res.model,
            note: this.fallbackNote(res)
          };
        }
        mismatch = bad;
        this.log(`译文质量校验未通过：${bad}，准备重试`);
      } else {
        mismatch = parsed.reason;
      }

      this.log(`段落逐句翻译不合格：${mismatch}，准备重试`);
    }

    // 降级 1：逐句独立翻译（把整段作为上下文喂进去，保住指代与术语，同时保证 1:1 对齐）
    this.log('JSON 逐句对齐两次均失败，降级为「带段落上下文的逐句翻译」');
    const perSentence = await this.translateSentenceBySentence(sentences, text, lang, apiKey, model);
    if (perSentence) {
      const bad = this.checkTranslationSanity(text, perSentence.join(' '), lang);
      if (!bad) {
        return {
          translation: perSentence.join(' '),
          sentences: perSentence,
          aligned: true,
          mode: 'per-sentence',
          model,
          note: '整段 JSON 对齐未成功，已改用逐句翻译（每句都带整段上下文，仍严格一一对应）'
        };
      }
      this.log(`逐句译文质量校验未通过：${bad}`);
    }

    // 降级 2：只给整段译文，如实标记未对齐——绝不用"按标点猜切分"的方式伪造句对。
    // translateText 内部同样会做语言校验：若整段译文也是照搬原文，它会抛错如实上报，
    // 而不是把英文当成"中文译文"显示出来。
    const whole = await this.translateText(text, lang);
    return {
      translation: whole,
      sentences: [],
      aligned: false,
      mode: 'unaligned',
      model,
      note: '逐句对齐失败，仅提供整段译文（不再用标点猜测拆分，避免出现张冠李戴的句对）'
    };
  }

  private attemptFallback(attempt: number): string[] {
    // 第一次尝试不额外扩散候选（避免一次重试放大成多次调用）
    return attempt === 0 ? this.fallbackChain() : [];
  }

  private fallbackNote(res: { model: string; fellBackFrom?: { model: string; reason: string }[] }): string | undefined {
    if (!res.fellBackFrom || res.fellBackFrom.length === 0) return undefined;
    const detail = res.fellBackFrom.map(f => `${f.model}（${f.reason}）`).join('、');
    return `已回退到 ${res.model}；跳过：${detail}`;
  }

  private sentenceSchema(n: number): object {
    return {
      type: 'object',
      properties: {
        translation: { type: 'string' },
        sentences: {
          type: 'array',
          items: { type: 'string' },
          minItems: n,
          maxItems: n
        }
      },
      required: ['translation', 'sentences'],
      propertyOrdering: ['translation', 'sentences']
    };
  }

  private sentenceSchemaLoose(n: number): object {
    return {
      type: 'object',
      properties: {
        translation: { type: 'string' },
        sentences: { type: 'array', items: { type: 'string' } }
      },
      required: ['translation', 'sentences']
    };
  }

  /**
   * 解析逐句 JSON。ok:false 时给出人话原因（用于重试提示）。
   */
  private parseSentenceJson(
    raw: string,
    n: number
  ): { ok: true; translation: string; sentences: string[] } | { ok: false; reason: string } {
    let text = (raw || '').trim();
    if (!text) return { ok: false, reason: '返回内容为空' };

    // 容错：剥掉模型可能套上的 ```json 围栏
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();

    let obj: any;
    try {
      obj = JSON.parse(text);
    } catch {
      const first = text.indexOf('{');
      const last = text.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try {
          obj = JSON.parse(text.slice(first, last + 1));
        } catch {
          return { ok: false, reason: 'JSON 解析失败' };
        }
      } else {
        return { ok: false, reason: 'JSON 解析失败' };
      }
    }

    // 模型偶尔直接返回数组
    if (Array.isArray(obj)) {
      const arr: string[] = obj.map((v: any) => String(v == null ? '' : v).trim());
      if (arr.length !== n) return { ok: false, reason: `返回了 ${arr.length} 句译文，应为 ${n} 句` };
      if (!arr.every(isUsable)) return { ok: false, reason: '存在空白或失败的句子译文' };
      return { ok: true, translation: arr.join(' '), sentences: arr };
    }

    if (!obj || typeof obj !== 'object') return { ok: false, reason: '返回的不是 JSON 对象' };

    const translation = typeof obj.translation === 'string' ? obj.translation.trim() : '';
    if (!Array.isArray(obj.sentences)) return { ok: false, reason: '缺少 sentences 数组' };

    const arr: string[] = obj.sentences.map((v: any) => String(v == null ? '' : v).trim());
    if (arr.length !== n) return { ok: false, reason: `返回了 ${arr.length} 句译文，应为 ${n} 句` };
    if (!arr.every(isUsable)) return { ok: false, reason: '存在空白或失败的句子译文' };

    // 整段译文缺失但有逐句译文：用逐句拼接兜底（仍是真实译文）
    return { ok: true, translation: translation || arr.join(' '), sentences: arr };
  }

  /**
   * 逐句翻译，但每句都把整段原文作为上下文一起发送：
   * 既保证严格 1:1 对齐，又不会丢掉跨句指代与术语一致性。
   */
  private async translateSentenceBySentence(
    sentences: string[],
    fullParagraph: string,
    lang: string,
    apiKey: string,
    model: string
  ): Promise<string[] | null> {
    const target = langName(lang);
    const out: string[] = [];
    try {
      for (let i = 0; i < sentences.length; i++) {
        const res = await this.gate.run(() =>
          generate(
            apiKey,
            {
              model,
              fallbackModels: this.fallbackChain(),
              systemInstruction: `你是世界顶尖学术期刊的专业文献翻译专家。只输出要求的那一句译文，不要输出解释、编号或引号。`,
              turns: [
                {
                  role: 'user',
                  text: `下面是该句所在段落的完整原文（仅供你理解上下文与指代关系，**不要翻译它**）：

${fullParagraph}

现在只翻译该段落中的第 ${i + 1} 句，输出${target}译文（只输出这一句，不要编号）：
${sentences[i]}`
                }
              ],
              temperature: 0.2,
              maxOutputTokens: 2048,
              thinkingConfig: this.thinkingConfig(),
              idleTimeoutMs: 45000,
              totalTimeoutMs: 120000
            },
            this.log
          )
        );
        const t = this.cleanTranslation(res.text);
        if (!isUsable(t)) return null;
        out.push(t);
      }
      return out.length === sentences.length ? out : null;
    } catch (err: any) {
      this.log(`逐句翻译失败：${err?.message}`);
      return null;
    }
  }

  private cleanTranslation(raw: string): string {
    let t = (raw || '').trim();
    if (t.startsWith('>')) t = t.replace(/^>\s*/gm, '').trim();
    if ((t.startsWith('“') && t.endsWith('”')) || (t.startsWith('"') && t.endsWith('"'))) {
      t = t.slice(1, -1).trim();
    }
    return t;
  }

  // ==========================================================================
  // 译文质量校验：防止模型把原文照抄回来（旧版只校验句数，直接照单全收）
  // ==========================================================================

  private countCjk(s: string): number {
    const m = (s || '').match(/[\u3400-\u4dbf\u4e00-\u9fff]/g);
    return m ? m.length : 0;
  }

  /**
   * 粗粒度相似度：用来抓"整段照搬原文"。
   * 注意：这个函数只在**低中文占比**的分支里被调用（见 checkTranslationSanity）。
   * 它按 [a-z0-9] 归一化，因此"中文译文"归一化后往往只剩零星几个拉丁/数字片段，
   * 极短片段一旦恰好出现在原文里（例如 "2"、"ai"），就会假阳性命中——
   * 所以这里要求最短可比长度，低于该长度直接判为"无法判断"。
   */
  private similarity(a: string, b: string): number {
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    const shortS = x.length <= y.length ? x : y;
    const longS = x.length <= y.length ? y : x;
    // 太短不足以判断（"2"、"ai" 这类片段几乎必然出现在任何英文里）
    if (shortS.length < 12) return 0;
    if (longS.includes(shortS)) return 1;
    let hit = 0;
    let total = 0;
    for (let i = 0; i + 12 <= shortS.length; i += 12) {
      total++;
      if (longS.includes(shortS.slice(i, i + 12))) hit++;
    }
    return total > 0 ? hit / total : 0;
  }

  /**
   * 译文是否可疑（未翻译/照搬原文/语言不符）。
   * 返回字符串表示可疑原因，返回 null 表示通过。
   */
  /**
   * 术语硬译校验：这类"英文构词 + 形容词后缀"的术语一旦被硬译成中文生造词，
   * 读者既无法理解、也无法拿去查证原文。
   * 实测（DeepSeek）即使提示词明确要求"必须附英文原词"，模型依然会写成"与对象无关"，
   * 所以这里用确定性校验兜底：译文里必须出现原术语本身（可带括号）。
   * @returns 不合格原因；合格返回 null
   */
  private checkTermFidelity(source: string, out: string): string | null {
    const missing = missingRiskyTerms(source, out);
    if (missing.length === 0) return null;
    return `术语必须保留英文原词，但译文里缺少：${missing.join('、')}。请在中文译法后用括号附上该英文术语`;
  }

  private checkTranslationSanity(source: string, out: string, targetLang: string): string | null {
    const o = (out || '').trim();
    if (!o) return '译文为空';

    // 只对"译成中文"做检查，且源文本本身不是中文（否则中→中或中→英会被误判）
    if (!targetLang.startsWith('zh')) return null;
    const sourceHasCjk = this.countCjk(source) > 0;
    if (sourceHasCjk) return null;

    // 太短的内容（公式、编号、纯缩写）不做语言判断，避免误报
    const latinLetters = ((source || '').match(/[A-Za-z]/g) || []).length;
    if (latinLetters < 8) return null;

    /**
     * 【必须先剥掉 LaTeX 再数】译文里的公式现在是 $...$ 形式的 LaTeX，
     * 而 `\hat`、`\mathcal`、`Y`、`t` 全是拉丁字母 —— 不剥的话，一段"中文 + 公式"的译文
     * 中文占比会被公式字母硬生生拉到阈值以下，然后弹出"疑似照搬原文"的假报错。
     * 剥掉之后剩下的才是"真正的文字"（中文散文 + 少量必须保留的英文术语）。
     */
    const oPlain = this.stripLatexForCounting(o);

    const cjk = this.countCjk(oPlain);
    const outLatin = ((oPlain || '').match(/[A-Za-z]/g) || []).length;
    if (cjk + outLatin === 0) return '译文为空';

    /**
     * 【公平分母】只看"汉字 vs 拉丁字母"，**不把公式符号/数字/标点算进分母**。
     *
     * 旧判据是 `汉字 / 非空字符总数`。对公式密集的段落这是结构性不公平：
     * 数学符号在译文里本来就原样保留（`Ŷ t ⊂ {Y i | i ∈ [2, t]}` 之类），
     * 分母被符号撑大，中文占比永远上不去 —— 真实案例：模型其实译对了一半，
     * 却因"中文字符仅占 21%"被判未翻译。
     * 用"汉字/(汉字+字母)"衡量，正常译文会更高（实测同一段 47% → 73%），
     * 而照搬原文仍然是 0%，该拦的照样拦得住。
     */
    const ratio = cjk / (cjk + outLatin);

    // 公式密集的段落，模型保留大量原文是合理的（术语、变量、集合记号都该原样留），
    // 因此阈值放宽；非公式段落维持原来的严格标准。
    const mathHeavy = this.mathDensity(source) >= 0.25;
    const threshold = mathHeavy ? 0.12 : 0.25;
    if (ratio >= threshold) return null;

    // 中文占比过低：这时才值得判断"是不是直接把原文抄回来了"。
    // 相似度也要拿**剥掉 LaTeX 之后**的译文比，否则"抄一遍原文再补两个 $x$"就能绕过这道闸门。
    if (this.similarity(source, oPlain) > 0.9) {
      // 公式为主的段落，原样返回本来就是正常结果（没什么可翻的），不该报成失败
      if (mathHeavy) return null;
      return '译文与原文几乎完全相同（疑似照搬原文）';
    }
    return `译文疑似未翻译（汉字占字母+汉字的比例仅 ${Math.round(ratio * 100)}%）`;
  }

  /**
   * 剥掉 LaTeX 片段，只留"真正的文字"（用于语言判断与相似度比较）。
   * 覆盖 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`，以及漏网的 `\command`。
   */
  private stripLatexForCounting(s: string): string {
    return String(s || '')
      .replace(/\$\$[\s\S]*?\$\$/g, ' ')
      .replace(/\\\[[\s\S]*?\\\]/g, ' ')
      .replace(/\\\([\s\S]*?\\\)/g, ' ')
      .replace(/\$[^$\n]*?\$/g, ' ')
      .replace(/\\[a-zA-Z]+/g, ' ');
  }

  /**
   * 数学/符号密度：判断一段是不是"公式为主"。
   * 只数符号与数字，字母与汉字都算"有内容的字符"。
   */
  private mathDensity(s: string): number {
    const str = s || '';
    const letters = (str.match(/[A-Za-z]/g) || []).length;
    const cjk = this.countCjk(str);
    const symbols = (str.match(/[=+\-*/^_{}[\]()<>≤≥≈≠∈∑∫∂∇×·|\\]/g) || []).length;
    const digits = (str.match(/\d/g) || []).length;
    const denom = letters + cjk + symbols + digits;
    if (denom === 0) return 0;
    return (symbols + digits) / denom;
  }

  // ==========================================================================
  // 非 Gemini 引擎（用户显式选择的内置免费翻译 / 自定义 OpenAI 兼容接口）
  // 注意：不再"偷偷回退"——只有用户把 translationService 设为这些值时才使用。
  // ==========================================================================

  private async translateWithoutGemini(
    text: string,
    sentences: string[],
    lang: string,
    service: string
  ): Promise<ParagraphTranslation> {
    if (service === 'openai-compatible') {
      return this.translateParagraphWithOpenAI(text, sentences, lang);
    }

    const whole = await this.translateWithBuiltin(text, lang);
    return {
      translation: whole,
      sentences: [],
      aligned: false,
      mode: 'unaligned',
      note: '内置免费翻译引擎只能提供整段译文，不提供逐句对齐'
    };
  }

  /**
   * OpenAI 兼容接口（DeepSeek / Kimi / OpenAI 等）的段落翻译。
   * 与 Gemini 走同一套思路：一次请求拿「整段 + 严格逐句」，同样做译文质量校验，
   * 不合格就带着原因重试一次，最后才退化为整段译文。
   * （旧版这里是「整段一次 + 每句各一次」的 N+1 次请求，既慢又丢上下文。）
   */
  private async translateParagraphWithOpenAI(
    text: string,
    sentences: string[],
    lang: string
  ): Promise<ParagraphTranslation> {
    const cfg = this.cfg();
    const modelName = (cfg.get<string>('modelName', 'deepseek-chat') || '').trim();
    const N = sentences.length;
    const target = langName(lang);

    if (N <= 1) {
      const whole = await this.translateWithOpenAICompatible(text, lang, cfg);
      return {
        translation: whole,
        sentences: N === 1 ? [whole] : [],
        aligned: true,
        mode: N === 1 ? 'sentence-json' : 'unaligned',
        model: modelName
      };
    }

    let mismatch = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const correction =
        attempt === 0
          ? ''
          : `\n\n注意：上一次输出不合格（${mismatch}）。sentences 必须恰好 ${N} 个，且必须输出中文译文，不要复制英文原文。`;

      const prompt = `请把下面这段英文学术论文内容翻译为${target}。

【英文原句，共 ${N} 句】
${sentences.map((s, i) => `[${i + 1}] ${s}`).join('\n')}

【输出要求】
1. "translation"：整段连贯、地道、严谨的中文学术译文。
2. "sentences"：逐句译文数组，长度**必须恰好为 ${N}**，第 i 项只对应第 i 句，不得合并或拆分。
3. ${FORMULA_LATEX_RULE}。
4. 只输出 JSON 对象，形如 {"translation":"…","sentences":["…","…"]}，不要任何解释。${correction}`;

      let raw: string;
      try {
        raw = await this.callOpenAIChat(
          '你是一名专业的学术论文翻译专家，只输出严格合法的 JSON 对象。',
          prompt,
          cfg,
          true
        );
      } catch (err: any) {
        // 部分兼容接口不认 response_format，去掉再试一次
        if (attempt === 0 && err instanceof LlmError && err.kind === 'invalid-request') {
          this.log('该接口不支持 response_format: json_object，改为纯提示词约束重试');
          mismatch = '该接口不支持 JSON 模式';
          raw = await this.callOpenAIChat(
            '你是一名专业的学术论文翻译专家，只输出严格合法的 JSON 对象，不要输出任何解释或代码围栏。',
            prompt,
            cfg,
            false
          );
        } else {
          throw err;
        }
      }

      const parsed = this.parseSentenceJson(raw, N);
      if (parsed.ok) {
        const bad =
          this.checkTranslationSanity(text, parsed.translation, lang) ||
          this.checkTranslationSanity(text, parsed.sentences.join(' '), lang);
        if (!bad) {
          return {
            translation: parsed.translation,
            sentences: parsed.sentences,
            aligned: true,
            mode: 'sentence-json',
            model: modelName
          };
        }
        mismatch = bad;
      } else {
        mismatch = parsed.reason;
      }
      this.log(`[OpenAI兼容] 逐句翻译不合格：${mismatch}`);
    }

    const whole = await this.translateWithOpenAICompatible(text, lang, cfg);
    return {
      translation: whole,
      sentences: [],
      aligned: false,
      mode: 'unaligned',
      model: modelName,
      note: `逐句对齐未成功（${mismatch}），仅提供整段译文`
    };
  }

  public async translateText(text: string, targetLang?: string): Promise<string> {
    const trimmed = (text || '').trim();
    if (!trimmed) return '';

    const cfg = this.cfg();
    const lang = targetLang || cfg.get<string>('targetLanguage', 'zh-CN');
    const service = cfg.get<string>('translationService', 'gemini');

    const cacheKey = `${service}:${lang}:${trimmed}`;
    const hit = this.cache.get(cacheKey);
    if (isUsable(hit)) return hit!;
    if (hit) this.cache.delete(cacheKey);

    let result: string;
    if (service === 'gemini') {
      const apiKey = this.getGeminiKey(cfg);
      if (!apiKey) throw new LlmError({ kind: 'no-key' });
      const res = await generate(
        apiKey,
        {
          model: this.translationModel(),
          fallbackModels: this.fallbackChain(),
          systemInstruction: `你是世界顶尖学术期刊的专业文献翻译专家。只输出译文正文，不要输出解释、备选或引用块。`,
          turns: [
            {
              role: 'user',
              text: `请将下面的学术英文内容翻译为${langName(lang)}。保持术语准确、符合中文学术规范；${FORMULA_LATEX_RULE}；只输出译文：\n\n${trimmed}`
            }
          ],
          temperature: 0.2,
          maxOutputTokens: 8192,
          thinkingConfig: this.thinkingConfig(),
          idleTimeoutMs: 60000,
          totalTimeoutMs: 180000
        },
        this.log
      );
      result = this.cleanTranslation(res.text);
      if (!result) throw new LlmError({ kind: 'empty', model: res.model, apiMessage: '划词翻译返回空' });
    } else if (service === 'openai-compatible') {
      result = await this.translateWithOpenAICompatible(trimmed, lang, cfg);
    } else {
      result = await this.translateWithBuiltin(trimmed, lang);
    }

    // LLM 路径做语言校验（内置免费引擎返回的是词典释义/机翻短句，不做此校验）
    if (service === 'gemini' || service === 'openai-compatible') {
      const bad = this.checkTranslationSanity(trimmed, result, lang);
      if (bad) {
        throw new LlmError({
          kind: 'parse',
          apiMessage: `译文质量校验未通过：${bad}`,
          tip: '该段可能主要是图表/公式/参考文献等非叙述性内容；可点重试，或在设置里更换模型/引擎。'
        });
      }
    }

    if (isUsable(result)) this.cache.set(cacheKey, result);
    return result;
  }

  /** 统一的 OpenAI 兼容接口调用（返回 message.content） */
  private async callOpenAIChat(
    systemContent: string,
    userContent: string,
    config: vscode.WorkspaceConfiguration,
    jsonMode = false
  ): Promise<string> {
    const endpoint = (config.get<string>('apiEndpoint', 'https://api.deepseek.com/v1') || '').replace(/\/+$/, '');
    const apiKey = (config.get<string>('apiKey', '') || '').trim();
    const modelName = (config.get<string>('modelName', 'deepseek-chat') || '').trim();
    if (!apiKey) throw new LlmError({ kind: 'no-key', apiMessage: '未配置自定义大模型 API Key' });
    if (!endpoint) throw new LlmError({ kind: 'invalid-request', apiMessage: '未配置自定义大模型端点' });

    const bodyObj: any = {
      model: modelName,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2,
      stream: false,
      // 显式给足输出上限：DeepSeek 默认 max_tokens 只有 4096，
      // 长段落 + 逐句 JSON 有被截断的风险（截断后 JSON 解析必失败）。
      max_tokens: 8192
    };
    if (jsonMode) bodyObj.response_format = { type: 'json_object' };

    const doPost = async (payload: any): Promise<string> => {
      let res: string;
      try {
        res = await this.httpPost(
          `${endpoint}/chat/completions`,
          JSON.stringify(payload),
          { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          120000
        );
      } catch (err: any) {
        const msg = String(err && err.message ? err.message : err);
        const m = msg.match(/HTTP (\d{3})/);
        const status = m ? Number(m[1]) : 0;
        if (status === 401 || status === 403) {
          throw new LlmError({ kind: 'auth', status, model: modelName, apiMessage: '自定义大模型鉴权失败' });
        }
        if (status === 429) {
          throw new LlmError({ kind: 'rate-limit', status, model: modelName, apiMessage: '自定义大模型限流' });
        }
        if (status >= 400 && status < 500) {
          throw new LlmError({ kind: 'invalid-request', status, model: modelName, apiMessage: msg.slice(0, 300) });
        }
        throw new LlmError({ kind: 'network', model: modelName, apiMessage: msg.slice(0, 300) });
      }
      let json: any;
      try {
        json = JSON.parse(res);
      } catch {
        throw new LlmError({ kind: 'parse', model: modelName, apiMessage: '自定义大模型返回的不是 JSON' });
      }
      if (json.error) {
        throw new LlmError({
          kind: 'invalid-request',
          model: modelName,
          apiMessage: json.error.message || '自定义模型返回错误'
        });
      }
      const content =
        json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new LlmError({ kind: 'empty', model: modelName, apiMessage: '自定义模型返回空内容' });
      }
      return content.trim();
    };

    try {
      return await doPost(bodyObj);
    } catch (err: any) {
      // 有些兼容接口不认 max_tokens / response_format，摘掉再试一次
      if (err instanceof LlmError && err.kind === 'invalid-request') {
        const relaxed: any = { ...bodyObj };
        let dropped = false;
        if (relaxed.max_tokens) {
          delete relaxed.max_tokens;
          dropped = true;
        }
        if (relaxed.response_format) {
          delete relaxed.response_format;
          dropped = true;
        }
        if (dropped) {
          this.log(`该接口拒绝了参数（${err.apiMessage}），摘掉 max_tokens/response_format 重试`);
          return await doPost(relaxed);
        }
      }
      throw err;
    }
  }

  private async translateWithOpenAICompatible(
    text: string,
    targetLang: string,
    config: vscode.WorkspaceConfiguration
  ): Promise<string> {
    const modelName = (config.get<string>('modelName', 'deepseek-chat') || '').trim();
    const prompt = `你是一名精通各学科前沿学术论文的专业科研翻译专家。请把下面内容翻译为${langName(
      targetLang
    )}，术语专业准确、句式符合中文学术写作习惯；${FORMULA_LATEX_RULE}；文献引用编号与代码保留原样；直接输出译文，不要任何前言或解释。\n\n${text}`;

    const content = await this.callOpenAIChat(
      'You are a professional academic paper translation assistant.',
      prompt,
      config,
      false
    );

    const bad = this.checkTranslationSanity(text, content, targetLang);
    if (bad) {
      throw new LlmError({
        kind: 'parse',
        model: modelName,
        apiMessage: `译文质量校验未通过：${bad}`,
        tip: '该段可能主要是图表/公式/参考文献等非叙述性内容；可点重试，或更换模型。'
      });
    }
    return content;
  }

  /** 内置免费翻译：仅当用户显式选择 translationService=built-in 时使用 */
  private async translateWithBuiltin(text: string, targetLang?: string): Promise<string> {
    const cleanText = (text || '').trim();
    if (!cleanText) return '';

    const hasChinese = /[\u4e00-\u9fa5]/.test(cleanText);
    const sourceLang = hasChinese ? 'zh' : 'en';
    const lang = targetLang || 'zh-CN';
    const targetLangCode = hasChinese ? 'en' : lang.startsWith('zh') ? lang : lang.split('-')[0];

    if (!hasChinese && cleanText.length <= 80 && !cleanText.includes('\n')) {
      try {
        const icibaUrl = `https://dict-mobile.iciba.com/interface/index.php?c=word&m=getsuggest&nums=1&client=6&is_need_mean=1&word=${encodeURIComponent(
          cleanText
        )}`;
        const res = await this.httpGet(icibaUrl, 2500);
        const data = JSON.parse(res);
        if (data && Array.isArray(data.message) && data.message.length > 0 && data.message[0].paraphrase) {
          return `${data.message[0].key}: ${data.message[0].paraphrase}`;
        }
      } catch {}
    }

    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${encodeURIComponent(
        targetLangCode
      )}&dt=t&q=${encodeURIComponent(cleanText)}`;
      const res = await this.httpGet(url, 3500);
      const data = JSON.parse(res);
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const full = data[0].map((item: any) => item[0]).join('');
        if (full.trim() && !full.includes('DOCTYPE html')) return full.trim();
      }
    } catch {}

    throw new LlmError({
      kind: 'network',
      apiMessage: '内置免费翻译引擎不可用（网络受限）',
      tip: '请改用 Google Gemini 引擎，或在设置中配置可直连的大模型接口'
    });
  }

  // ==========================================================================
  // AI 学术问答（流式 + 多轮 + 全文上下文）
  // 旧版这里曾返回一段硬编码的假解析，已彻底移除：失败必须如实报错。
  // ==========================================================================

  public registerPageText(page: number, paragraphs: { type: string; text: string }[]): void {
    this.pageTextIndex.set(page, paragraphs || []);
  }

  public clearPageText(): void {
    this.pageTextIndex.clear();
  }

  public cancelAiRequest(requestId: string): boolean {
    const ctrl = this.aiRequests.get(requestId);
    if (ctrl) {
      ctrl.abort();
      this.aiRequests.delete(requestId);
      return true;
    }
    return false;
  }

  /** 从全文里挑出与当前问题最相关的段落（纯词频打分，不依赖外部服务） */
  private retrieveContext(query: string, currentPage: number, limit = 6): string {
    const stop = new Set(
      ('the a an of to in and or for on with is are was were be been this that these those it its as by at from we our they their ' +
        'which who whom whose not no can could may might will would should do does did have has had but if then than so such ' +
        '请 这句 这个 什么 怎么 为什么 以及 但是 因为 所以 我们 他们 作者').split(/\s+/)
    );
    const terms = Array.from(
      new Set(
        (query || '')
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, ' ')
          .split(/\s+/)
          .filter(t => t.length > 2 && !stop.has(t))
      )
    ).slice(0, 40);
    if (terms.length === 0) return '';

    const scored: { page: number; idx: number; score: number; text: string }[] = [];
    this.pageTextIndex.forEach((paras, page) => {
      paras.forEach((p, idx) => {
        const t = (p.text || '').toLowerCase();
        if (!t) return;
        let score = 0;
        for (const term of terms) {
          if (t.includes(term)) score += 1;
        }
        if (score <= 0) return;
        // 同页加权，长段落轻微惩罚
        const pageBoost = page === currentPage ? 1.35 : 1;
        scored.push({ page, idx, score: score * pageBoost - Math.min(1.5, t.length / 2000), text: p.text });
      });
    });

    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, limit);
    if (picked.length === 0) return '';

    // 每段截断：放宽到 1200 字——太短会把"论据所在的那半段"切掉，让 AI 看不到完整上下文
    const MAX_PER_PARA = 1200;
    return picked
      .map(s => {
        const text = s.text.length > MAX_PER_PARA ? `${s.text.slice(0, MAX_PER_PARA)}…（后略）` : s.text;
        return `[第 ${s.page} 页·第 ${s.idx + 1} 段] ${text}`;
      })
      .join('\n\n');
  }

  /**
   * AI 回答的输出上限（token）——控制花销的硬闸门，但不能压得太死。
   * 旧版统一给到 8192 / 16384，模型基本写满（单次回答动辄 1600+ 字）；
   * 但一味砍短又会让回答"话太少、不够用"，所以按风格分档。
   *
   * **专家模式不设人为上限**（给到接口能接受的最大值）：它本来就是"读完全篇、把该讲的讲透"，
   * 再卡一个 4096 就变成"起了个专家的头、只给标准的量"。
   */
  private assistantMaxTokens(style: string): number {
    if (style === 'concise') return 1024; // 约 600 汉字以内
    if (style === 'expert') return 16384; // 专家：不限篇幅（= 接口上限）
    return 3072; // standard：约 800~1000 汉字，够把方法与推导讲清
  }

  /**
   * 回答风格归一。`reviewer`（审稿）已改名为 `expert`（专家）——
   * 老设置里存的还是 'reviewer'，不归一就会落到"没有一档匹配"、悄悄退化成默认风格。
   */
  private normalizeAnswerStyle(style?: string): string {
    const v = String(style || '').trim();
    if (v === 'reviewer') return 'expert';
    if (v === 'concise' || v === 'standard' || v === 'expert') return v;
    return 'standard';
  }

  /**
   * 专家模式的**全篇**上下文。
   *
   * 优先用 webview 现抽的整篇文本（它会用 pdf.js 把所有页都拉一遍，
   * 包括用户没翻过的页）；拿不到就退化成宿主已有的逐页文本索引（= 翻过的页），
   * 至少比"只给 6 段检索结果"强。
   */
  private buildWholePaperContext(fullText?: string): string {
    let text = String(fullText || '').trim();
    if (!text) {
      const pages: number[] = [];
      this.pageTextIndex.forEach((_v, page) => pages.push(page));
      pages.sort((a, b) => a - b);
      text = pages
        .map(p => `【第 ${p} 页】\n${(this.pageTextIndex.get(p) || []).map(x => x.text).join('\n\n')}`)
        .join('\n\n')
        .trim();
    }
    if (!text) return '';
    // 60k 字符 ≈ 2~3 万 token，足够一篇常规论文（正文 8~20 页）；再长就截断并**如实说明**
    const MAX = 60000;
    if (text.length > MAX) {
      return `${text.slice(0, MAX)}\n\n（全文过长，已截断到前 ${MAX} 字；后面部分未提供）`;
    }
    return text;
  }

  private buildAssistantPrompt(options: {
    question: string;
    selectedText: string;
    contextParagraph?: string;
    page?: number;
    noteType?: string;
    retrieved?: string;
    wholePaper?: string;
    answerStyle?: string;
  }): string {
    const parts: string[] = [];
    parts.push(`你正在协助读者精读一篇学术论文（当前第 ${options.page || 1} 页）。`);

    if (options.wholePaper && options.wholePaper.trim()) {
      parts.push(
        `【论文全文（自动从 PDF 文本层抽取，可能有排版错乱或个别字丢失；涉及本文事实时以它为准）】\n${options.wholePaper.trim()}`
      );
    }

    if (options.selectedText && options.selectedText.trim()) {
      parts.push(`【读者聚焦的原文】\n${options.selectedText.trim()}`);
      if (options.contextParagraph && options.contextParagraph.trim() && options.contextParagraph.trim() !== options.selectedText.trim()) {
        parts.push(`【该句所在段落全文】\n${options.contextParagraph.trim().slice(0, 3000)}`);
      }
    } else if (options.contextParagraph && options.contextParagraph.trim()) {
      parts.push(`【读者聚焦的段落】\n${options.contextParagraph.trim().slice(0, 3000)}`);
    }

    if (options.retrieved && options.retrieved.trim()) {
      parts.push(`【论文其它相关段落（自动检索，可能不完全相关，请自行判断是否采用）】\n${options.retrieved.trim()}`);
    }

    parts.push(`【读者的疑问】\n${options.question.trim()}`);

    const style = this.normalizeAnswerStyle(options.answerStyle);
    if (style === 'concise') {
      parts.push(
        `【回答要求】\n用不超过 200 字直接回答问题本身。先给结论，再给一到两句依据。不要套模板、不要罗列无关背景、不要复述原文。\n` +
          `注意：即使篇幅短，出现的术语/缩写也要用半句话说明白（读者基础可能一般）；问的是通用概念就直接用通用知识回答（不要因为论文里没写就拒答）；问的是本论文的具体内容则只依据上下文，不足就明说。`
      );
    } else if (style === 'expert') {
      parts.push(
        `【回答要求】\n你手上已经有**这篇论文的全文**，请通读之后回答（需要时引用具体页码/小节/公式编号）。用 Markdown，分点作答。\n` +
          `1. **不限篇幅**：不要为了简短而省略推导、前提条件、对比与边界情形——该讲多细就讲多细，几千字也可以。\n` +
          `   宁可写长，也不要留一个"读者还得自己去猜"的结论。\n` +
          `2. **深度优先**：先给结论，再把"为什么成立 / 在什么条件下成立 / 作者这一步可能被质疑在哪"讲透。\n` +
          `3. **事实只依据全文**：涉及本论文的数据、结论、公式、实验设置，只能用上面给的全文；\n` +
          `   全文里找不到就明说"全文未提供"，**严禁编造**。通用背景知识与本论文结论要分清来源、分开表述。\n` +
          `4. 术语/符号第一次出现时用一句话解释清楚（读者基础可能一般）。\n` +
          `5. 不要客套话、不要复述问题、不要在结尾写"小结/希望这能帮到你"。`
      );
    } else {
      parts.push(
        `【回答要求】\n直接回答，Markdown。要求：
1. **结论先行，但必须讲到能读懂**：先给结论，紧接着补齐理解它所需的前置概念。
   假设读者基础一般——出现的术语/缩写/符号要用一句话解释清楚，抽象机制配一个具体例子。
   一般 300~700 字；涉及推导、对比、机制拆解时可以更长（上限约 1000 字）。
   不要罗列与问题无关的背景，不要复述原文，不要在结尾写"小结/希望这能帮到你"。
2. **先分清问题类型**：
   - 问**本论文的具体内容** → 只依据上面提供的上下文；不足以回答时明说"当前上下文未提供"，
     并指出该看论文哪一部分，**严禁编造论文中不存在的内容、数据或结论**；
   - 问**通用概念 / 术语 / 背景知识**，或临时起意想问问 → 用通用知识正面回答，
     **不要因为"论文里没提到"就拒答**；但要标一句这是通用背景知识、不是本论文的结论。
3. 涉及术语/缩写/公式时解释清楚（读者最常卡在这里）。
4. 引用本论文原文时标注来自哪一段（如「第 3 页·第 2 段」）；引用通用知识不要伪装成论文引用。`
      );
    }
    return parts.join('\n\n');
  }

  /**
   * 流式学术问答。onDelta 收到增量文本；history 为之前的对话轮次（实现真多轮）。
   */
  public async streamAcademicAnswer(
    options: {
      requestId: string;
      question: string;
      selectedText: string;
      contextParagraph?: string;
      page?: number;
      noteType?: string;
      history?: LlmTurn[];
      answerStyle?: string;
      /** 专家模式：webview 现抽的**整篇文献**文本（所有页，含用户没翻过的页） */
      fullText?: string;
    },
    onDelta: (chunk: string) => void
  ): Promise<AcademicAnswer> {
    const cfg = this.cfg();
    // 【重要】AI 问答必须跟随**用户选的引擎**，不能写死 Gemini。
    // 否则用户把翻译换成 DeepSeek 之后，问答仍在偷偷调用 Gemini（还可能因为没配 Gemini Key 而直接失败）。
    const service = cfg.get<string>('translationService', 'gemini');
    const useOpenAI = service === 'openai-compatible';
    if (!useOpenAI && service !== 'gemini') {
      throw new LlmError({
        kind: 'invalid-request',
        apiMessage: `AI 问答暂不支持「${service}」引擎，请在设置里选择 Gemini 或 OpenAI 兼容接口。`
      });
    }

    const apiKey = useOpenAI ? (cfg.get<string>('apiKey', '') || '').trim() : this.getGeminiKey(cfg);
    if (!apiKey) throw new LlmError({ kind: 'no-key' });

    const ctrl = new AbortController();
    this.aiRequests.set(options.requestId, ctrl);

    // 兜底默认必须与 package.json 里 aiAnswerStyle 的 default 一致（standard），
    // 否则设置缺失时会悄悄退化成最省的 concise——回答短到基础一般的读者看不懂。
    const answerStyle = this.normalizeAnswerStyle(options.answerStyle || cfg.get<string>('aiAnswerStyle', 'standard'));
    const isExpert = answerStyle === 'expert';

    // 专家模式：把**整篇文献**塞进上下文（webview 现抽的全文优先）；
    // 其余风格仍走"当前段 + 检索最相关的 6 段"——不是为了省钱才这么分，
    // 而是短问答带上 3 万 token 的全文既慢又会让模型抓不住重点。
    const wholePaper = isExpert ? this.buildWholePaperContext(options.fullText) : '';

    const retrieved = isExpert
      ? ''
      : this.retrieveContext(
          `${options.question} ${options.selectedText || ''}`.slice(0, 800),
          options.page || 1,
          answerStyle === 'concise' ? 4 : 6
        );

    const prompt = this.buildAssistantPrompt({
      ...options,
      retrieved,
      wholePaper,
      answerStyle
    });

    const systemInstruction = `你是一名学术论文研究助手。读者既可能问论文里的内容，也可能只是看到了一个陌生概念、或者突然想问点别的——两类都要好好回答。

先判断问题属于哪一类（也可能两类都有，那就分开答）：

A. **关于本论文特定内容**（作者做了什么、实验数据、某段论述的含义、方法细节……）
   → 只能依据用户提供的论文原文与上下文作答；上下文没有的，明确说"当前上下文未提供"，绝不编造。
   → 不确定的地方标注不确定性，不要用笃定语气描述你并不知道的论文内容。

B. **通用概念 / 术语 / 背景知识**，或读者的发散思考、联想、假设
   → 正常用你的通用知识回答，把概念本身讲清楚，该展开就展开，不要因为"论文里没写"就拒答。
   → 但不要把自己的通用知识说成是"本论文指出/发现"；也不要替作者补充论文里不存在的实验、数据或结论。
   → 涉及本论文时，两边的信息要分清来源。

共同要求：
- 直接输出 Markdown 正文，不要客套话、不要重复问题、不要在结尾写"小结/希望这能帮到你"这类空话。
- **假设读者的基础一般**：不要默认对方熟悉这个细分方向的术语和套路。
  涉及专业术语、缩写、符号时，先用一句话说明"它是什么、为什么需要它"，再进入分析；
  抽象的机制尽量配一个具体例子（哪怕是最小化的例子）。**这是回答能不能被读懂的关键**。
- **篇幅要给得住**：结论先行，然后补齐理解所必需的来龙去脉。
  该展开就展开，但不要为了显得全面而罗列与问题无关的背景。` +
      (isExpert
        ? `

【本次是「专家模式」】用户已经把手上的**论文全文**一并给你了（见上面的【论文全文】）。
- 请先在脑子里通读全篇，再回答；需要时引用具体页码/小节/公式编号，让读者能按图索骥。
- **不要自我限长**：该写多少就写多少（几千字都可以），不要因为"怕太长"而砍掉推导、条件或边界讨论。
- 涉及本文事实时以全文为准；全文没有的就明说"全文未提供"，绝不编造。`
        : '');

    // 多轮：带最近 6 轮（每轮截断 1200 字）——太少会让"接着上一个问题问"失去上下文
    const turns: LlmTurn[] = [];
    (options.history || [])
      .slice(-6)
      .forEach(h => turns.push({ role: h.role, text: (h.text || '').slice(0, 1200) }));
    turns.push({ role: 'user', text: prompt });

    try {
      if (useOpenAI) {
        // ---- OpenAI 兼容（DeepSeek / 通义 / Kimi / 本地 vLLM…）----
        const endpoint = (cfg.get<string>('apiEndpoint', 'https://api.deepseek.com/v1') || '').replace(/\/+$/, '');
        // 与 Gemini 路径同样的回退语义：优先 aiModel，未配置则沿用翻译模型
        const model =
          (cfg.get<string>('aiModel', '') || '').trim() ||
          (cfg.get<string>('modelName', 'deepseek-chat') || '').trim() ||
          'deepseek-chat';
        const startedAt = Date.now();
        const res = await callOpenAICompatStream({
          endpoint,
          apiKey,
          model,
          systemInstruction,
          turns,
          temperature: cfg.get<number>('aiTemperature', 0.4),
          maxOutputTokens: this.assistantMaxTokens(answerStyle),
          signal: ctrl.signal,
          onDelta,
          idleTimeoutMs: 90000,
          totalTimeoutMs: 420000
        });

        const answer = (res.text || '').trim();
        if (!answer) throw new LlmError({ kind: 'empty', model, apiMessage: 'AI 返回空回答' });

        return {
          answer,
          model,
          ttftMs: res.ttftMs,
          totalMs: Date.now() - startedAt
        };
      }

      // ---- Gemini 原生 ----
      const model = this.assistantModel();
      const res = await generate(
        apiKey,
        {
          model,
          fallbackModels: this.fallbackChain(),
          systemInstruction,
          turns,
          temperature: cfg.get<number>('aiTemperature', 0.4),
          maxOutputTokens: this.assistantMaxTokens(answerStyle),
          thinkingConfig: this.assistantThinkingConfig(),
          signal: ctrl.signal,
          onDelta,
          idleTimeoutMs: 90000,
          totalTimeoutMs: 420000
        },
        this.log
      );

      const answer = (res.text || '').trim();
      if (!answer) throw new LlmError({ kind: 'empty', model: res.model, apiMessage: 'AI 返回空回答' });

      return {
        answer,
        model: res.model,
        ttftMs: res.ttftMs,
        totalMs: res.totalMs,
        note: this.fallbackNote(res)
      };
    } finally {
      this.aiRequests.delete(options.requestId);
    }
  }

  // ==========================================================================
  // 兼容旧接口（当前 webview 已不再主动调用，保留以免破坏其它入口）
  // ==========================================================================

  public async parseAndTranslatePage(
    rawText: string,
    pageNum: number,
    targetLang?: string
  ): Promise<StructuredParagraph[]> {
    const apiKey = this.getGeminiKey();
    if (!apiKey) throw new LlmError({ kind: 'no-key' });
    const res = await generate(
      apiKey,
      {
        model: this.translationModel(),
        fallbackModels: this.fallbackChain(),
        systemInstruction: '你是学术论文结构化助手，只输出严格合法的 JSON 数组。',
        turns: [
          {
            role: 'user',
            text: `把第 ${pageNum} 页的论文文字流规整为学术段落并翻译为${langName(targetLang)}：
${rawText.slice(0, 8000)}

只输出 JSON 数组，每项：{"type":"title|abstract|keywords|significance|body","original":"完整英文","translation":"中文译文"}`
          }
        ],
        temperature: 0.1,
        maxOutputTokens: 16384,
        jsonSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              original: { type: 'string' },
              translation: { type: 'string' }
            },
            required: ['type', 'original', 'translation']
          }
        },
        idleTimeoutMs: 90000,
        totalTimeoutMs: 300000
      },
      this.log
    );
    return this.toStructured(res.text, false);
  }

  /**
   * 视觉版面纠错（全面视觉分割的主入口）。
   *
   * 为什么是"纠错"而不是"从零分割"：让多模态模型直接给**坐标**不可靠（实测过，
   * 见下方 parseAndTranslatePageVision 的历史注记）；而它的强项是看懂版面——
   * 哪块是正文/图注/公式、阅读顺序、哪句被拦腰切断、哪块该合该拆。
   * 所以我们把**本地文本层的分段编号**一起给它，让它按编号回答；
   * 坐标依旧由本地文本层（charMap/spans）提供 —— 于是既拿到了视觉的理解力，
   * 又不牺牲划线高亮所需的像素级精度。
   */
  public async segmentPageWithVision(opts: {
    imageBase64: string;
    mimeType?: string;
    pageNum: number;
    /** 本地分段（编号必须与回包里的 i 对应） */
    segments: Array<{ id: number; type: string; text: string }>;
  }): Promise<VisionSegmentationResult> {
    const cfg = this.cfg();
    const service = (cfg.get<string>('translationService', 'gemini') || 'gemini').trim();
    const useOpenAI = service === 'openai-compatible';
    const startedAt = Date.now();

    const numbered = opts.segments
      .map(s => `[${s.id}] (${s.type}) ${String(s.text || '').replace(/\s+/g, ' ').trim()}`)
      .join('\n');

    const prompt =
      `这是论文第 ${opts.pageNum} 页的图像，下面还有一份程序给出的分段结果（顺序与类型可能有错）。\n` +
      `请结合图像判断，只输出 JSON：\n` +
      `{"segments":[{"i":0,"type":"figure|table|figure_caption|caption|body|heading|title|abstract|keywords|metadata|significance|formula|formula_inline|reference|footnote|header|footer|page_number|noise","order":1,"group":null,"action":"keep|merge_next|split|drop","why":"10 字内","latex":"仅公式类需要","parts":[{"type":"这一片的类型","at":"这一片开头的原文文字","latex":"仅公式片需要"}],"inline":[{"find":"文本层里逐字出现的残渣子串（≤20 字）","latex":"可渲染的 LaTeX"}]}],"fixes":"一句话总结你改了什么"}\n` +
      `规则：\n` +
      `- **segments 数组请按你判断的阅读顺序排列**；每个 i 都必须恰好出现一次，不要新增、不要漏掉，i 必须与下面列表的编号一致。\n` +
      `- type 按你判断的**真实**类型（列表里给的是程序的判断，可能错）。图像/表格**内部**的文字标 figure/table；图注、表注那一块标 figure_caption。\n` +
      `- 页眉、页脚、页码标 header/footer/page_number，并给 action "drop"。\n` +
      `- action 只在确实需要动分段时给，其余一律 "keep"：\n` +
      `  · **续句**：只有当**本段与紧随其后的那一段本是一段**（本段被从中间切开）时才给 "merge_next"。判据：\n` +
      `    **下一段的开头是小写字母、数字或左括号**（新段落不会从半句中间接续），且本段结尾没有句末标点。\n` +
      `    · 下一段以**大写字母**开头，或它是标题/图注/表格/元信息 → **不得给 merge_next**（那是新段落）。\n` +
      `    · 若只是"本段续自上一段"（例如跨页续接、上页末尾的半句续到本页），**不要**在本段给 merge_next：\n` +
      `      方向反了会把两段正常正文粘在一起，而且上一段根本不在这份列表里、本来就合不了。\n` +
      `  · 这一段里混了多种内容（典型："正文 + 独立公式 + 正文"）→ "split"，并在 parts 里**按阅读顺序**列出每一片：\n` +
      `    type 是这一片的真实类型；at 是这一片开头在**本地文本层里的原文文字**（照抄下面列表的写法，不要按你在图像上看到的排版写法写），10~40 字，第一片可以不给；\n` +
      `    是公式的那一片还要给 latex。\n` +
      `  · 同一段不要同时给 merge_next 和 split。\n` +
      `- group：同一张图/表的**图内文字与它的图注**给同一个正整数（同一页内唯一），不同图块用不同数字；独立成段的内容给 null。\n` +
      `- **公式一定要给 latex**：图片是唯一可靠的来源，程序从文本层抽出的是 "Y ̂ t" 这种残渣，无法渲染。\n` +
      `  例如图像上的 Ŷ_t = L(Ŷ_t, Y_t) + L(Ŷ_1, Y_1) 要写成 \\hat{Y}_t = \\mathcal{L}(\\hat{Y}_t, Y_t) + \\mathcal{L}(\\hat{Y}_1, Y_1)。\n` +
      `- inline：该段里的**每一个公式残渣都要给条目**（不要只给一部分，漏掉的就没法渲染了）。\n` +
      `  常见残渣形态：带组合抑扬符的 "Y ̂ t"、裸下标 "Y 1" / "Y t"、"S θ"、"L cycle,t"、"Y^t"。\n` +
      `  find 必须是该段文本里**逐字出现**的子串（照抄下面列表）、**不超过 20 个字符**，latex 是可渲染的 LaTeX。\n` +
      `  **不要给整句或整段公式**（那是 split 该做的事），该段确实没有残渣就给 []。\n` +
      `- 不要翻译，不要复述原文，不要解释。\n\n` +
      `程序的分段结果：\n${numbered}`;

    const systemInstruction =
      '你是学术论文版面分析器。只输出 JSON，不要 markdown 代码块，不要解释，不翻译原文。';

    const images = [{ mimeType: opts.mimeType || 'image/jpeg', base64: opts.imageBase64 }];
    // 默认 16000：实测 deepseek-flash 这类推理型视觉模型在 8000 时会把预算全花在推理上、
    // 正文 0 字符（那 8000 token 照样计费），加倍重试是必然的第二次往返 —— 不如一开始就够。
    const budget = Math.max(1500, Math.min(16000, cfg.get<number>('visionMaxTokens', 16000)));

    /**
     * 空回答自动加倍重试。
     *
     * 推理型视觉模型（如 deepseek-flash）会把 max_tokens 先花在推理上；
     * 预算不够时 finish_reason=length、content 为空，看起来像"模型没回答"。
     * 实测该模型在同一页给 8000 时依然**全是 reasoning、正文 0 字符**（那 8000 token 照样计费），
     * 16000 才稳定给出结果 —— 所以默认预算已经是 16000，这里再兜一层"加倍重试一次"，
     * 免得把这个坑甩给用户（他还得自己进设置改数字）。
     */
    const callWithBudget = async (maxOut: number) => {
      if (useOpenAI) {
        const endpoint = (cfg.get<string>('apiEndpoint', 'https://api.deepseek.com/v1') || '').replace(/\/+$/, '');
        const apiKey = (cfg.get<string>('apiKey', '') || '').trim();
        if (!apiKey) throw new LlmError({ kind: 'no-key', apiMessage: '未配置自定义大模型 API Key' });
        const model = this.visionModel(cfg, endpoint);
        const res = await callOpenAICompatStream({
          endpoint,
          apiKey,
          model,
          systemInstruction,
          turns: [{ role: 'user', text: prompt }],
          images,
          temperature: 0,
          maxOutputTokens: maxOut,
          jsonMode: true,
          idleTimeoutMs: 180000,
          totalTimeoutMs: 420000
        });
        return { text: res.text, model, usage: res.usage as VisionSegmentationResult['usage'] };
      }
      const apiKey = this.getGeminiKey(cfg);
      if (!apiKey) throw new LlmError({ kind: 'no-key', apiMessage: '未配置 Gemini API Key' });
      const model = this.visionModel(cfg, '');
      const res = await generate(
        apiKey,
        {
          model,
          systemInstruction,
          turns: [{ role: 'user', text: prompt }],
          images,
          temperature: 0,
          maxOutputTokens: maxOut,
          jsonMode: true,
          idleTimeoutMs: 180000,
          totalTimeoutMs: 420000
        },
        this.log
      );
      return { text: res.text, model: res.model, usage: res.usage as VisionSegmentationResult['usage'] };
    };

    let res: { text: string; model: string; usage?: VisionSegmentationResult['usage'] };
    try {
      res = await callWithBudget(budget);
    } catch (e: any) {
      const isEmpty = e instanceof LlmError && e.kind === 'empty';
      if (!isEmpty) throw e;
      const bigger = Math.min(16000, budget * 2);
      // 已经是上限就不再原样重发一次（同一提示、温度 0，结果只会一样，还多烧一次 token）
      if (bigger <= budget) {
        throw new LlmError({
          kind: 'empty',
          apiMessage: `视觉模型在 ${budget} token 预算下没有给出任何内容（推理型模型可能把预算全花在推理上）。请在设置里换一个视觉模型，或把「视觉最大输出 token」调到更高。`
        });
      }
      this.log(`视觉分割返回空（多半是推理吃光了 ${budget} token），加倍到 ${bigger} 重试一次`);
      res = await callWithBudget(bigger);
    }
    return this.toVisionResult(res.text, res.model, Date.now() - startedAt, res.usage);
  }

  /**
   * 视觉这一步用哪个模型。
   *
   * 单独一个设置项而不是沿用翻译模型：翻译用纯文本模型（便宜、快）就够，
   * 只有版面判断需要视觉。缺省时沿用问答模型（用户可能已经填了视觉模型）。
   * 另外对"明显不支持图片"的常见组合直接给出可操作的报错，而不是等 API 返回 400。
   */
  private visionModel(cfg: vscode.WorkspaceConfiguration, endpoint: string): string {
    const explicit = (cfg.get<string>('visionModel', '') || '').trim();
    if (explicit) return explicit;

    const inherited = (
      (cfg.get<string>('aiModel', '') || '').trim() ||
      (cfg.get<string>('modelName', '') || '').trim() ||
      ''
    ).trim();

    const looksTextOnly = /deepseek-(chat|reasoner)/i.test(inherited) || /^moonshot-v1-(8k|32k|128k)$/i.test(inherited);
    const isDeepSeek = /deepseek\.com/i.test(endpoint) || /deepseek/i.test(inherited);
    if (!inherited || looksTextOnly) {
      throw new LlmError({
        kind: 'invalid-request',
        apiMessage:
          `视觉分割需要一个能读图的模型，当前配置的「${inherited || '（空）'}」不支持图片。` +
          (isDeepSeek ? '请在设置里把「视觉模型」填成 deepseek-flash（DeepSeek 的视觉模型）。' : '请在设置里填写一个支持图片的模型（如 qwen-vl-max / glm-4v / gpt-4o 等）。')
      });
    }
    return inherited;
  }

  /** 解析视觉回包：容忍 ```json 围栏、校验编号、收敛类型取值 */
  private toVisionResult(
    raw: string,
    model: string,
    totalMs: number,
    usage?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
  ): VisionSegmentationResult {
    const text = (raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      throw new LlmError({
        kind: 'invalid-request',
        model,
        apiMessage: `视觉回包不是合法 JSON：${String(text).slice(0, 120)}`
      });
    }
    const allowed = new Set([
      'figure',
      'table',
      'figure_caption',
      'caption',
      'body',
      'heading',
      'formula',
      'formula_inline',
      'header',
      'footer',
      'reference',
      'page_number',
      'noise',
      'title',
      'abstract',
      'keywords',
      'metadata',
      'footnote',
      'significance'
    ]);
    /** 一部分一段的 LaTeX 与类型 —— 拆分点由 webview 在文本层里定位，这里只做形状与取值校验 */
    const cleanParts = (raw: any): VisionPart[] | undefined => {
      if (!Array.isArray(raw)) return undefined;
      const parts: VisionPart[] = [];
      for (const p of raw) {
        if (!p) continue;
        const t = String(p?.type || '');
        parts.push({
          type: allowed.has(t) ? t : 'body',
          at: typeof p?.at === 'string' && p.at.trim() ? p.at.trim().slice(0, 200) : undefined,
          latex: typeof p?.latex === 'string' && p.latex.trim() ? p.latex.trim().slice(0, 600) : undefined
        });
      }
      return parts.length >= 2 ? parts : undefined;
    };
    /** 行内公式替换表：find 必须足够长才可能定位得到，太短的（如单个字符）直接丢 */
    const cleanInline = (raw: any): VisionInlineMath[] | undefined => {
      if (!Array.isArray(raw)) return undefined;
      const list: VisionInlineMath[] = [];
      for (const it of raw) {
        const find = typeof it?.find === 'string' ? it.find.trim() : '';
        const latex = typeof it?.latex === 'string' ? it.latex.trim() : '';
        if (find.length < 2 || !latex) continue;
        list.push({ find: find.slice(0, 120), latex: latex.slice(0, 600) });
        if (list.length >= 8) break;
      }
      return list.length > 0 ? list : undefined;
    };
    const rawSegs = Array.isArray(parsed?.segments) ? parsed.segments : [];
    const segments: VisionSegment[] = [];
    for (const s of rawSegs) {
      const i = Number(s?.i ?? s?.index);
      if (!Number.isFinite(i)) continue;
      const type = String(s?.type || '');
      const action = String(s?.action || 'keep');
      const group = Number(s?.group);
      segments.push({
        index: i,
        type: allowed.has(type) ? type : 'body',
        order: Number.isFinite(Number(s?.order)) ? Number(s.order) : undefined,
        // 图块编号：只接受正整数（模型偶尔给 "1a" / 0 / null，一律当"没有分组"）
        group: Number.isInteger(group) && group > 0 ? group : undefined,
        action: (['keep', 'merge_next', 'split', 'drop'].includes(action) ? action : 'keep') as VisionSegment['action'],
        why: typeof s?.why === 'string' ? s.why.slice(0, 60) : undefined,
        // 公式的 LaTeX 转写：文本层给不出（抽出来是 "Y ̂ t" 这种残渣），只有图像可靠
        latex: typeof s?.latex === 'string' && s.latex.trim() ? s.latex.trim().slice(0, 600) : undefined,
        // 拆分：优先用 v2 的 parts（每片自带类型与 LaTeX）；只有老式 splitAt 时留空，由 webview 兜底
        parts: cleanParts(s?.parts),
        // 拆分点：新片段开头的原文文字，webview 据此在 charMap 上找切点
        splitAt: Array.isArray(s?.splitAt)
          ? s.splitAt
              .filter((t: any) => typeof t === 'string' && t.trim())
              .map((t: string) => t.trim().slice(0, 200))
          : undefined,
        inline: cleanInline(s?.inline)
      });
    }
    if (segments.length === 0) {
      throw new LlmError({ kind: 'empty', model, apiMessage: '视觉回包里没有任何分段（segments 为空）' });
    }
    return {
      version: VISION_PROTOCOL_VERSION,
      columns: Number.isFinite(Number(parsed?.columns)) ? Number(parsed.columns) : undefined,
      segments,
      fixes: typeof parsed?.fixes === 'string' ? parsed.fixes.slice(0, 200) : undefined,
      model,
      totalMs,
      usage
    };
  }

  public async parseAndTranslatePageVision(
    _pageImageBase64: string,
    _rawText: string,
    _pageNum: number,
    _targetLang?: string
  ): Promise<StructuredParagraph[]> {
    // 【历史注记】这里曾经让视觉模型直接给"结构化段落 + 坐标"，结果证明坐标不可靠，
    // 于是停用。现在的做法见 segmentPageWithVision()：视觉只判断结构与类型，
    // 坐标继续由本地文本层给出（charMap/spans 精确到字符）。
    throw new LlmError({
      kind: 'invalid-request',
      apiMessage: '视觉结构化解析（带坐标）已废弃，请使用 segmentPageWithVision()'
    });
  }

  public async locateParagraphVisual(
    _pageImageBase64?: string,
    _text?: string,
    _pageNum?: number
  ): Promise<number[][]> {
    // 同上：视觉给的框不够精确，划线高亮一律用本地 DOM/文本层坐标。
    throw new LlmError({
      kind: 'invalid-request',
      apiMessage: '视觉定位已废弃（本地 DOM 高亮更精确），请使用文本层坐标'
    });
  }

  private toStructured(raw: string, withBoxes: boolean): StructuredParagraph[] {
    let text = (raw || '').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    let arr: any;
    try {
      arr = JSON.parse(text);
    } catch {
      const a = text.indexOf('[');
      const b = text.lastIndexOf(']');
      if (a < 0 || b <= a) throw new LlmError({ kind: 'parse', apiMessage: '结构化解析返回非 JSON' });
      arr = JSON.parse(text.slice(a, b + 1));
    }
    if (!Array.isArray(arr)) throw new LlmError({ kind: 'parse', apiMessage: '结构化解析返回的不是数组' });
    return arr
      .map((it: any) => ({
        type: it.type || 'body',
        original: String(it.original || '').replace(/\s+/g, ' ').trim(),
        translation: String(it.translation || '').trim(),
        boxes: withBoxes && Array.isArray(it.boxes) ? it.boxes : undefined
      }))
      .filter(p => p.original.length > 0);
  }

  // ==========================================================================
  // 低层 HTTP（仅内置免费翻译与自定义接口使用；Gemini 走 llmClient）
  // ==========================================================================

  private httpGet(targetUrl: string, timeoutMs = 8000): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(
        targetUrl,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          timeout: timeoutMs
        },
        res => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP error ${res.statusCode}`));
            return;
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve(data));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  private httpPost(
    targetUrl: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs = 60000
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const options = {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs
      };

      const req = client.request(targetUrl, options, res => {
        if (res.statusCode && res.statusCode >= 400) {
          let errData = '';
          res.on('data', chunk => (errData += chunk));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errData}`)));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('LLM Request timeout'));
      });
      req.write(body);
      req.end();
    });
  }
}
