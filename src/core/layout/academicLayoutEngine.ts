/**
 * XY-Cut Zone + Column + Bilingual Academic Layout & 2D Math Solver
 * (`src/core/layout/academicLayoutEngine.ts`)
 *
 * Guarantees:
 * - Strict 1:1 `cleanText.length === charMap.length` invariant by construction (`TextBufferBuilder`).
 * - Zero span wipeouts from figure/diagram vector lines (`classifyPageVectors`).
 * - True 2D spatial math reconstruction (`\frac`, `\sqrt`, `\sum`, scripts, `aligned`/`cases`)
 *   + smart neighbor-masked `formulaCropRect` + `⟦M1⟧` inline math token registry.
 * - Full English + Chinese (CJK) academic paper support + safe handling of 0-text/image pages.
 */

import {
  AcademicParagraph,
  CharMapEntry,
  ClassifiedPageVectors,
  DecodedGlyphItem,
  ParagraphSegment,
  ParagraphType,
  PdfTextItemLike,
  RawPageGraphics,
  SentenceSpan,
  VectorHLine,
} from '../types';
import { decodePageGlyphs } from '../glyphs/fontDecoder';
import { classifyPageVectors } from './vectorGraphics';
import {
  buildInlineMathRegistry,
  computeFormulaCropBox,
  evaluateDisplayFormulaLine,
  isEquationTagText,
  MATH_OPERATOR_WORDS,
  reconstructMath2D,
} from '../math/mathEngine2D';

/**
 * Atomic 1:1 builder for `cleanText` and `charMap`.
 * Every character push, pop, or trim mutates BOTH arrays in lockstep so desynchronization is impossible.
 */
export class TextBufferBuilder<TSpan = unknown> {
  private chars: string[] = [];
  private map: Array<CharMapEntry<TSpan>> = [];

  get length(): number {
    return this.chars.length;
  }

  lastChar(): string {
    return this.chars.length > 0 ? this.chars[this.chars.length - 1] : '';
  }

  secondLastChar(): string {
    return this.chars.length > 1 ? this.chars[this.chars.length - 2] : '';
  }

  appendSpace(): void {
    if (this.chars.length === 0 || /\s/.test(this.lastChar())) return;
    this.chars.push(' ');
    this.map.push({ span: null, offset: 0 });
  }

  appendText(text: string, span: TSpan | null, startOffset = 0): void {
    for (let i = 0; i < text.length; i++) {
      this.chars.push(text[i]);
      this.map.push(span ? { span, offset: startOffset + i } : { span: null, offset: 0 });
    }
  }

  /** Atomically pop soft line-wrap hyphen (and any synthetic space right before it) */
  stripTrailingWrapHyphen(): boolean {
    if (this.chars.length < 2) return false;
    const last = this.lastChar();
    if (last !== '-' && last !== '‐') return false;
    // Only strip hyphen if preceded by an ASCII letter (e.g. `optimiza-` + `tion`)
    const prev = this.secondLastChar();
    if (!/[A-Za-z]/.test(prev)) return false;
    this.chars.pop();
    this.map.pop();
    return true;
  }

  trim(): void {
    while (this.chars.length > 0 && /\s/.test(this.chars[this.chars.length - 1])) {
      this.chars.pop();
      this.map.pop();
    }
    let lead = 0;
    while (lead < this.chars.length && /\s/.test(this.chars[lead])) {
      lead++;
    }
    if (lead > 0) {
      this.chars.splice(0, lead);
      this.map.splice(0, lead);
    }
  }

  build(): { cleanText: string; charMap: Array<CharMapEntry<TSpan>> } {
    this.trim();
    return {
      cleanText: this.chars.join(''),
      charMap: this.map.slice(),
    };
  }
}

/** Bilingual (English + CJK) academic sentence splitter with exact `startIdx` / `endIdx` */
export function splitSentencesBilingual(text: string): SentenceSpan[] {
  if (!text) return [];

  // Check if paragraph is predominantly CJK (Chinese/Japanese)
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjkCount >= 6 && cjkCount >= text.length * 0.15) {
    const out: SentenceSpan[] = [];
    const re = /[^。！？；\n]+[。！？；]?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const lead = raw.length - raw.trimStart().length;
      const startIdx = m.index + lead;
      out.push({
        text: trimmed,
        startIdx,
        endIdx: startIdx + trimmed.length,
      });
    }
    return out.length > 0 ? out : [{ text: text.trim(), startIdx: 0, endIdx: text.length }];
  }

  const out: SentenceSpan[] = [];
  const endRegex =
    /([.?!]["'”’)\]]?(?:\s*\((?:[1-9]\d{0,2}|[A-Z]?\d+(?:\.\d+)*)\))?|[,;]\s*\((?:[1-9]\d{0,2}|[A-Z]?\d+(?:\.\d+)*)\))(\s+|$)/g;
  const ABBREV_RE = new RegExp(
    '(?:\\b(?:et\\s+al|e\\.g|i\\.e|i\\.i\\.d|w\\.r\\.t|a\\.k\\.a|s\\.t|w\\.l\\.o\\.g|cf|vs|etc|fig|figs|tab|eq|eqs|ref|refs|no|vol|pp|sec|secs|ch|chap|' +
      'dr|mr|mrs|ms|prof|approx|ca|min|max|avg|std|ed|eds|al|inc|ltd|univ|dept|resp|suppl)\\.' +
      '|(?:^|[\\s(])(?:[A-Za-z]\\.){2,})$',
    'i'
  );
  const LIST_MARKER_RE =
    /^(?:[(\[]?\s*(?:\d{1,2}|[IVXLC]{1,6}|[a-z])\s*[)\].:：]|(?:\d{1,2}|[IVXLC]{1,6})\.\d+[.)])$/;

  let searchFrom = 0;
  let match: RegExpExecArray | null;
  while ((match = endRegex.exec(text)) !== null) {
    let endPos = match.index + match[1].length;
    let body = text.slice(searchFrom, endPos).trim();
    if (!body) {
      searchFrom = match.index + match[0].length;
      continue;
    }
    // 1. A sentence must contain at least one word character (letter, digit, or CJK)
    if (!/[a-zA-Z0-9\u4e00-\u9fff]/.test(body)) continue;

    // 2. Ellipsis protection: dots preceded or followed by another dot are part of an ellipsis, not sentence ends
    const isDot = match[1].startsWith('.');
    if (isDot) {
      // Preceded by dot (e.g. ".." or ". .")
      if (/(?:\.\s*|\.)$/.test(text.slice(0, match.index))) continue;
      // Followed by dot (e.g. "..", " .", " . .")
      if (/^\s*\./.test(text.slice(endPos))) continue;
    }

    const nextRaw = text.slice(endPos).replace(/^\s+/, '');
    if (/(?:^|:\s*)\d{1,2}\.$/.test(body) && /^[A-Z]/.test(nextRaw)) continue;
    if (/^[,;]/.test(match[1]) && /^[a-z]/.test(nextRaw)) continue;

    // 3. A sentence boundary cannot be directly followed by punctuation or lowercase letters
    if (nextRaw.length > 0) {
      if (/^[,;:)]/.test(nextRaw)) continue;
      if (isDot && /^[a-z]/.test(nextRaw)) continue;
    }

    const trailingEqMatch = body.match(/([.?!]["'”’)\]]?)\s*(\((?:[1-9]\d{0,2}|[A-Z]?\d+(?:\.\d+)*)\))$/);
    if (trailingEqMatch) {
      const mainSentence = body.slice(0, body.length - trailingEqMatch[0].length) + trailingEqMatch[1];
      if (ABBREV_RE.test(mainSentence.trim())) continue;
      const hasMathSymbol = /[-=+\\/_′'⊤√*^<>≈≤≥~·⟦]|Attention|softmax|MultiHead/i.test(mainSentence);
      const nextIsCapitalWord = /^[A-Z][a-z]/.test(nextRaw);
      if (!hasMathSymbol && nextIsCapitalWord) {
        endPos = match.index + trailingEqMatch[1].length;
        body = text.slice(searchFrom, endPos).trim();
      }
    } else if (ABBREV_RE.test(body)) {
      continue;
    }

    if (LIST_MARKER_RE.test(body)) continue;

    const raw = text.slice(searchFrom, endPos);
    const lead = raw.length - raw.trimStart().length;
    out.push({ text: body, startIdx: searchFrom + lead, endIdx: endPos });
    searchFrom = endPos;
    while (searchFrom < text.length && /\s/.test(text[searchFrom])) searchFrom++;
  }

  const tailRaw = text.slice(searchFrom);
  const tail = tailRaw.trim();
  if (tail) {
    const lead = tailRaw.length - tailRaw.trimStart().length;
    out.push({
      text: tail,
      startIdx: searchFrom + lead,
      endIdx: searchFrom + lead + tail.length,
    });
  }
  return out;
}

interface VisualLine<TSpan> {
  y: number;
  top: number;
  bottom: number;
  minX: number;
  maxX: number;
  h: number;
  section: string;
  colLeft: number;
  colRight: number;
  glyphs: DecodedGlyphItem[];
  spans: Array<TSpan | null>;
  bars: VectorHLine[];
  text: string;
  isDisplayMath: boolean;
  hasEquationTag: boolean;
  isFootnote: boolean;
  isAlgorithm: boolean;
}

export interface SolveAcademicPageOptions<TSpan = unknown> {
  pageNum: number;
  items: PdfTextItemLike[];
  spans?: Array<TSpan | null>;
  pageW: number;
  pageH: number;
  fontNames?: Record<string, string> | null;
  rawGraphics?: RawPageGraphics | null;
  splitBlockFormula?: boolean;
}

export interface SolvedAcademicPage<TSpan = unknown> {
  paras: Array<AcademicParagraph<TSpan>>;
  glyphs: DecodedGlyphItem[];
  vectors: ClassifiedPageVectors;
  bodyFontSize: number;
  twoColumn: boolean;
  gutterX: number;
  pageW: number;
  pageH: number;
}

/**
 * Detect whether a page uses a two-column academic grid (even if top/bottom has full-width title/abstract/figures).
 */
function detectPageColumns(
  glyphs: DecodedGlyphItem[],
  pageW: number,
  bodyFontSize: number
): {
  twoColumn: boolean;
  gutterX: number;
  leftMargin: number;
  rightMargin: number;
  leftColRight: number;
  rightColLeft: number;
} {
  const valid = glyphs.filter((g) => !g.isDelimiterExt && g.text.trim().length > 0);
  if (valid.length === 0) {
    return {
      twoColumn: false,
      gutterX: pageW * 0.5,
      leftMargin: pageW * 0.12,
      rightMargin: pageW * 0.88,
      leftColRight: pageW * 0.48,
      rightColLeft: pageW * 0.52,
    };
  }

  const xs = valid.map((g) => g.x).sort((a, b) => a - b);
  const rs = valid.map((g) => g.right).sort((a, b) => a - b);
  const leftMargin = xs[Math.floor(xs.length * 0.04)] ?? pageW * 0.1;
  const rightMargin = rs[Math.min(rs.length - 1, Math.floor(rs.length * 0.96))] ?? pageW * 0.9;

  // Group into visual y-rows and split across horizontal gaps >= 9pt
  const segGap = Math.max(8, bodyFontSize * 0.95);
  const rows: Array<{ y: number; segs: Array<{ minX: number; maxX: number; chars: number }> }> = [];
  for (const g of valid) {
    let row = rows.find((r) => Math.abs(r.y - g.y) <= Math.max(2.8, bodyFontSize * 0.32));
    if (!row) {
      row = { y: g.y, segs: [] };
      rows.push(row);
    }
    row.segs.push({ minX: g.x, maxX: g.right, chars: g.text.trim().length });
  }

  let dualColRows = 0;
  let leftOnlyLines = 0;
  let rightOnlyLines = 0;
  const leftEnds: number[] = [];
  const rightStarts: number[] = [];
  const midLo = pageW * 0.38;
  const midHi = pageW * 0.62;

  for (const r of rows) {
    r.segs.sort((a, b) => a.minX - b.minX);
    const merged: Array<{ minX: number; maxX: number; chars: number }> = [];
    for (const s of r.segs) {
      const prev = merged[merged.length - 1];
      if (prev && s.minX - prev.maxX <= segGap) {
        prev.maxX = Math.max(prev.maxX, s.maxX);
        prev.chars += s.chars;
      } else {
        merged.push({ ...s });
      }
    }
    if (merged.length === 2) {
      const [a, b] = merged;
      const gapMid = (a.maxX + b.minX) / 2;
      if (
        a.chars >= 8 &&
        b.chars >= 8 &&
        b.minX - a.maxX >= Math.max(8, bodyFontSize * 0.85) &&
        gapMid >= midLo &&
        gapMid <= midHi &&
        a.minX < pageW * 0.28 &&
        b.maxX > pageW * 0.65
      ) {
        dualColRows++;
        leftEnds.push(a.maxX);
        rightStarts.push(b.minX);
      }
    } else if (merged.length === 1) {
      const [s] = merged;
      if (s.chars >= 15) {
        if (s.maxX < midHi && s.minX < pageW * 0.3) {
          leftOnlyLines++;
          leftEnds.push(s.maxX);
        } else if (s.minX > midLo && s.maxX > pageW * 0.7) {
          rightOnlyLines++;
          rightStarts.push(s.minX);
        }
      }
    }
  }

  const isTwoCol =
    dualColRows >= 3 ||
    (leftOnlyLines >= 4 && rightOnlyLines >= 4) ||
    (dualColRows >= 2 && (leftOnlyLines >= 2 || rightOnlyLines >= 2));

  if (isTwoCol && leftEnds.length > 0 && rightStarts.length > 0) {
    leftEnds.sort((a, b) => a - b);
    rightStarts.sort((a, b) => a - b);
    const leftColRight = leftEnds[Math.floor(leftEnds.length * 0.75)];
    const rightColLeft = rightStarts[Math.floor(rightStarts.length * 0.25)];
    const gutterX = (leftColRight + rightColLeft) / 2;
    if (rightColLeft - leftColRight >= 6) {
      return {
        twoColumn: true,
        gutterX,
        leftMargin,
        rightMargin,
        leftColRight,
        rightColLeft,
      };
    }
  }

  return {
    twoColumn: false,
    gutterX: pageW * 0.5,
    leftMargin,
    rightMargin,
    leftColRight: rightMargin,
    rightColLeft: leftMargin,
  };
}

function classifyHeadingOrSpecialType(
  lineText: string,
  lineFontSize: number,
  isBold: boolean,
  bodyFontSize: number,
  pageNum: number,
  yRatioFromTop: number
): ParagraphType | null {
  const t = lineText.trim();
  if (!t) return null;

  // Title on Page 1 top 35% with noticeably larger font
  if (pageNum === 1 && yRatioFromTop <= 0.36 && lineFontSize >= bodyFontSize * 1.32 && t.length >= 8 && t.length <= 240) {
    if (!/^(?:arXiv:|Proceedings|IEEE|ACM|CVPR|ICCV|ECCV|NeurIPS|ICML|ICLR)/i.test(t)) {
      return 'title';
    }
  }

  // Abstract / Keywords (English & Chinese)
  if (/^(?:Abstract|ABSTRACT|摘\s*要)\b[:：.—–\-]?/i.test(t)) {
    return t.length <= 16 ? 'heading' : 'abstract';
  }
  if (/^(?:Keywords?|Index\s+Terms|关\s*键\s*词)\b[:：.—–\-]?/i.test(t)) {
    return 'keywords';
  }

  // Captions (`Figure 1:`, `Fig. 2.`, `Table 1:`, `图 1`, `表 2`)
  if (/^(?:Fig(?:ure)?s?\.?\s*\d+|Tab(?:le)?s?\.?\s*[IVX\d]+|图\s*\d+|表\s*\d+)\b[\s.:：—–\-]/i.test(t)) {
    return 'caption';
  }

  // Section headings (English `1. Introduction`, `II. RELATED WORK`, `3.2 Method` & Chinese `1 引言`, `一、引言`)
  // Title word MUST have at least 3 letters (e.g. `1. Introduction`, not `1 X` or `1 N` math fragments!)
  if (
    t.length <= 115 &&
    !/[.!?。！？]\s*$/.test(t.replace(/^\d+(?:\.\d+)*\./, '').trim()) &&
    !/[∑∏∫√=+\-−/|]/.test(t) &&
    (/^(?:[IVX]{1,5}\.|[1-9]\d?(?:\.\d+){0,3}\.?)\s+([A-Z][A-Za-z]{2,}|[\u4e00-\u9fff])/.test(t) ||
      /^[一二三四五六七八九十]+[、.]\s*[\u4e00-\u9fff]/.test(t) ||
      (/^(?:Introduction|Related\s+Work|Background|Preliminaries|Method(?:ology|s)?|Approach|Experiments?|Evaluation|Results?|Discussion|Conclusion(?:s)?|References|Acknowledg(?:e)?ments?|Appendix|参考文献|致\s*谢|结\s*论|引\s*言)$/i.test(
        t
      ) &&
        (isBold || lineFontSize >= bodyFontSize * 1.05)))
  ) {
    return 'heading';
  }

  return null;
}

/**
 * Main entry point: Solve complete academic page layout, 2D formulas, crops, and `⟦M1⟧` inline tokens.
 * Safe on empty / scanned / pure-image pages (`items.length === 0` -> returns `{ paras: [], ... }`).
 */
export function solveAcademicPageLayout<TSpan = unknown>(
  opts: SolveAcademicPageOptions<TSpan>
): SolvedAcademicPage<TSpan> {
  const {
    pageNum,
    items,
    spans = [],
    pageW = 612,
    pageH = 792,
    fontNames = null,
    rawGraphics = null,
    splitBlockFormula = true,
  } = opts;

  const resolveFont = (k: string) => (fontNames && fontNames[k]) || k || '';
  const { glyphs, bodyFontSize } = decodePageGlyphs(items || [], resolveFont, 10);
  const vectors = classifyPageVectors(rawGraphics, glyphs, pageW, pageH, bodyFontSize);

  if (glyphs.length === 0) {
    return {
      paras: [],
      glyphs: [],
      vectors,
      bodyFontSize,
      twoColumn: false,
      gutterX: pageW * 0.5,
      pageW,
      pageH,
    };
  }

  // 1. Filter running headers, footers, page numbers, rotated margin watermarks, and verified ruled tables
  const activeGlyphs = glyphs.filter((g) => {
    if (g.isDelimiterExt) return false;
    const t = g.text.trim();
    if (!t && !g.isRadicalSign) return false;

    // Header / footer vertical margins scaled to bodyFontSize
    if (g.y < bodyFontSize * 4.4 || g.y > pageH - bodyFontSize * 4.0) return false;
    if (g.y < bodyFontSize * 6.2) {
      if (/^\d+(\s+of\s+\d+)?$/i.test(t) || /^[-—–]\s*\d+\s*[-—–]$/.test(t)) {
        // Genuine page number is an isolated digit block near horizontal center or outer margins,
        // and NOT immediately adjacent to other text/math glyphs on the same baseline!
        const hasAdjacentNonPageGlyph = glyphs.some(
          (other) =>
            other !== g &&
            Math.abs(other.y - g.y) <= bodyFontSize * 0.45 &&
            Math.abs(other.x - g.x) <= bodyFontSize * 2.5 &&
            !/^\d+$/.test(other.text.trim())
        );
        if (!hasAdjacentNonPageGlyph) return false;
      }
      if (/^(?:Authorized licensed use|Downloaded on|Copyright|All rights reserved|©|978-\d)/i.test(t)) return false;
    }
    if (g.y > pageH - bodyFontSize * 5.6) {
      if (/^\d+$/.test(t) && g.fontSize < 12) return false;
      if (/www\.pnas\.org|^\d+\s*\|\s*www\./i.test(t)) return false;
    }
    if (g.isRotated) {
      if (g.x < 48 || g.x > pageW - 48 || /arxiv|doi|copyright|licensed|ieee/i.test(t)) return false;
    }

    // Verified ruled table exclusion (NEVER deletes prose or display formulas!)
    if (vectors.tableRegions.length > 0) {
      const cx = g.x + g.w / 2;
      const inTable = vectors.tableRegions.some(
        (tr) => cx >= tr.x1 - 4 && cx <= tr.x2 + 4 && g.y >= tr.minY - 4 && g.y <= tr.maxY + 4
      );
      if (inTable) return false;
    }
    return true;
  });

  if (activeGlyphs.length === 0) {
    return {
      paras: [],
      glyphs,
      vectors,
      bodyFontSize,
      twoColumn: false,
      gutterX: pageW * 0.5,
      pageW,
      pageH,
    };
  }

  // 2. Column grid detection
  const colGrid = detectPageColumns(activeGlyphs, pageW, bodyFontSize);

  // 3. XY-Cut Horizontal Band + Column Partitioning into Visual Lines
  // First cluster glyphs that share a visual baseline AND do not cross the column gutter!
  const yTol = Math.max(3.6, bodyFontSize * 0.38);
  const rawRows: Array<{ y: number; glyphs: DecodedGlyphItem[] }> = [];
  const sortedGlyphs = activeGlyphs.slice().sort((a, b) => {
    const aMain = a.fontSize >= bodyFontSize * 0.85 ? 1 : 0;
    const bMain = b.fontSize >= bodyFontSize * 0.85 ? 1 : 0;
    if (aMain !== bMain) return bMain - aMain;
    return b.y - a.y || a.x - b.x;
  });
  for (const g of sortedGlyphs) {
    let row = rawRows.find((r) => {
      // In a two-column grid, prevent left-column glyphs from clustering into right-column-only rows,
      // and right-column glyphs from clustering into left-column-only rows!
      if (colGrid.twoColumn) {
        const gLeft = g.right < colGrid.gutterX - 4;
        const gRight = g.x > colGrid.gutterX + 4;
        const rMinX = Math.min(...r.glyphs.map((gl) => gl.x));
        const rMaxX = Math.max(...r.glyphs.map((gl) => gl.right));
        const rOnlyLeft = rMaxX < colGrid.gutterX - 4;
        const rOnlyRight = rMinX > colGrid.gutterX + 4;
        if (gLeft && rOnlyRight) return false;
        if (gRight && rOnlyLeft) return false;
      }

      const baseDiff = Math.abs(r.y - g.y);
      if (baseDiff <= yTol) return true;
      // If g is a subscript, superscript, or fraction numerator/denominator embedded in r's X span:
      if (g.fontSize <= bodyFontSize * 0.85 && baseDiff <= bodyFontSize * 0.58) {
        const rMinX = Math.min(...r.glyphs.map((gl) => gl.x));
        const rMaxX = Math.max(...r.glyphs.map((gl) => gl.right));
        if (g.x >= rMinX - 8 && g.right <= rMaxX + 8) return true;
      }
      return false;
    });
    if (!row) {
      row = { y: g.y, glyphs: [] };
      rawRows.push(row);
    }
    row.glyphs.push(g);
  }
  rawRows.sort((a, b) => b.y - a.y);

  // Split each row into full-width vs left-col vs right-col segments
  type BandItem = {
    bandKind: 'full' | 'cols';
    col: 'full' | 'left' | 'right';
    y: number;
    glyphs: DecodedGlyphItem[];
  };
  const bandItems: BandItem[] = [];

  for (const r of rawRows) {
    r.glyphs.sort((a, b) => a.x - b.x);
    if (!colGrid.twoColumn) {
      bandItems.push({ bandKind: 'full', col: 'full', y: r.y, glyphs: r.glyphs });
      continue;
    }

    // Check if any glyph or tight word bridges across `gutterX` -> genuinely full-width line!
    const minX = r.glyphs[0].x;
    const maxR = r.glyphs[r.glyphs.length - 1].right;
    let crossesGutterTight = false;
    for (let i = 0; i < r.glyphs.length; i++) {
      const g = r.glyphs[i];
      if (g.x < colGrid.gutterX - 2 && g.right > colGrid.gutterX + 2) {
        crossesGutterTight = true;
        break;
      }
      if (i > 0) {
        const prev = r.glyphs[i - 1];
        if (
          prev.right <= colGrid.gutterX + 4 &&
          g.x >= colGrid.gutterX - 4 &&
          g.x - prev.right < Math.max(8, bodyFontSize * 0.85)
        ) {
          crossesGutterTight = true;
          break;
        }
      }
    }

    const spansBothSides = minX < colGrid.gutterX - 35 && maxR > colGrid.gutterX + 35;
    if (crossesGutterTight && spansBothSides) {
      bandItems.push({ bandKind: 'full', col: 'full', y: r.y, glyphs: r.glyphs });
    } else {
      const leftG = r.glyphs.filter((g) => g.x + g.w * 0.5 <= colGrid.gutterX + 2);
      const rightG = r.glyphs.filter((g) => g.x + g.w * 0.5 > colGrid.gutterX + 2);
      if (leftG.length > 0) bandItems.push({ bandKind: 'cols', col: 'left', y: r.y, glyphs: leftG });
      if (rightG.length > 0) bandItems.push({ bandKind: 'cols', col: 'right', y: r.y, glyphs: rightG });
    }
  }

  // Order bands in true reading order: full-width band -> (all left-col lines, then all right-col lines) -> next full-width band
  const orderedLineGroups: Array<{ section: string; colLeft: number; colRight: number; glyphs: DecodedGlyphItem[] }> = [];
  let zoneIdx = 0;
  let idx = 0;
  while (idx < bandItems.length) {
    if (bandItems[idx].bandKind === 'full') {
      const fullSection = `zone_${zoneIdx}_full`;
      while (idx < bandItems.length && bandItems[idx].bandKind === 'full') {
        orderedLineGroups.push({
          section: fullSection,
          colLeft: colGrid.leftMargin,
          colRight: colGrid.rightMargin,
          glyphs: bandItems[idx].glyphs,
        });
        idx++;
      }
      zoneIdx++;
    } else {
      const leftLines: BandItem[] = [];
      const rightLines: BandItem[] = [];
      while (idx < bandItems.length && bandItems[idx].bandKind === 'cols') {
        if (bandItems[idx].col === 'left') leftLines.push(bandItems[idx]);
        else rightLines.push(bandItems[idx]);
        idx++;
      }
      leftLines.sort((a, b) => b.y - a.y);
      rightLines.sort((a, b) => b.y - a.y);
      const pushLineGroup = (section: string, colLeft: number, colRight: number, glyphs: DecodedGlyphItem[]) => {
        const sorted = glyphs.slice().sort((a, b) => a.x - b.x);
        if (sorted.length >= 2) {
          const first = sorted[0];
          const firstTxt = first.text.trim();
          if (
            first.x <= colLeft + 8 &&
            /^(?:where|with|for|and)\b/i.test(firstTxt) &&
            !first.isMathFont &&
            first.fontRole === 'body-serif'
          ) {
            const next = sorted[1];
            if (next.x - first.right >= bodyFontSize * 2.0 && next.x >= colLeft + bodyFontSize * 3.0) {
              orderedLineGroups.push({ section, colLeft, colRight, glyphs: [first] });
              orderedLineGroups.push({ section, colLeft, colRight, glyphs: sorted.slice(1) });
              return;
            }
          }
        }
        orderedLineGroups.push({ section, colLeft, colRight, glyphs });
      };

      for (const l of leftLines) {
        pushLineGroup(`zone_${zoneIdx}_left`, colGrid.leftMargin, colGrid.leftColRight, l.glyphs);
      }
      for (const r of rightLines) {
        pushLineGroup(`zone_${zoneIdx}_right`, colGrid.rightColLeft, colGrid.rightMargin, r.glyphs);
      }
      zoneIdx++;
    }
  }

  // 4. Build VisualLine objects & merge vertically stacked 2D math rows (fractions, limits, subscripts/superscripts)
  const rawVisualLines: VisualLine<TSpan>[] = orderedLineGroups.map((grp) => {
    const gs = grp.glyphs.slice().sort((a, b) => a.x - b.x);
    const minX = Math.min(...gs.map((g) => g.x));
    const maxX = Math.max(...gs.map((g) => g.right));
    const top = Math.max(...gs.map((g) => g.top));
    const bottom = Math.min(...gs.map((g) => g.bottom));
    const y = gs.reduce((s, g) => s + g.y, 0) / gs.length;
    const h = Math.max(...gs.map((g) => g.fontSize));
    const lineBars = vectors.mathBars.filter(
      (b) => b.x2 >= minX - 4 && b.x1 <= maxX + 4 && b.y >= bottom - bodyFontSize * 0.8 && b.y <= top + bodyFontSize * 0.8
    );

    const isFootnote = vectors.footnoteRules.some(
      (fr) => y < fr.y + 1 && minX >= fr.x1 - 15 && minX <= fr.x2 + 60 && h <= bodyFontSize * 0.96
    );
    const isAlgorithm = vectors.algoBoxes.some(
      (ab) => minX >= ab.x1 - 6 && maxX <= ab.x2 + 6 && y >= ab.minY - 4 && y <= ab.maxY + 4
    );

    const eqEval =
      splitBlockFormula && !isFootnote && !isAlgorithm
        ? evaluateDisplayFormulaLine(gs, lineBars, grp.colLeft, grp.colRight, bodyFontSize)
        : { isDisplayMath: false, hasEquationTag: false, score: 0 };

    return {
      y,
      top,
      bottom,
      minX,
      maxX,
      h,
      section: isFootnote ? `${grp.section}_footnote` : isAlgorithm ? `${grp.section}_algo` : grp.section,
      colLeft: grp.colLeft,
      colRight: grp.colRight,
      glyphs: gs,
      spans: gs.map((g) => (spans[g.index] !== undefined ? spans[g.index] : null)),
      bars: lineBars,
      text: gs.map((g) => g.text).join(' ').replace(/\s+/g, ' ').trim(),
      isDisplayMath: eqEval.isDisplayMath,
      hasEquationTag: eqEval.hasEquationTag,
      isFootnote,
      isAlgorithm,
    };
  });

  const isProseLine = (l: VisualLine<TSpan>) =>
    !l.isDisplayMath &&
    (l.text.includes(' ') &&
      (/[a-zA-Z]{3,}\s+[a-zA-Z]{3,}/.test(l.text) ||
        /^(?:where|with|for|and|as|based|the|in|at)\b/i.test(l.text) ||
        /[:.]$/.test(l.text.trim())));

  const COMMON_MATH_ABBREVIATIONS = new Set([
    'aug', 'nn', 'cls', 'reg', 'box', 'rot', 'ang', 'loss', 'det', 'pos', 'neg', 'feat', 'pred',
    'tgt', 'src', 'att', 'dim', 'avg', 'cov', 'std', 'min', 'max', 'init', 'out', 'in', 'opt',
    'res', 'loc', 'val', 'ref', 'pts', 'obj', 'enc', 'dec', 'emb', 'raw', 'gwd', 'iou', 'giou',
    'diou', 'ciou', 'bg', 'fg', 'gt', 'ss', 'sim', 'cos', 'sin', 'tan', 'exp', 'log',
    'norm', 'diff', 'dist', 'top', 'bot', 'left', 'right', 'mid', 'trans', 'proj', 'idx', 'step',
    'positive', 'negative', 'true', 'false', 'otherwise', 'const', 'constant'
  ]);

  const isPureMathLine = (l: VisualLine<TSpan>) =>
    l.glyphs.length > 0 &&
    l.glyphs.every(
      (g) =>
        g.isMathToken ||
        g.isMathFont ||
        g.fontSize <= bodyFontSize * 0.88 ||
        /^[0-9+\-−=/().,θ\[\]{}|\\_′'~^$]+$/.test(g.text.trim()) ||
        MATH_OPERATOR_WORDS.has(g.text.trim()) ||
        MATH_OPERATOR_WORDS.has(g.text.trim().toLowerCase()) ||
        COMMON_MATH_ABBREVIATIONS.has(g.text.trim().toLowerCase())
    );

  // Coalesce vertically split 2D math fragments (e.g. numerator row + fraction bar + denominator row, or `\sum` limits)
  const visualLines: VisualLine<TSpan>[] = [];
  for (const ln of rawVisualLines) {
    const prev = visualLines[visualLines.length - 1];
    if (prev && prev.section === ln.section && !ln.isFootnote && !ln.isAlgorithm) {
      const dy = prev.y - ln.y;
      const prevIsProse = isProseLine(prev);
      const lnIsProse = isProseLine(ln);

      // Fraction bar strictly between numerator row and denominator row
      const sharesFractionBar =
        dy > 0 &&
        !prevIsProse &&
        !lnIsProse &&
        (prev.isDisplayMath || ln.isDisplayMath || (isPureMathLine(prev) && isPureMathLine(ln))) &&
        vectors.mathBars.some(
          (b) =>
            b.y <= prev.top + 2 &&
            b.y >= ln.bottom - 2 &&
            b.x1 <= Math.max(prev.maxX, ln.maxX) + 4 &&
            b.x2 >= Math.min(prev.minX, ln.minX) - 4 &&
            prev.glyphs.some((g) => g.bottom >= b.y - 3 && g.x <= b.x2 + 2 && g.right >= b.x1 - 2) &&
            ln.glyphs.some((g) => g.top <= b.y + 3 && g.x <= b.x2 + 2 && g.right >= b.x1 - 2)
        );

      // Two close display math rows of the same equation (e.g. multi-line equation)
      const bothDisplayMathClose =
        prev.isDisplayMath &&
        ln.isDisplayMath &&
        !(prev.hasEquationTag && ln.hasEquationTag) &&
        !prevIsProse &&
        !lnIsProse &&
        dy > 0 &&
        dy <= bodyFontSize * 2.6;

      // Small script, superscript, subscript, or bigop limit fragment
      const isScriptOrLimitFragment =
        !prev.hasEquationTag &&
        !prevIsProse &&
        !lnIsProse &&
        dy > 0 &&
        dy <= bodyFontSize * 1.4 &&
        ((prev.isDisplayMath && isPureMathLine(ln)) ||
          (ln.isDisplayMath && isPureMathLine(prev)));

      // Matrix bottom row, or lower limit continuation (e.g. Row 2 of [w/2 0; 0 h/2], or \sum lower limit `i \neq j`, denominator `N`)
      // Crucial: Matrix/limit continuation is allowed even if prev has tag (since equation tag is on the baseline row),
      // as long as ln is pure math, NOT prose, has no equation tag of its own, is tightly adjacent to prev.bottom,
      // and does not have a fraction bar below it connecting downwards into prose!
      const lnHasBarBelow = vectors.mathBars.some(
        (b) => b.y < ln.y && b.y >= ln.y - bodyFontSize * 0.55 && b.x1 <= ln.maxX && b.x2 >= ln.minX
      );
      const isMathMatrixOrContinuation =
        prev.isDisplayMath &&
        !ln.hasEquationTag &&
        !lnIsProse &&
        isPureMathLine(ln) &&
        dy > 0 &&
        (!prev.hasEquationTag
          ? prev.bottom - ln.y <= bodyFontSize * 1.35 || dy <= bodyFontSize * 2.2
          : !lnHasBarBelow &&
            (prev.bottom - ln.y <= bodyFontSize * 1.25 || dy <= bodyFontSize * 2.2) &&
            ln.minX >= prev.colLeft + 8) &&
        ln.minX >= prev.colLeft - 4 &&
        ln.maxX <= prev.colRight + 4;

      // Cases system with opening brace `{` or tall delimiter:
      // Even if the first line has an equation tag `(18)`, the lines inside the cases system belong together!
      const hasLeftBrace =
        prev.glyphs.some((g) => g.text.trim() === '{' || g.isTallDelim || g.fontRole === 'math-ext') ||
        ln.glyphs.some((g) => g.text.trim() === '{' || g.isTallDelim || g.fontRole === 'math-ext');
      const isCasesContinuation =
        hasLeftBrace &&
        !prevIsProse &&
        !lnIsProse &&
        dy > 0 &&
        dy <= bodyFontSize * 2.8 &&
        !lnHasBarBelow &&
        ln.minX >= prev.colLeft - 4 &&
        ln.maxX <= prev.colRight + 4;

      // Multi-line display equation continuation (split, align, multline, etc.):
      // E.g. Row 1: ∀GT_i ..., (4)
      //      Row 2: ∧ cls(GT_i) = cls(GT_j) ∧ d(...) < b_2 ⇒ p is negative.
      // or Row 1: ∃GT_i ..., (2)
      //    Row 2: ⇒ p is positive, cls(p) = cls(GT_i).
      const lnStartsMathOp =
        /^[∧∨⇒⇐⇔=+\-−×·≈≤≥∼≡→/\\()[\]|]/.test(ln.text.trim()) ||
        /^(?:\\wedge|\\vee|\\Rightarrow|\\Leftarrow|\\Leftrightarrow|\\approx|\\leq|\\geq)\b/.test(ln.text.trim());
      const lnHasMathRelation = /[=≈≤≥∼≡→<>∈∧∨⇒⇐⇔]/.test(ln.text);
      const lnHasProseStarter =
        /^(?:where|with|for|and|as|based|the|in|at|specifically|let|here|we|this|that|such|note|by|if|when)\s+[a-zA-Z]{3,}/i.test(ln.text.trim()) ||
        /^[A-Z][a-z]{2,}\s+[a-z]{3,}\s+[a-z]{3,}/.test(ln.text.trim());

      const isMultiLineEquationContinuation =
        prev.isDisplayMath &&
        !(prev.hasEquationTag && ln.hasEquationTag) &&
        !lnHasProseStarter &&
        dy > 0 &&
        dy <= bodyFontSize * 2.6 &&
        ln.minX >= prev.colLeft - 4 &&
        ln.maxX <= prev.colRight + 4 &&
        (ln.isDisplayMath ||
          lnStartsMathOp ||
          (lnHasMathRelation && (isPureMathLine(ln) || !lnIsProse || ln.minX >= prev.colLeft + 8)));

      if (
        sharesFractionBar ||
        bothDisplayMathClose ||
        isScriptOrLimitFragment ||
        isMathMatrixOrContinuation ||
        isCasesContinuation ||
        isMultiLineEquationContinuation
      ) {
        prev.glyphs.push(...ln.glyphs);
        prev.spans.push(...ln.spans);
        prev.top = Math.max(prev.top, ln.top);
        prev.bottom = Math.min(prev.bottom, ln.bottom);
        prev.minX = Math.min(prev.minX, ln.minX);
        prev.maxX = Math.max(prev.maxX, ln.maxX);
        prev.y = (prev.top + prev.bottom) / 2;
        prev.bars = vectors.mathBars.filter(
          (b) =>
            b.x2 >= prev.minX - 4 &&
            b.x1 <= prev.maxX + 4 &&
            b.y >= prev.bottom - bodyFontSize * 0.6 &&
            b.y <= prev.top + bodyFontSize * 0.6
        );
        prev.text = prev.glyphs.map((g) => g.text).join(' ').replace(/\s+/g, ' ').trim();
        prev.isDisplayMath = true;
        prev.hasEquationTag = prev.hasEquationTag || ln.hasEquationTag;
        continue;
      }
    }
    visualLines.push(ln);
  }

  // 5. Group VisualLines into Semantic Paragraphs (`title`, `abstract`, `heading`, `body`, `formula`, `caption`, `footnote`)
  const proseSteps: number[] = [];
  for (let i = 1; i < visualLines.length; i++) {
    if (visualLines[i].section === visualLines[i - 1].section && !visualLines[i].isDisplayMath && !visualLines[i - 1].isDisplayMath) {
      const dy = visualLines[i - 1].y - visualLines[i].y;
      if (dy >= bodyFontSize * 0.85 && dy <= bodyFontSize * 2.0) proseSteps.push(dy);
    }
  }
  proseSteps.sort((a, b) => a - b);
  const medianLineStep = proseSteps.length > 0 ? proseSteps[Math.floor(proseSteps.length / 2)] : bodyFontSize * 1.22;

  const paras: Array<AcademicParagraph<TSpan>> = [];
  let curLines: VisualLine<TSpan>[] = [];
  let curType: ParagraphType = 'body';

  // All non-formula glyphs on page for neighbor-masked formula cropping
  const proseGlyphPool = visualLines.filter((l) => !l.isDisplayMath).flatMap((l) => l.glyphs);

  const flushParagraph = () => {
    if (curLines.length === 0) return;

    const pId = paras.length;
    const isFormulaPara = curType === 'formula' || curLines.every((l) => l.isDisplayMath);
    const finalType: ParagraphType = isFormulaPara ? 'formula' : curType;

    const allGlyphs = curLines.flatMap((l) => l.glyphs);
    const minX = Math.min(...curLines.map((l) => l.minX));
    const maxX = Math.max(...curLines.map((l) => l.maxX));
    const minY = Math.min(...curLines.map((l) => l.bottom));
    const maxY = Math.max(...curLines.map((l) => l.top));

    if (finalType === 'formula') {
      const eqBars = vectors.mathBars.filter(
        (b) => b.x2 >= minX - 6 && b.x1 <= maxX + 6 && b.y >= minY - bodyFontSize && b.y <= maxY + bodyFontSize
      );
      const { latex, equationTag } = reconstructMath2D(allGlyphs, eqBars, bodyFontSize);
      const fullLatex = equationTag && latex ? `${latex} \\qquad ${equationTag}` : latex || equationTag || '';

      const buf = new TextBufferBuilder<TSpan>();
      const rawSpans: TSpan[] = [];
      for (const ln of curLines) {
        if (buf.length > 0) buf.appendSpace();
        for (let gi = 0; gi < ln.glyphs.length; gi++) {
          const g = ln.glyphs[gi];
          const sp = ln.spans[gi];
          if (gi > 0 && g.x - ln.glyphs[gi - 1].right > bodyFontSize * 0.16) buf.appendSpace();
          buf.appendText(g.text, sp, 0);
          if (sp && !rawSpans.includes(sp)) rawSpans.push(sp);
        }
      }
      const { cleanText, charMap } = buf.build();
      if (!cleanText && !fullLatex) {
        curLines = [];
        curType = 'body';
        return;
      }

      const cropRect = computeFormulaCropBox(
        allGlyphs,
        eqBars,
        proseGlyphPool,
        pageW,
        pageH,
        bodyFontSize,
        curLines[0].colLeft,
        curLines[0].colRight
      );

      paras.push({
        id: pId,
        type: 'formula',
        section: curLines[0].section,
        cleanText: cleanText || fullLatex,
        translationText: cleanText || fullLatex,
        inlineMathTokens: [],
        charMap,
        rawSpans,
        segments: [
          {
            kind: 'math',
            text: cleanText || fullLatex,
            latex: fullLatex,
            spans: rawSpans,
            items: allGlyphs.map((g) => items[g.index]).filter(Boolean),
          },
        ],
        sentencesEn: cleanText ? [{ text: cleanText, startIdx: 0, endIdx: cleanText.length }] : [],
        translation: '',
        sentenceTranslations: [],
        visionLatex: fullLatex,
        equationTag,
        localMath: fullLatex ? [{ text: cleanText || fullLatex, latex: fullLatex }] : [],
        minX,
        maxX,
        minY,
        maxY,
        formulaCropRect: cropRect,
        formulaByMergedRows: curLines.length > 1,
      });

      curLines = [];
      curType = 'body';
      return;
    }

    // Build Prose / Heading / Abstract / Caption / Footnote paragraph with strict 1:1 `TextBufferBuilder`
    // and inline math segments (`⟦M1⟧`, `⟦M2⟧`, ...)
    const buf = new TextBufferBuilder<TSpan>();
    const rawSpans: TSpan[] = [];
    const segments: Array<ParagraphSegment<TSpan>> = [];

    for (let li = 0; li < curLines.length; li++) {
      const ln = curLines[li];
      const gs = ln.glyphs.slice().sort((a, b) => a.x - b.x);
      if (gs.length === 0) continue;

      let wrapHyphenStripped = false;
      if (li > 0) {
        // Soft line-wrap hyphen join (`optimiza-` + `tion` -> `optimization`)
        const firstCh = gs[0].text[0] || '';
        if (/[a-z]/.test(firstCh) && buf.stripTrailingWrapHyphen()) {
          wrapHyphenStripped = true;
          // Joined directly without space! Also trim trailing `-` from last body segment
          const lastSeg = segments[segments.length - 1];
          if (lastSeg && lastSeg.kind === 'body' && /[-‐]$/.test(lastSeg.text)) {
            lastSeg.text = lastSeg.text.slice(0, -1);
          }
        } else {
          // CJK line wrap does NOT insert an ASCII space between two CJK characters!
          const prevCh = buf.lastChar();
          const bothCjk = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(prevCh) && /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(firstCh);
          if (!bothCjk) {
            buf.appendSpace();
          }
        }
      }

      // Partition line glyphs into contiguous prose runs vs inline 2D math runs
      let gi = 0;
      while (gi < gs.length) {
        const g = gs[gi];
        const sp = spans[g.index] !== undefined ? spans[g.index] : null;
        if (sp && !rawSpans.includes(sp)) rawSpans.push(sp);

        const isGlyphAtMathBar = (item: DecodedGlyphItem) =>
          (/^[0-9A-Za-z+\-−=().,θ_]+$/.test(item.text.trim()) || item.isMathFont || item.isMathToken) &&
          vectors.mathBars.some(
            (b) =>
              item.w <= Math.max(16, (b.x2 - b.x1) * 2.5) &&
              Math.abs((item.x + item.right) / 2 - (b.x1 + b.x2) / 2) <= Math.max(6, (b.x2 - b.x1) * 0.8) &&
              Math.abs(item.y - b.y) <= bodyFontSize * 0.65
          );

        if (g.isMathFont || g.isMathToken || isGlyphAtMathBar(g)) {
          // Group contiguous inline math glyphs (including subscripts/superscripts/operators like `x_i \in \mathbb{R}^d`)
          const mathRun: DecodedGlyphItem[] = [g];
          const mathSpans: TSpan[] = sp ? [sp] : [];
          let mj = gi + 1;
          while (mj < gs.length) {
            const nxt = gs[mj];
            const prevG = mathRun[mathRun.length - 1];
            const gap = nxt.x - prevG.right;
            const isTightScript =
              gap <= bodyFontSize * 0.45 &&
              (Math.abs(nxt.y - ln.y) >= bodyFontSize * 0.16 || nxt.fontSize <= bodyFontSize * 0.86) &&
              /^[A-Za-z0-9+\-−(),′']+$/.test(nxt.text.trim());
            const isMathContinuation =
              gap <= bodyFontSize * 0.85 &&
              (nxt.isMathFont ||
                nxt.isMathToken ||
                isGlyphAtMathBar(nxt) ||
                isTightScript ||
                (/^[0-9(),+\-−=/|]+$/.test(nxt.text.trim()) && gap <= bodyFontSize * 0.65));

            if (isMathContinuation) {
              mathRun.push(nxt);
              const nsp = spans[nxt.index] !== undefined ? spans[nxt.index] : null;
              if (nsp) {
                if (!mathSpans.includes(nsp)) mathSpans.push(nsp);
                if (!rawSpans.includes(nsp)) rawSpans.push(nsp);
              }
              mj++;
            } else {
              break;
            }
          }

          // Space before inline math if needed
          if (gi > 0) {
            const prevG = gs[gi - 1];
            const gap = g.x - prevG.right;
            const prevLast = buf.lastChar();
            if (gap >= bodyFontSize * 0.11 && prevLast && !/[\s(\[“"'\u4e00-\u9fff]/.test(prevLast)) {
              buf.appendSpace();
            }
          }

          const startLen = buf.length;
          for (let k = 0; k < mathRun.length; k++) {
            const mg = mathRun[k];
            const msp = spans[mg.index] !== undefined ? spans[mg.index] : null;
            if (k > 0 && mg.x - mathRun[k - 1].right >= bodyFontSize * 0.22) {
              buf.appendSpace();
            }
            buf.appendText(mg.text, msp, 0);
          }
          const runRawText = buf.build().cleanText.slice(startLen) || mathRun.map((m) => m.text).join('');
          const inlineBars = vectors.mathBars.filter(
            (b) =>
              b.x1 >= mathRun[0].x - 2 &&
              b.x2 <= mathRun[mathRun.length - 1].right + 2 &&
              b.y >= ln.bottom - 2 &&
              b.y <= ln.top + 2
          );
          const { latex } = reconstructMath2D(mathRun, inlineBars, bodyFontSize);

          segments.push({
            kind: 'math',
            text: runRawText.trim(),
            latex: latex || runRawText.trim(),
            spans: mathSpans,
            items: mathRun.map((m) => items[m.index]).filter(Boolean),
          });
          gi = mj;
        } else {
          // Regular prose glyph
          if (gi > 0) {
            const prevG = gs[gi - 1];
            const gap = g.x - prevG.right;
            const prevCh = buf.lastChar();
            const curFirst = g.text[0] || '';
            const bothCjk = /[\u4e00-\u9fff]/.test(prevCh) && /[\u4e00-\u9fff]/.test(curFirst);
            if (
              !bothCjk &&
              gap >= bodyFontSize * 0.10 &&
              prevCh &&
              !/\s/.test(prevCh) &&
              !/^[,.;:!?’”')\]]/.test(curFirst) &&
              !/[“'(\[]$/.test(prevCh)
            ) {
              buf.appendSpace();
            }
          }
          buf.appendText(g.text, sp, 0);
          const lastSeg = segments[segments.length - 1];
          if (lastSeg && lastSeg.kind === 'body') {
            const needGap = (gi > 0 ? g.x - gs[gi - 1].right >= bodyFontSize * 0.10 : (li > 0 && !wrapHyphenStripped)) && !/\s$/.test(lastSeg.text) && !/^\s/.test(g.text);
            lastSeg.text += (needGap ? ' ' : '') + g.text;
            if (sp && !lastSeg.spans.includes(sp)) lastSeg.spans.push(sp);
            if (items[g.index]) lastSeg.items.push(items[g.index]);
          } else {
            segments.push({
              kind: 'body',
              text: g.text,
              spanRef: sp,
              spans: sp ? [sp] : [],
              items: items[g.index] ? [items[g.index]] : [],
            });
          }
          gi++;
        }
      }
    }

    const { cleanText, charMap } = buf.build();
    if (!cleanText || /^\d{1,4}$/.test(cleanText)) {
      curLines = [];
      curType = 'body';
      return;
    }

    const { translationText, inlineMathTokens } = buildInlineMathRegistry(cleanText, segments);
    const localMath = inlineMathTokens.map((t) => ({ id: t.id, text: t.rawText, latex: t.latex }));

    paras.push({
      id: pId,
      type: finalType,
      section: curLines[0].section,
      cleanText,
      translationText,
      inlineMathTokens,
      charMap,
      rawSpans,
      segments,
      sentencesEn: splitSentencesBilingual(cleanText),
      translation: '',
      sentenceTranslations: [],
      localMath: localMath.length > 0 ? localMath : undefined,
      minX,
      maxX,
      minY,
      maxY,
      algorithm: curLines.some((l) => l.isAlgorithm) || undefined,
    });

    curLines = [];
    curType = 'body';
  };

  for (let i = 0; i < visualLines.length; i++) {
    const ln = visualLines[i];
    if (!ln.text) continue;

    const yRatioFromTop = (pageH - ln.y) / Math.max(1, pageH);
    const isBoldLine = ln.glyphs.some((g) => g.isBold);
    const specialType = ln.isFootnote
      ? 'footnote'
      : ln.isDisplayMath
      ? 'formula'
      : classifyHeadingOrSpecialType(ln.text, ln.h, isBoldLine, bodyFontSize, pageNum, yRatioFromTop);

    if (curLines.length === 0) {
      curType = specialType || 'body';
      curLines.push(ln);
      if (curType === 'heading' || curType === 'title' || curType === 'keywords') {
        // Keep multi-line title together if next line also has identical large font
        const nxt = visualLines[i + 1];
        if (!(curType === 'title' && nxt && Math.abs(nxt.h - ln.h) <= 1.2 && ln.y - nxt.y <= ln.h * 1.6)) {
          flushParagraph();
        }
      }
      continue;
    }

    const prev = curLines[curLines.length - 1];
    let mustBreak = false;

    // 1. Section / column / zone boundary
    if (prev.section !== ln.section) mustBreak = true;
    // 2. Display formula boundary (both entering & leaving a display equation!)
    if (prev.isDisplayMath !== ln.isDisplayMath) mustBreak = true;
    // 3. Equation tag completed previous display formula (`(1)` followed by `(2)`)
    if (prev.isDisplayMath && prev.hasEquationTag && ln.isDisplayMath) mustBreak = true;
    // 4. Special semantic block start (`heading`, `caption`, `abstract`, `keywords`, `[1]` reference)
    if (specialType && specialType !== 'formula' && specialType !== curType) mustBreak = true;
    if (specialType === 'heading' || specialType === 'caption' || specialType === 'keywords') mustBreak = true;
    if (/^\[\d{1,3}\]\s*\S/.test(ln.text)) mustBreak = true;

    // 5. Geometric paragraph break (vertical spacing jump, indented new line after sentence end, or short previous line)
    if (!mustBreak && !ln.isDisplayMath && !ln.isAlgorithm) {
      const dy = prev.y - ln.y;
      if (dy > Math.max(medianLineStep * 1.42, prev.h * 1.65)) {
        mustBreak = true;
      } else {
        const colW = Math.max(100, ln.colRight - ln.colLeft);
        const prevShortRight = prev.maxX < prev.colRight - Math.max(bodyFontSize * 2.2, colW * 0.12);
        const curIndented = ln.minX > ln.colLeft + bodyFontSize * 0.85 && ln.minX - prev.minX > bodyFontSize * 0.65;
        const prevEndsSentence = /[.!?:。！？；”"']\s*$/.test(prev.text);

        if (prevShortRight && prevEndsSentence) mustBreak = true;
        else if (curIndented && (prevEndsSentence || prevShortRight)) mustBreak = true;
      }
    }

    // 6. Title completion
    if (!mustBreak && curType === 'title' && Math.abs(ln.h - prev.h) > 1.5) {
      mustBreak = true;
    }

    if (mustBreak) {
      flushParagraph();
      curType = specialType || 'body';
      curLines.push(ln);
      if (curType === 'heading' || curType === 'keywords') {
        flushParagraph();
      }
    } else {
      curLines.push(ln);
    }
  }
  flushParagraph();

  // Number `body` paragraphs sequentially (`bodyIndex = 1, 2, ...`) for UI compatibility
  let bodyCount = 0;
  for (const p of paras) {
    if (p.type === 'body') {
      bodyCount++;
      p.bodyIndex = bodyCount;
    }
  }

  return {
    paras,
    glyphs,
    vectors,
    bodyFontSize,
    twoColumn: colGrid.twoColumn,
    gutterX: colGrid.gutterX,
    pageW,
    pageH,
  };
}
