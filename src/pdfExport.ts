/**
 * 「高光批注 PDF」导出。
 *
 * 输出形态（用户明确要求"所有页，视觉上就是高光后的原文"，译文位置由实现决定）：
 *   第 1 部分 —— **原封不动的全部原文页**（保留版式与图），把每条高亮按原坐标画回去，
 *                颜色/透明度/混合模式与阅读器里看到的一致（multiply + 0.6）。
 *   第 2 部分 —— 附录「对照译文与笔记」：按页、按段落给出 原文 → 译文，
 *                有高亮的段落带同色标记条，其下接我的批注与 AI 答疑。
 *
 * 为什么坐标能画准：批注的 `rects` 是 webview 用「画布坐标 ÷ 当前缩放」存下来的，
 * 也就是 **PDF 点、左上角原点**；pdf-lib 用的是左下角原点，所以做一次 y 翻转即可。
 */
import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument, PDFFont, PDFPage, rgb, BlendMode } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { AnnotationItem, PaperMetadata } from './notesStorage';
import {
  ArchivedParagraph,
  resolveArchivedSentences,
  resolveArchivedTranslation
} from './pageArchive';

export interface PdfExportOptions {
  /** 原始 PDF 的字节 */
  originalBytes: Uint8Array;
  /** 论文数据（批注、段落快照、AI 答疑、译文缓存） */
  paperData: PaperMetadata;
  /** 论文名（写进附录标题） */
  paperName: string;
  /** 设置里的字体路径覆盖（academicReader.pdfExportFontPath） */
  fontPathOverride?: string;
  /** 是否把所有页都放进 PDF（false 时只放有批注的页） */
  includeAllPages?: boolean;
  /**
   * 是否附上「高光译文」（默认 true）。
   * false = 只导出"高光后的原文"：不生成译文页、不画编号圆点，**也就不需要中文字体**，
   * 所以在没装中文字体的机器上这种模式照样能用。
   */
  includeTranslation?: boolean;
  /** 当前翻译引擎标识（用于回查 `${page}_${引擎标识}_${指纹}` 形式的译文缓存） */
  engineTag?: string;
}

export interface PdfExportResult {
  bytes: Uint8Array;
  /** 原文页数 */
  sourcePages: number;
  /** 附录页数 */
  appendixPages: number;
  /** 画上去的高亮条数 */
  drawnAnnotations: number;
  /** 该页有旋转、坐标无法安全映射而被跳过高亮的页号 */
  rotatedPagesSkipped: number[];
  /** 实际使用的中文字体路径（未找到则为空） */
  fontPath: string;
  /** 附录里真正带上了译文的页号 */
  translatedPages: number[];
  /** 原文里没有译文、因此附录未收录的页号 */
  pagesWithoutTranslation: number[];
  warnings: string[];
}

/** 把页码压成 "1–3, 7" 这种可读区间（与 webview 里的同名逻辑一致） */
function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return '（无）';
  const parts: string[] = [];
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

/**
 * 与阅读器一致的高亮底色（见 media/viewer.css 的 .highlight-mark.*）。
 * 统一存 0~1 的浮点：pdf-lib 的 rgb() 只吃这个区间，
 * 存 0~255 会在画标记条时炸掉（"red must be at least 0 and at most 1, but was actually 255"）。
 */
const HIGHLIGHT_RGB: Record<string, [number, number, number]> = {
  yellow: [1, 235 / 255, 59 / 255], // #ffeb3b
  green: [0, 230 / 255, 118 / 255], // #00e676
  blue: [0, 176 / 255, 1], // #00b0ff
  pink: [1, 64 / 255, 129 / 255] // #ff4081
};
const HIGHLIGHT_OPACITY = 0.6;
const COLOR_NAME: Record<string, string> = {
  yellow: '核心要点',
  green: '论据/数据',
  blue: '方法/公式',
  pink: '疑难/待查'
};

/**
 * 我们要往 PDF 里排的字：**中英文都得有**。
 *
 * 只验"能不能画汉字"是不够的——CI 实测踩到：DroidSansFallbackFull.ttf 有完整汉字
 * 却没有拉丁字形，于是导出的 PDF 里中文正常、英文全变成 U+0000（提取出来是一串 ^@）。
 */
const REQUIRED_GLYPH_SAMPLE = 'AaZz09中文测试，。';

/** 字体文件是否同时覆盖中英文（用 fontkit 直接看字形 id，0 = .notdef 缺字） */
function fontFileCoversSample(bytes: Buffer, sample = REQUIRED_GLYPH_SAMPLE): boolean {
  try {
    const parsed: any = fontkit.create(bytes);
    if (!parsed || typeof parsed.layout !== 'function') return false; // .ttc 集合会走到这里
    const glyphs: any[] = parsed.layout(sample).glyphs || [];
    if (glyphs.length === 0) return false;
    return glyphs.every(g => g && g.id !== 0);
  } catch {
    return false;
  }
}

/** 逐个候选找一份"中英文都能画"的字体（override 优先） */
export function listFontCandidates(override?: string): string[] {
  const out: string[] = [];
  const push = (p?: string) => {
    if (!p) return;
    const v = p.trim();
    // .ttc 是字体集合：pdf-lib 的 embedFont 无法指定其中某一款，直接排除
    if (!v || !/\.(ttf|otf)$/i.test(v) || out.includes(v)) return;
    try {
      if (fs.existsSync(v) && fs.statSync(v).isFile() && fs.statSync(v).size > 0) out.push(v);
    } catch {
      /* 忽略这个候选 */
    }
  };
  push(override);

  const winDir = process.env.WINDIR || 'C:\\Windows';
  [
    path.join(winDir, 'Fonts', 'simhei.ttf'), // 黑体：简体 + 拉丁都全
    path.join(winDir, 'Fonts', 'STXIHEI.TTF'),
    path.join(winDir, 'Fonts', 'STSONG.TTF'),
    path.join(winDir, 'Fonts', 'Deng.ttf'),
    path.join(winDir, 'Fonts', 'simkai.ttf'),
    path.join(winDir, 'Fonts', 'simfang.ttf'),
    path.join(winDir, 'Fonts', 'simsunb.ttf'),
    // macOS
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Songti.ttf',
    // Linux：Debian/Ubuntu 的 noto-cjk 只有 .ttc（用不了），所以优先这些单体 TTF
    '/usr/share/fonts/truetype/arphic/gbsn00lp.ttf', // 宋体，GB2312 简体 + 拉丁
    '/usr/share/fonts/truetype/arphic/gkai00mp.ttf',
    '/usr/share/fonts/truetype/arphic/bkai00mp.ttf',
    '/usr/share/fonts/truetype/arphic/ukai.ttf',
    '/usr/share/fonts/truetype/arphic/uming.ttf',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', // 注意：无拉丁字形，会被覆盖检查挡掉
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/opentype/noto/NotoSerifCJKsc-Regular.otf'
  ].forEach(push);
  return out;
}

/**
 * 找一份**可嵌入的中文字体**。
 *
 * 返回第一个"文件存在且中英文都能画"的路径；找不到返回 undefined。
 * 保留这个导出函数是为了兼容既有调用与测试。
 */
export function findCjkFontPath(override?: string): string | undefined {
  for (const p of listFontCandidates(override)) {
    try {
      if (fontFileCoversSample(fs.readFileSync(p))) return p;
    } catch {
      /* 换下一个候选 */
    }
  }
  return undefined;
}

/**
 * 字体是否真的能画出汉字。
 *
 * 只看宽度是不够的：拉丁字体遇到汉字会回落到 .notdef 字形，宽度照样不为 0。
 * 所以直接看 encodeText 出来的字形编号——全是 0000 就说明一个汉字都没有。
 */
function fontSupportsChinese(font: PDFFont): boolean {
  const sample = '中文测试';
  try {
    const w = font.widthOfTextAtSize(sample, 12);
    if (!Number.isFinite(w) || w <= 0) return false;
    const encoded: any = (font as any).encodeText?.(sample);
    const hex = String(encoded?.asHexString?.() ?? encoded?.value ?? '');
    const glyphIds = hex.match(/[0-9a-fA-F]{4}/g) || [];
    if (glyphIds.length > 0 && glyphIds.every(g => /^0+$/.test(g))) return false;
    return true;
  } catch {
    return false;
  }
}

const CJK_CHAR = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;

/** 把一行拆成可换行的单元：汉字逐字，拉丁按词（空格并入后一个词） */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const nextWord = (start: number): { text: string; end: number } => {
    let j = start;
    if (CJK_CHAR.test(line[j])) return { text: line[j], end: j + 1 };
    while (j < line.length && line[j] !== ' ' && !CJK_CHAR.test(line[j])) j++;
    return { text: line.slice(start, j), end: j };
  };
  while (i < line.length) {
    if (line[i] === ' ') {
      let j = i;
      while (j < line.length && line[j] === ' ') j++;
      const spaces = line.slice(i, j);
      if (j >= line.length) {
        tokens.push(spaces);
        break;
      }
      const w = nextWord(j);
      tokens.push(spaces + w.text);
      i = w.end;
    } else {
      const w = nextWord(i);
      tokens.push(w.text);
      i = w.end;
    }
  }
  return tokens;
}

/** 中英混排的按宽度折行（对每行整串测宽，避免逐字测宽的累积误差） */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  const measure = (s: string) => {
    try {
      return font.widthOfTextAtSize(s, size);
    } catch {
      return 0;
    }
  };
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    let line = '';
    for (const tk of tokenize(rawLine)) {
      const candidate = line ? line + tk : tk.replace(/^\s+/, '');
      if (line && measure(candidate) > maxWidth) {
        out.push(line.trimEnd());
        line = tk.replace(/^\s+/, '');
        // 单个词比整行还宽（长 URL、长英文单词）→ 硬切
        while (line.length > 1 && measure(line) > maxWidth) {
          let cut = line.length;
          while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = candidate;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** 一行行往页面上写，写不下就翻页 */
class FlowWriter {
  private page: PDFPage | null = null;
  public y = 0;
  /** 已经用掉几个版面页（用于统计） */
  public sheets = 0;

  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private width: number,
    private height: number,
    private margin: number
  ) {}

  /** 开一张新的译文页（原文页后面紧跟的那种） */
  startSheet(): void {
    this.page = this.doc.addPage([this.width, this.height]);
    this.y = this.height - this.margin;
    this.sheets++;
  }

  get currentPage(): PDFPage {
    if (!this.page) this.startSheet();
    return this.page as PDFPage;
  }

  newPage(): void {
    this.startSheet();
  }

  ensure(space: number): void {
    if (!this.page) this.startSheet();
    if (this.y - space < this.margin) this.startSheet();
  }

  /**
   * 写一段文字。返回占用的行数。
   * `bar` 传入颜色时，会在段落左侧画一条同色标记条（对应原文里的高亮）。
   */
  paragraph(
    text: string,
    opts: {
      size?: number;
      color?: [number, number, number];
      indent?: number;
      lineGap?: number;
      spaceAfter?: number;
      bold?: boolean;
      bar?: [number, number, number];
      barHeightPad?: number;
    } = {}
  ): number {
    const size = opts.size ?? 10.5;
    const indent = opts.indent ?? 0;
    const lineGap = opts.lineGap ?? 4.2;
    const maxWidth = this.width - this.margin * 2 - indent - (opts.bar ? 8 : 0);
    const lines = wrapText(text, this.font, size, maxWidth);
    const lineHeight = size + lineGap;
    const startY = this.y;

    lines.forEach(l => {
      this.ensure(lineHeight);
      this.y -= lineHeight;
      if (l) {
        this.currentPage.drawText(l, {
          x: this.margin + indent + (opts.bar ? 8 : 0),
          y: this.y,
          size,
          font: this.font,
          color: rgb(...(opts.color ?? [0.13, 0.13, 0.15]))
        });
      }
    });

    if (opts.bar) {
      this.currentPage.drawRectangle({
        x: this.margin + indent,
        y: this.y - 2,
        width: 3,
        height: Math.max(lineHeight, startY - this.y - 2),
        color: rgb(opts.bar[0], opts.bar[1], opts.bar[2])
      });
    }
    this.y -= opts.spaceAfter ?? 4;
    return lines.length;
  }

  divider(): void {
    this.ensure(10);
    this.y -= 6;
    this.currentPage.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.width - this.margin, y: this.y },
      thickness: 0.5,
      color: rgb(0.78, 0.8, 0.84)
    });
    this.y -= 6;
  }
}

/** 附录里按段落聚合出来的内容（原文 + 译文 + 该段的批注/答疑） */
interface AppendixEntry {
  para: ArchivedParagraph;
  /** 解析后的译文（不只看 para.translation，还要回查译文缓存 —— 见 resolveArchivedTranslation） */
  translation: string;
  sentences: string[] | null;
  colors: string[];
  annotations: AnnotationItem[];
  qa: Array<{ question: string; answer: string; model?: string; at: number; selectedText?: string }>;
}

function buildAppendix(paperData: PaperMetadata, engineTag?: string) {
  const archive = paperData.pageArchive || {};
  const annotations = Array.isArray(paperData.annotations) ? paperData.annotations : [];
  const qaList = Array.isArray(paperData.aiQa) ? paperData.aiQa : [];

  const pageNumbers = Object.keys(archive)
    .map(n => Number(n))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  const pages = pageNumbers
    .map(page => {
      const paras = (archive[String(page)] || []).filter(p => p && p.type !== 'figure-label');
      const entries: AppendixEntry[] = paras.map(p => {
        const own = annotations.filter(a => a.page === page && a.paraIndex !== undefined && a.paraIndex === p.id);
        const text = (p.cleanText || '').trim();
        const qa = qaList.filter(
          q => q.page === page && q.selectedText && text.includes(String(q.selectedText).slice(0, 40))
        );
        return {
          para: p,
          // 关键：译文可能不在快照里，而在 paperData.translations 里
          translation: resolveArchivedTranslation(page, p, paperData.translations, engineTag),
          sentences: resolveArchivedSentences(page, p, paperData.sentenceTranslations, engineTag),
          colors: [...new Set(own.map(a => a.color))],
          annotations: own,
          qa
        };
      });
      const usedAnnot = new Set(entries.flatMap(e => e.annotations.map(a => a.id)));
      const usedQa = new Set(entries.flatMap(e => e.qa.map(q => q.question + q.at)));
      const orphanAnnotations = annotations.filter(a => a.page === page && !usedAnnot.has(a.id));
      const orphanQa = qaList.filter(q => q.page === page && !usedQa.has(q.question + q.at));
      return { page, entries, orphanAnnotations, orphanQa };
    })
    .filter(
      p =>
        p.entries.some(e => e.translation || e.annotations.length || e.qa.length) ||
        p.orphanAnnotations.length > 0 ||
        p.orphanQa.length > 0
    );

  return { pages, annotations, qaList };
}

/**
 * 生成「高光批注 PDF」。
 *
 * 原文页用 pdf-lib 的 copyPages 原样搬运（矢量、可搜索、体积小），
 * 只往上叠高亮矩形；译文与笔记另起附录页（需要能画汉字的字体）。
 */
export async function buildAnnotatedPdf(opts: PdfExportOptions): Promise<PdfExportResult> {
  const { originalBytes, paperData, paperName } = opts;
  const warnings: string[] = [];
  const includeAllPages = opts.includeAllPages !== false;

  const src = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();

  const annotations = Array.isArray(paperData.annotations) ? paperData.annotations : [];
  const annotatedPages = new Set(annotations.map(a => a.page));

  const indices = src
    .getPageIndices()
    .filter(i => includeAllPages || annotatedPages.has(i + 1));
  const sourcePageCount = src.getPageCount();

  // ---- 用户选了"不要高光译文"就什么都不用找字体 ----
  // 这一档只导出"高光后的原文"，因此在没有中文字体的机器上也能正常用，
  // 自然也不该弹"没找到中文字体"的警告。
  const wantTranslation = opts.includeTranslation !== false;

  // ---- 中文字体先就位 ----
  // 它不只是排版译文页要用：原文页上给每条高光画的编号标记也要用它。
  // 选字体时必须确认**中英文都能画**，否则英文会变成一串 U+0000（CI 实测踩过）。
  const candidates = wantTranslation ? listFontCandidates(opts.fontPathOverride) : [];
  const fontPath = candidates.length > 0 ? findCjkFontPath(opts.fontPathOverride) : undefined;
  let font: PDFFont | undefined;
  if (wantTranslation && fontPath) {
    try {
      out.registerFontkit(fontkit);
      font = await out.embedFont(fs.readFileSync(fontPath), { subset: true });
      if (!fontSupportsChinese(font)) {
        warnings.push(`字体 ${path.basename(fontPath)} 似乎没有中文字形，已只导出原文页。`);
        font = undefined;
      }
    } catch (e: any) {
      warnings.push(`嵌入中文字体失败（${path.basename(fontPath)}）：${e?.message || e}。已只导出原文页。`);
      font = undefined;
    }
  } else if (wantTranslation) {
    const tried = candidates.map(c => path.basename(c)).join('、') || '（无候选）';
    warnings.push(
      candidates.length > 0
        ? `试过的字体都没有同时覆盖中文与英文（${tried}），已只导出原文页。` +
            '可用设置 academicReader.pdfExportFontPath 指定一个中英文都全的 ttf/otf（注意 .ttc 字体集合无法嵌入）。'
        : '没有找到可嵌入的中文字体，已只导出原文页（高亮已画回原位）。可在设置 academicReader.pdfExportFontPath 指定一个中文 ttf/otf 字体。'
    );
  }
  // 用户指定了字体、但它不含中文（或中英文不全）而被跳过时，必须明确告知：
  // 否则设置里写错了字体，用户只会觉得"我的设置没生效"，无从查起。
  const override = (opts.fontPathOverride || '').trim();
  if (wantTranslation && override && fontPath && override !== fontPath) {
    warnings.push(
      `你指定的字体 ${path.basename(override)} 不含所需字形（中文/英文都要有），本次改用 ${path.basename(fontPath)}。`
    );
  }

  // ---- 每页的"高光 → 译文"内容（按高光组织，而不是按段落）----
  const { pages: pagesWithContent } = wantTranslation ? buildAppendix(paperData, opts.engineTag) : { pages: [] as ReturnType<typeof buildAppendix>['pages'] };
  const contentByPage = new Map(pagesWithContent.map(p => [p.page, p]));

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN = 52;
  const writer = font ? new FlowWriter(out, font, PAGE_W, PAGE_H, MARGIN) : null;

  let drawnAnnotations = 0;
  const rotatedPagesSkipped: number[] = [];
  const translatedPageNumbers: number[] = [];
  const highlightedPageNumbers: number[] = [];
  /** 高光全是公式/符号段落、因此"无需翻译"的页 */
  const formulaOnlyPageNumbers: number[] = [];

  // 逐页：原文页 → （若有高光）紧跟一页编号译文
  for (const srcIdx of indices) {
    const pageNum = srcIdx + 1;
    const [copiedPage] = await out.copyPages(src, [srcIdx]);
    const page = out.addPage(copiedPage);
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const pageHeight = page.getHeight();

    // 保持 annotations 的原始顺序：编号在原文页与译文页上必须一致
    const pageAnnots = annotations.filter(
      a => a.page === pageNum && Array.isArray(a.rects) && a.rects.length > 0
    );
    if (pageAnnots.length > 0) highlightedPageNumbers.push(pageNum);

    let tagNo = 0;
    pageAnnots.forEach(annot => {
      const rects = annot.rects as Array<{ left: number; top: number; width: number; height: number }>;
      // 页面带旋转时，webview 记下的画布坐标与页面坐标系不再一一对应：
      // 宁可如实少画，也不要画到错误的位置上骗人。
      if (angle !== 0) {
        if (!rotatedPagesSkipped.includes(pageNum)) rotatedPagesSkipped.push(pageNum);
        return;
      }
      const [r, g, b] = HIGHLIGHT_RGB[annot.color] || HIGHLIGHT_RGB.yellow;
      rects.forEach(rect => {
        const x = Number(rect.left) || 0;
        const w = Number(rect.width) || 0;
        const h = Number(rect.height) || 0;
        const yTop = Number(rect.top) || 0;
        if (w <= 0 || h <= 0) return;
        try {
          page.drawRectangle({
            x,
            y: pageHeight - yTop - h,
            width: w,
            height: h,
            color: rgb(r, g, b),
            opacity: HIGHLIGHT_OPACITY,
            blendMode: BlendMode.Multiply,
            borderWidth: 0
          });
          drawnAnnotations++;
        } catch {
          /* 单条画失败不影响整份导出 */
        }
      });

      // 编号标记画在**左页边距**（学术论文那里基本是空白），
      // 与紧随其后的译文页条目一一对应。
      if (font) {
        tagNo++;
        const first = rects[0];
        const cx = 12;
        const cy = pageHeight - (Number(first.top) || 0) - (Number(first.height) || 0) / 2;
        try {
          page.drawCircle({ x: cx, y: cy, size: 6.5, color: rgb(1, 1, 1), borderColor: rgb(r, g, b), borderWidth: 0.8 });
          const label = String(tagNo);
          const tw = font.widthOfTextAtSize(label, 8);
          page.drawText(label, { x: cx - tw / 2, y: cy - 2.9, size: 8, font, color: rgb(0.15, 0.15, 0.2) });
        } catch {
          /* 标记失败不影响导出 */
        }
      }
    });

    // 有高光（或该页有已解析内容）就紧跟一页编号译文
    const content = contentByPage.get(pageNum);
    if (font && writer && (pageAnnots.length > 0 || content)) {
      const sheetStat = writeHighlightSheet(writer, pageNum, pageAnnots, content);
      if (pageAnnots.length > 0 && sheetStat.translated > 0) translatedPageNumbers.push(pageNum);
      // 整页高光都是"公式/符号段落"的，不算"缺译文"（本来就没有可翻译的文字）
      if (pageAnnots.length > 0 && sheetStat.translated === 0 && sheetStat.formulaOnly === pageAnnots.length) {
        formulaOnlyPageNumbers.push(pageNum);
      }
    }
  }

  // ---- 末尾：覆盖范围说明 + 还缺译文的页 ----
  // "有高光但没译文"才是用户能行动的信息，单独列出来。
  // 公式/符号页不算缺译文（本来就没有可翻译的文字），否则会误导用户去"整页翻译"。
  const pagesWithoutTranslation = highlightedPageNumbers.filter(
    n => !translatedPageNumbers.includes(n) && !formulaOnlyPageNumbers.includes(n)
  );
  // 相册里没有任何高光的页不算"缺译文"，它们本来就没有要对照的东西
  const pageNumbersWithNoSheet = indices
    .map(i => i + 1)
    .filter(n => !highlightedPageNumbers.includes(n) && !contentByPage.has(n));

  if (font && writer && wantTranslation) {
    writeSummarySheet(writer, {
      paperName,
      sourcePages: sourcePageCount,
      annotationCount: annotations.length,
      aiQaCount: paperData.aiQa?.length || 0,
      highlightedPages: highlightedPageNumbers,
      translatedPages: translatedPageNumbers,
      pagesWithoutTranslation,
      pagesWithNoSheet: pageNumbersWithNoSheet
    });
  }

  if (rotatedPagesSkipped.length > 0) {
    warnings.push(
      `第 ${rotatedPagesSkipped.join('、')} 页带旋转，坐标无法安全映射，这些页未画高亮（页面本身仍在）。`
    );
  }

  const bytes = await out.save();
  return {
    bytes,
    sourcePages: indices.length,
    appendixPages: writer ? writer.sheets : 0,
    drawnAnnotations,
    rotatedPagesSkipped,
    fontPath: font ? fontPath || '' : '',
    // 没字体就没有译文页，也就没有任何译文被收录 —— 如实返回，别让上层以为"都覆盖了"
    translatedPages: font ? translatedPageNumbers : [],
    pagesWithoutTranslation,
    warnings
  };
}

/** 从段落里挑出与这条高光最贴切的中文：优先"这一句"的译文，其次整段译文 */
function pickTranslationForAnnotation(annot: AnnotationItem, entry: AppendixEntry | undefined): string {
  if (!entry) return '';
  const text = String(annot.text || '').replace(/\s+/g, ' ').trim();
  const sentencesEn = entry.para.sentencesEn || [];
  if (text && entry.sentences && entry.sentences.length === sentencesEn.length && sentencesEn.length > 0) {
    const idx = sentencesEn.findIndex(s => {
      const en = String(s.text || '').replace(/\s+/g, ' ').trim();
      if (!en) return false;
      return text.includes(en) || en.includes(text.slice(0, 40));
    });
    if (idx >= 0 && entry.sentences[idx]) return entry.sentences[idx];
  }
  return entry.translation || '';
}

/**
 * 写一页「第 N 页 · 高光译文」：编号与原文页上的圆点标记一一对应。
 *
 * 返回：`translated` = 真正拿到译文的条数（判断该页算不算"已覆盖"）；
 * `formulaOnly` = 因"是公式/符号段落、无需翻译"而没译文的条数
 * （若整页高光都是这一类，就不该把它算成"缺译文"）。
 */
function writeHighlightSheet(
  writer: FlowWriter,
  pageNum: number,
  pageAnnots: AnnotationItem[],
  content: { entries: AppendixEntry[]; orphanAnnotations: AnnotationItem[]; orphanQa: Array<{ question: string; answer: string; model?: string; at: number; selectedText?: string }> } | undefined
): { translated: number; formulaOnly: number } {
  const entryByPara = new Map<number, AppendixEntry>();
  (content?.entries || []).forEach(e => entryByPara.set(e.para.id, e));

  writer.startSheet();
  writer.paragraph(`第 ${pageNum} 页 · 高光译文`, { size: 15, color: [0.06, 0.09, 0.16], spaceAfter: 2 });

  let translated = 0;
  let formulaOnly = 0;
  if (pageAnnots.length === 0) {
    writer.paragraph('（本页没有高光，下面是本页其它已翻译的段落。）', {
      size: 9.5,
      color: [0.5, 0.5, 0.55],
      spaceAfter: 4
    });
  }

  pageAnnots.forEach((annot, idx) => {
    const entry =
      annot.paraIndex !== undefined ? entryByPara.get(annot.paraIndex) : undefined;
    const zh = pickTranslationForAnnotation(annot, entry);
    const colorName = COLOR_NAME[annot.color] || annot.color;
    const [r, g, b] = HIGHLIGHT_RGB[annot.color] || HIGHLIGHT_RGB.yellow;

    writer.paragraph(`${idx + 1}. ${colorName}`, {
      size: 11,
      color: [r * 0.6, g * 0.6, b * 0.6],
      spaceAfter: 1
    });
    if (zh) translated++;
    writer.paragraph(`原文摘录：${annot.text || ''}`, {
      size: 10,
      indent: 10,
      color: [0.2, 0.22, 0.26],
      bar: [r, g, b],
      spaceAfter: 2
    });
    if (zh) {
      writer.paragraph(`译文：${zh}`, { size: 10.5, indent: 10, color: [0.07, 0.28, 0.5], spaceAfter: 2 });
    } else if (entry?.para.type === 'formula') {
      // 公式/符号段落没有可翻译的文字：写"无需翻译"，不要写成"还没有译文"让人以为失败了
      formulaOnly++;
      writer.paragraph('译文：（公式/符号段落，无需翻译）', {
        size: 9.5,
        indent: 10,
        color: [0.45, 0.47, 0.55],
        spaceAfter: 2,
        lineGap: 3.6
      });
    } else {
      writer.paragraph(
        `译文：（这一条还没有译文——在阅读器里翻到第 ${pageNum} 页并按「整页翻译」译出后重新导出即可补齐）`,
        { size: 9.5, indent: 10, color: [0.6, 0.35, 0.3], spaceAfter: 2, lineGap: 3.6 }
      );
    }
    if (annot.note && annot.note.trim()) {
      writer.paragraph(`我的批注：${annot.note.trim()}`, { size: 10, indent: 10, color: [0.32, 0.25, 0.05], spaceAfter: 2 });
    }
    // 挂在这段上的 AI 答疑
    (entry?.qa || []).forEach(q => {
      writer.paragraph(`AI 答疑（${q.model || '模型未记录'}）`, {
        size: 9.5,
        indent: 10,
        color: [0.3, 0.3, 0.55],
        spaceAfter: 1
      });
      writer.paragraph(`问：${q.question}`, { size: 10, indent: 16, color: [0.2, 0.2, 0.35], spaceAfter: 1 });
      writer.paragraph(`答：${q.answer}`, { size: 10, indent: 16, color: [0.15, 0.15, 0.2], spaceAfter: 2 });
    });
    writer.divider();
  });

  // 挂不上段落的高光 / 答疑（段落切分变过、或整页心得）
  const orphans = content?.orphanAnnotations || [];
  if (orphans.length > 0) {
    writer.paragraph('本页其它批注', { size: 10.5, color: [0.35, 0.38, 0.45], spaceAfter: 1 });
    orphans.forEach(a => {
      writer.paragraph(`${a.text || ''}`, { size: 10, indent: 10, color: [0.2, 0.2, 0.2], spaceAfter: 1 });
      if (a.note && a.note.trim()) {
        writer.paragraph(a.note.trim(), { size: 10, indent: 16, color: [0.32, 0.25, 0.05], spaceAfter: 2 });
      }
    });
  }
  (content?.orphanQa || []).forEach(q => {
    writer.paragraph(`AI 答疑（${q.model || '模型未记录'}）`, { size: 9.5, indent: 10, color: [0.3, 0.3, 0.55], spaceAfter: 1 });
    writer.paragraph(`问：${q.question}`, { size: 10, indent: 16, color: [0.2, 0.2, 0.35], spaceAfter: 1 });
    writer.paragraph(`答：${q.answer}`, { size: 10, indent: 16, color: [0.15, 0.15, 0.2], spaceAfter: 2 });
  });

  // 该页未高光、但已经有译文的段落（保留原附录的价值，压缩排版）
  const highlightParaIds = new Set(pageAnnots.map(a => a.paraIndex).filter(v => v !== undefined));
  const others = (content?.entries || []).filter(e => e.translation && !highlightParaIds.has(e.para.id));
  if (others.length > 0) {
    writer.divider();
    writer.paragraph(`本页其余已翻译段落（未高光，${others.length} 段）`, {
      size: 10,
      color: [0.4, 0.42, 0.48],
      spaceAfter: 2
    });
    others.forEach(e => {
      writer.paragraph(e.para.cleanText || '', { size: 9.5, color: [0.35, 0.36, 0.4], spaceAfter: 1, lineGap: 3.4 });
      writer.paragraph(e.translation, { size: 9.5, color: [0.2, 0.35, 0.5], spaceAfter: 3, lineGap: 3.4 });
    });
  }

  return { translated, formulaOnly };
}

/** 末尾的说明页：这次导出了什么、还有哪些高光缺译文、怎么补 */
function writeSummarySheet(
  writer: FlowWriter,
  info: {
    paperName: string;
    sourcePages: number;
    annotationCount: number;
    aiQaCount: number;
    highlightedPages: number[];
    translatedPages: number[];
    pagesWithoutTranslation: number[];
    pagesWithNoSheet: number[];
  }
): void {
  writer.startSheet();
  writer.paragraph(`${info.paperName} · 导出说明`, { size: 15, color: [0.06, 0.09, 0.16], spaceAfter: 3 });
  writer.paragraph(
    '原文页原样保留，你的高亮按原位置画回，并在左页边距用带色圆点标了序号；' +
      '每条高光的编号后面紧跟一页「第 N 页 · 高光译文」，按同一序号给出原文摘录、译文、我的批注与 AI 答疑。',
    { size: 10, color: [0.35, 0.37, 0.42], spaceAfter: 4, lineGap: 3.6 }
  );
  writer.divider();
  writer.paragraph('统计', { size: 11, color: [0.2, 0.22, 0.26], spaceAfter: 2 });
  writer.paragraph(`原文 ${info.sourcePages} 页 · 高光 ${info.annotationCount} 条 · AI 答疑 ${info.aiQaCount} 条`, {
    size: 10,
    color: [0.25, 0.27, 0.3],
    spaceAfter: 1
  });
  writer.paragraph(
    `有高光的页：${formatPageRanges(info.highlightedPages)}；其中已带译文的页：${formatPageRanges(info.translatedPages)}`,
    { size: 10, color: [0.25, 0.27, 0.3], spaceAfter: 3 }
  );

  if (info.pagesWithoutTranslation.length > 0) {
    writer.divider();
    writer.paragraph('这些页的高光还没有译文', { size: 11, color: [0.45, 0.25, 0.15], spaceAfter: 2 });
    writer.paragraph(`第 ${formatPageRanges(info.pagesWithoutTranslation)} 页。`, {
      size: 10,
      color: [0.35, 0.3, 0.3],
      spaceAfter: 2
    });
    writer.paragraph(
      '这些页还没被解析翻译过（插件是按页工作、翻译结果本地缓存的）。' +
        '在阅读器里翻到这些页、或用「整页翻译」，再重新导出即可补齐——批注与已翻译的内容都不会丢。',
      { size: 9.5, color: [0.5, 0.5, 0.55], spaceAfter: 3, lineGap: 3.6 }
    );
  }
  if (info.pagesWithNoSheet.length > 0) {
    writer.paragraph(
      `另外，第 ${formatPageRanges(info.pagesWithNoSheet)} 页既没有高光也没有已翻译内容，因此没有译文页（原文页仍在）。`,
      { size: 9.5, color: [0.5, 0.5, 0.55], spaceAfter: 2, lineGap: 3.6 }
    );
  }
}
