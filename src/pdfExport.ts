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
import { AnnotationItem, ArchivedParagraph, PaperMetadata } from './notesStorage';

export interface PdfExportOptions {
  /** 原始 PDF 的字节 */
  originalBytes: Uint8Array;
  /** 论文数据（批注、段落快照、AI 答疑） */
  paperData: PaperMetadata;
  /** 论文名（写进附录标题） */
  paperName: string;
  /** 设置里的字体路径覆盖（academicReader.pdfExportFontPath） */
  fontPathOverride?: string;
  /** 是否把所有页都放进 PDF（false 时只放有批注的页） */
  includeAllPages?: boolean;
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
  warnings: string[];
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
 * 找一份**可嵌入的中文字体**。
 *
 * 只挑单体 TTF/OTF：.ttc 是字体集合，pdf-lib 的 embedFont 只能按整份文件解析，
 * 无法指定其中某一款，拿它去嵌会直接失败。
 */
export function findCjkFontPath(override?: string): string | undefined {
  const candidates: string[] = [];
  if (override && override.trim()) candidates.push(override.trim());

  const winDir = process.env.WINDIR || 'C:\\Windows';
  candidates.push(
    path.join(winDir, 'Fonts', 'simhei.ttf'), // 黑体，简体覆盖最全
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
    // Linux（Debian/Ubuntu 的 noto-cjk 同时提供 ttc 与 otf，这里只取 otf/ttf）
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc.otf',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/opentype/noto/NotoSerifCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/arphic/ukai.ttf',
    '/usr/share/fonts/truetype/arphic/uming.ttf'
  );

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile() && fs.statSync(p).size > 0) {
        if (/\.(ttf|otf)$/i.test(p)) return p;
      }
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
  private page: PDFPage;
  public y = 0;

  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private width: number,
    private height: number,
    private margin: number
  ) {
    this.page = doc.addPage([width, height]);
    this.y = height - margin;
  }

  get currentPage(): PDFPage {
    return this.page;
  }

  newPage(): void {
    this.page = this.doc.addPage([this.width, this.height]);
    this.y = this.height - this.margin;
  }

  ensure(space: number): void {
    if (this.y - space < this.margin) this.newPage();
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
        this.page.drawText(l, {
          x: this.margin + indent + (opts.bar ? 8 : 0),
          y: this.y,
          size,
          font: this.font,
          color: rgb(...(opts.color ?? [0.13, 0.13, 0.15]))
        });
      }
    });

    if (opts.bar) {
      this.page.drawRectangle({
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
    this.page.drawLine({
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
  colors: string[];
  annotations: AnnotationItem[];
  qa: Array<{ question: string; answer: string; model?: string; at: number; selectedText?: string }>;
}

function buildAppendix(paperData: PaperMetadata) {
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
        p.entries.some(e => e.para.translation || e.annotations.length || e.qa.length) ||
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

  const copied = await out.copyPages(src, indices);
  copied.forEach(p => out.addPage(p));

  // ---- 把高亮画回原页 ----
  let drawnAnnotations = 0;
  const rotatedPagesSkipped: number[] = [];
  annotations.forEach(annot => {
    const idx = indices.indexOf(annot.page - 1);
    if (idx < 0) return;
    const page = out.getPage(idx);
    const rects = Array.isArray(annot.rects) ? annot.rects : [];
    if (rects.length === 0) return;

    // 页面带旋转时，webview 记下的画布坐标与页面坐标系不再一一对应：
    // 宁可如实少画，也不要画到错误的位置上骗人。
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    if (angle !== 0) {
      if (!rotatedPagesSkipped.includes(annot.page)) rotatedPagesSkipped.push(annot.page);
      return;
    }

    const [r, g, b] = HIGHLIGHT_RGB[annot.color] || HIGHLIGHT_RGB.yellow;
    const pageHeight = page.getHeight();
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
  });

  // ---- 附录：对照译文与笔记 ----
  const fontPath = findCjkFontPath(opts.fontPathOverride);
  let font: PDFFont | undefined;
  if (fontPath) {
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
  } else {
    warnings.push(
      '没有找到可嵌入的中文字体，已只导出原文页（高亮已画回原位）。可在设置 academicReader.pdfExportFontPath 指定一个中文 ttf/otf 字体。'
    );
  }

  const { pages: appendixSource } = buildAppendix(paperData);
  let appendixPages = 0;

  if (font) {
    const PAGE_W = 595.28;
    const PAGE_H = 841.89;
    const MARGIN = 52;
    const writer = new FlowWriter(out, font, PAGE_W, PAGE_H, MARGIN);
    const firstAppendixPageIndex = out.getPageCount() - 1;

    writer.paragraph(`${paperName} · 对照译文与笔记`, {
      size: 17,
      color: [0.08, 0.1, 0.14],
      spaceAfter: 2
    });
    const stat = `批注 ${annotations.length} 条 · AI 答疑 ${paperData.aiQa?.length || 0} 条 · 生成于 ${new Date().toLocaleString()}`;
    writer.paragraph(stat, { size: 9, color: [0.45, 0.47, 0.5], spaceAfter: 2 });
    writer.paragraph(
      '前一部分是未经改动的原文页（你的高亮已按原位置画回）；这里按页给出该页各段的原文与译文，' +
        '高亮过的段落左侧有同色标记条，其下是你的批注与 AI 答疑。',
      { size: 9, color: [0.45, 0.47, 0.5], spaceAfter: 6, lineGap: 3.6 }
    );
    writer.divider();

    if (appendixSource.length === 0) {
      writer.paragraph('这一篇暂时没有可排版的译文：请先在阅读器里翻几页让插件解析并翻译，再回来导出。', {
        size: 10.5,
        color: [0.5, 0.2, 0.2]
      });
    }

    appendixSource.forEach(pg => {
      writer.paragraph(`第 ${pg.page} 页`, { size: 14, color: [0.06, 0.09, 0.16], spaceAfter: 2 });
      let ordinal = 0;
      pg.entries.forEach(entry => {
        const para = entry.para;
        const hasContent = para.translation || entry.annotations.length || entry.qa.length;
        if (!hasContent) return;
        ordinal++;
        const typeLabel =
          para.type === 'heading' || para.type === 'title'
            ? '标题'
            : para.type === 'caption'
            ? '题注'
            : para.type === 'abstract'
            ? '摘要'
            : `¶${ordinal}`;
        const barColor = entry.colors.length ? HIGHLIGHT_RGB[entry.colors[0]] : undefined;

        writer.paragraph(`${typeLabel}${entry.colors.length ? ' · ' + entry.colors.map(c => COLOR_NAME[c] || c).join('、') : ''}`, {
          size: 9.5,
          color: [0.35, 0.38, 0.45],
          spaceAfter: 1
        });
        writer.paragraph(para.cleanText || '', {
          size: 10.5,
          color: [0.15, 0.17, 0.2],
          bar: barColor,
          spaceAfter: 2
        });
        if (para.translation) {
          writer.paragraph(para.translation, {
            size: 10.5,
            color: [0.07, 0.28, 0.5],
            bar: barColor,
            spaceAfter: 3
          });
        } else {
          writer.paragraph('（本段尚未翻译）', { size: 9.5, color: [0.6, 0.6, 0.65], spaceAfter: 3 });
        }
        entry.annotations.forEach(a => {
          if (a.note && a.note.trim()) {
            writer.paragraph(`📌 我的批注：${a.note.trim()}`, {
              size: 10,
              indent: 14,
              color: [0.32, 0.25, 0.05],
              spaceAfter: 2
            });
          }
        });
        entry.qa.forEach(q => {
          writer.paragraph(`🤖 AI 答疑（${q.model || '模型未记录'}）`, {
            size: 9.5,
            indent: 14,
            color: [0.3, 0.3, 0.55],
            spaceAfter: 1
          });
          writer.paragraph(`问：${q.question}`, { size: 10, indent: 14, color: [0.2, 0.2, 0.35], spaceAfter: 1 });
          writer.paragraph(`答：${q.answer}`, { size: 10, indent: 14, color: [0.15, 0.15, 0.2], spaceAfter: 3 });
        });
        writer.divider();
      });

      if (pg.orphanAnnotations.length || pg.orphanQa.length) {
        writer.paragraph('本页其它记录', { size: 10.5, color: [0.35, 0.38, 0.45], spaceAfter: 1 });
        pg.orphanAnnotations.forEach(a => {
          const colorName = COLOR_NAME[a.color] || a.color;
          writer.paragraph(`📌 ${colorName}：${a.text}`, { size: 10, indent: 10, color: [0.2, 0.2, 0.2], spaceAfter: 1 });
          if (a.note && a.note.trim()) {
            writer.paragraph(a.note.trim(), { size: 10, indent: 18, color: [0.32, 0.25, 0.05], spaceAfter: 3 });
          }
        });
        pg.orphanQa.forEach(q => {
          writer.paragraph(`🤖 问：${q.question}`, { size: 10, indent: 10, color: [0.2, 0.2, 0.35], spaceAfter: 1 });
          writer.paragraph(`答：${q.answer}`, { size: 10, indent: 18, color: [0.15, 0.15, 0.2], spaceAfter: 3 });
        });
        writer.divider();
      }
    });

    appendixPages = out.getPageCount() - firstAppendixPageIndex;
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
    appendixPages,
    drawnAnnotations,
    rotatedPagesSkipped,
    fontPath: font ? fontPath || '' : '',
    warnings
  };
}
