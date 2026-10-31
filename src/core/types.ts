/**
 * Core shared types for the Academic PDF Reader v2.0 Engine.
 * Pure TypeScript — zero DOM or VS Code Host coupling, runnable in both Node & Browser Webview.
 */

export type FontRole =
  | 'math-italic'
  | 'math-symbol'
  | 'math-ext'
  | 'math-bb'
  | 'math-cal'
  | 'math-frak'
  | 'body-serif'
  | 'body-sans'
  | 'mono'
  | 'cjk'
  | 'unknown';

export interface PdfTextItemLike {
  str: string;
  dir?: string;
  width?: number;
  height?: number;
  transform: number[]; // [a, b, c, d, x, y] in PDF bottom-up coordinates
  fontName?: string;
  hasEOL?: boolean;
}

export interface DecodedGlyphItem {
  index: number;
  rawStr: string;
  text: string;
  latex: string;
  fontKey: string;
  realFontName: string;
  fontRole: FontRole;
  isItalic: boolean;
  isBold: boolean;
  isRotated: boolean;
  isMathFont: boolean;
  isMathToken: boolean;
  isBigOp: boolean;
  isDelimiterExt: boolean;
  isTallDelim: boolean;
  isAccent: boolean;
  isRadicalSign: boolean;
  /** PDF bottom-up coordinates (points) */
  x: number;
  y: number; // baseline y
  w: number;
  h: number;
  fontSize: number;
  top: number; // y + ascent (PDF bottom-up)
  bottom: number; // y - descent (PDF bottom-up)
  right: number; // x + w
}

export interface VectorHLine {
  x1: number;
  x2: number;
  y: number;
  thickness?: number;
}

export interface VectorVLine {
  x: number;
  y1: number;
  y2: number;
  thickness?: number;
}

export interface VectorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawPageGraphics {
  hLines: VectorHLine[];
  vLines: VectorVLine[];
  rects: VectorRect[];
}

export interface TableRegionBox {
  x1: number;
  x2: number;
  minY: number;
  maxY: number;
  ruleCount: number;
}

export interface ClassifiedPageVectors extends RawPageGraphics {
  mathBars: VectorHLine[];
  tableRegions: TableRegionBox[];
  algoBoxes: TableRegionBox[];
  footnoteRules: VectorHLine[];
}

/**
 * Top-down PDF point bounding box (origin at top-left of page, matching viewport(scale=1)).
 * Used directly by canvas cropping (`sx = x0 * scale`, `sy = y0 * scale`).
 */
export interface TopDownRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Optional top-down rectangles to paint white over intruding neighbor ascenders/descenders */
  maskRects?: Array<{ x0: number; y0: number; x1: number; y1: number }>;
}

/**
 * Indexed Inline Math Token (`⟦M1⟧`, `⟦M2⟧`, ...) for lossless bilingual math preservation.
 */
export interface InlineMathToken {
  /** Short stable token ID within paragraph, e.g. 'M1', 'M2' */
  id: string;
  /** Exact placeholder sent to translation LLM, e.g. '⟦M1⟧' */
  placeholder: string;
  /** Reconstructed clean KaTeX-ready LaTeX string (without surrounding $) */
  latex: string;
  /** Normalized readable Unicode fallback text in cleanText */
  rawText: string;
  /** Character start offset in para.cleanText (inclusive) */
  startIdx: number;
  /** Character end offset in para.cleanText (exclusive) */
  endIdx: number;
}

export interface SentenceSpan {
  text: string;
  startIdx: number;
  endIdx: number;
}

export interface CharMapEntry<TSpan = unknown> {
  span: TSpan | null;
  offset: number;
}

export type ParagraphType =
  | 'title'
  | 'abstract'
  | 'keywords'
  | 'heading'
  | 'body'
  | 'formula'
  | 'caption'
  | 'footnote'
  | 'figure-label'
  | 'metadata'
  | 'noise';

export interface ParagraphSegment<TSpan = unknown> {
  kind: 'body' | 'math';
  text: string;
  latex?: string;
  tokenId?: string;
  spanRef?: TSpan | null;
  spans: TSpan[];
  items: PdfTextItemLike[];
  __off?: number;
  __spanStart?: number;
  __spanEnd?: number;
  __spanLen?: number;
  runId?: number | null;
  _hadLeadingSpace?: boolean;
}

export interface AcademicParagraph<TSpan = unknown> {
  id: number;
  type: ParagraphType;
  section?: string;
  bodyIndex?: number;
  cleanText: string;
  /** Text with inline math replaced by `⟦M1⟧`, `⟦M2⟧` placeholders for LLM translation */
  translationText: string;
  /** Lookup registry for `⟦M1⟧` -> LaTeX */
  inlineMathTokens: InlineMathToken[];
  charMap: Array<CharMapEntry<TSpan>>;
  rawSpans: TSpan[];
  segments: Array<ParagraphSegment<TSpan>>;
  sentencesEn: SentenceSpan[];
  translation: string;
  sentenceTranslations: string[];
  visionLatex?: string;
  equationTag?: string;
  localMath?: Array<{ text: string; latex: string; id?: string }>;
  /** PDF bottom-up bounds */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Smart neighbor-masked top-down PDF crop rect for display formulas */
  formulaCropRect?: TopDownRect;
  formulaByMergedRows?: boolean;
  formulaByLayout?: boolean;
  formulaByShape?: boolean;
  mergedMath?: boolean;
  notationTable?: boolean;
  algorithm?: boolean;
  continuedFromPage?: number;
  continuedText?: string;
}
