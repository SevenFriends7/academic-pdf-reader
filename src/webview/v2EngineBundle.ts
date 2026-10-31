/**
 * Browser Webview v2 Engine Bundle (`src/webview/v2EngineBundle.ts` -> `media/v2-engine.js`)
 * Exposes `window.AcademicV2` to the Webview UI.
 */

import {
  AcademicParagraph,
  InlineMathToken,
  TopDownRect,
} from '../core/types';
import {
  classifyFontFamily,
  decodeGlyphString,
  decodePageGlyphs,
  stripSubsetPrefix,
  UNICODE_MATH_TO_LATEX,
} from '../core/glyphs/fontDecoder';
import {
  classifyPageVectors,
  extractRawPageVectors,
} from '../core/layout/vectorGraphics';
import {
  buildInlineMathRegistry,
  computeFormulaCropBox,
  evaluateDisplayFormulaLine,
  findInlineMathSubstrings,
  reconstructMath2D,
  resolveInlineMathPlaceholders,
} from '../core/math/mathEngine2D';
import {
  solveAcademicPageLayout,
  splitSentencesBilingual,
  TextBufferBuilder,
} from '../core/layout/academicLayoutEngine';
import {
  PageMathCacheEntry,
  PdfSnipToolController,
  SnipToolBridge,
} from './snipTool';

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render an English sentence slice `[sentStart, sentEnd)` with its exact `InlineMathToken[]`
 * rendered via KaTeX (`class="local-math v2-inline-math"`).
 */
export function renderSentenceEnWithMathTokens(
  sentText: string,
  sentStartIdx: number,
  para: Pick<AcademicParagraph, 'inlineMathTokens' | 'cleanText'> | null | undefined,
  renderKatexInline: (latex: string) => string
): string | null {
  const tokens = para?.inlineMathTokens;
  if (!sentText || !Array.isArray(tokens) || tokens.length === 0) {
    return null;
  }

  const sentEndIdx = sentStartIdx + sentText.length;
  const overlapping = tokens.filter((t) => t.startIdx >= sentStartIdx && t.endIdx <= sentEndIdx && t.endIdx > t.startIdx);
  if (overlapping.length === 0) return null;

  overlapping.sort((a, b) => a.startIdx - b.startIdx);
  let html = '';
  let relCursor = 0;

  for (const tok of overlapping) {
    const relStart = tok.startIdx - sentStartIdx;
    const relEnd = tok.endIdx - sentStartIdx;
    if (relStart < relCursor) continue;
    if (relStart > relCursor) {
      html += escapeHtml(sentText.slice(relCursor, relStart));
    }
    const rendered = renderKatexInline(tok.latex);
    html += `<span class="local-math v2-inline-math" data-math-id="${escapeHtml(tok.id)}" title="${escapeHtml(tok.latex)}">${rendered}</span>`;
    relCursor = relEnd;
  }

  if (relCursor < sentText.length) {
    html += escapeHtml(sentText.slice(relCursor));
  }
  return html;
}

/**
 * Render a translated Chinese sentence/paragraph containing `⟦M1⟧`, `⟦M2⟧` placeholders
 * (or forgiving LLM bracket variants `[M1]`, `【M1】`, `$M1$`) into KaTeX HTML in O(1),
 * while preserving full fallback rendering for `$...$` and legacy `⟦…⟧`!
 */
export function renderZhWithMathTokens(
  zhText: string,
  para: Pick<AcademicParagraph, 'inlineMathTokens'> | null | undefined,
  renderKatexInline: (latex: string) => string,
  legacyRenderer: (plainOrLegacyText: string) => string
): string {
  if (!zhText) return '';
  const tokens = para?.inlineMathTokens;
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return legacyRenderer(zhText);
  }

  // Replace `⟦M1⟧` with collision-proof alphanumeric sentinels `@@AGYMATH0@@`, run legacyRenderer
  // on the surrounding prose/markdown, then splice in the exact rendered KaTeX spans!
  const renderedMap: string[] = [];
  const withSentinels = resolveInlineMathPlaceholders(zhText, tokens, (tok: InlineMathToken) => {
    const idx = renderedMap.length;
    const katexHtml = renderKatexInline(tok.latex);
    renderedMap.push(
      `<span class="local-math v2-inline-math" data-math-id="${escapeHtml(tok.id)}" title="${escapeHtml(tok.latex)}">${katexHtml}</span>`
    );
    return `AGYMATHSENTINEL${idx}END`;
  });

  if (renderedMap.length === 0) {
    return legacyRenderer(zhText);
  }

  let html = legacyRenderer(withSentinels);
  for (let i = 0; i < renderedMap.length; i++) {
    html = html.split(`AGYMATHSENTINEL${i}END`).join(renderedMap[i]);
  }
  return html;
}

/**
 * Convert `⟦M1⟧` placeholders in translated text to standard `$latex$` Markdown
 * (used when exporting bilingual Markdown reading docs or copying clean translated Markdown!).
 */
export function restorePlaceholdersToMarkdownLatex(
  zhText: string,
  tokens: InlineMathToken[] | undefined
): string {
  return resolveInlineMathPlaceholders(zhText, tokens, (tok) => `$${tok.latex}$`);
}

/**
 * Crop a display formula from a rendered full-page `<canvas>` using `TopDownRect`
 * and paint `#ffffff` over any `maskRects` (intruding neighbor prose ascenders/descenders).
 */
export function cropFormulaCanvasWithMasks(
  fullCanvas: HTMLCanvasElement,
  scale: number,
  rect: TopDownRect
): string | null {
  if (!fullCanvas || !rect) return null;
  const sx = Math.max(0, Math.floor(rect.x0 * scale));
  const sy = Math.max(0, Math.floor(rect.y0 * scale));
  const sw = Math.min(fullCanvas.width - sx, Math.ceil((rect.x1 - rect.x0) * scale));
  const sh = Math.min(fullCanvas.height - sy, Math.ceil((rect.y1 - rect.y0) * scale));
  if (sw < 6 || sh < 6) return null;

  const crop = document.createElement('canvas');
  crop.width = sw;
  crop.height = sh;
  const ctx = crop.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  if (Array.isArray(rect.maskRects) && rect.maskRects.length > 0) {
    ctx.fillStyle = '#ffffff';
    for (const m of rect.maskRects) {
      const mx = Math.max(0, Math.floor((m.x0 - rect.x0) * scale));
      const my = Math.max(0, Math.floor((m.y0 - rect.y0) * scale));
      const mw = Math.ceil((m.x1 - m.x0) * scale);
      const mh = Math.ceil((m.y1 - m.y0) * scale);
      if (mw > 0 && mh > 0) {
        ctx.fillRect(mx, my, mw, mh);
      }
    }
  }

  try {
    return crop.toDataURL('image/png');
  } catch {
    return null;
  }
}

export interface UnifiedFormulaEntry {
  page: number;
  kind: 'block' | 'inline';
  latex: string;
  paraIndex?: number;
}

/**
 * Collect formulas from BOTH Local 2D archived/current paragraphs AND `visionStructure`
 * so the "公式·符号" index tab works 100% offline out-of-the-box on every paper!
 */
export function collectUnifiedFormulas(
  pageParaArchive: Map<number, any[]> | undefined,
  currentPage: number,
  currentParagraphs: any[] | undefined,
  visionStructure: Record<string, any> | undefined
): UnifiedFormulaEntry[] {
  const results: UnifiedFormulaEntry[] = [];
  const seen = new Set<string>();

  const pushEntry = (page: number, kind: 'block' | 'inline', rawLatex: string, paraIndex?: number) => {
    const tex = String(rawLatex || '').trim();
    if (!tex || tex.length < 2) return;
    // Skip trivial single digit / punctuation
    if (/^[0-9.,;:()[\]+\-]+$/.test(tex)) return;
    const key = `${page}|${kind}|${tex}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ page, kind, latex: tex, paraIndex });
  };

  // 1. Vision structure entries (if user ran full-page vision on any pages)
  const pagesWithVision = new Set<number>();
  if (visionStructure && typeof visionStructure === 'object') {
    for (const k of Object.keys(visionStructure)) {
      const page = Number(k);
      if (!Number.isFinite(page) || page < 1) continue;
      const entry = visionStructure[k];
      if (!entry || !Array.isArray(entry.segments)) continue;
      let addedOnPage = 0;
      for (const seg of entry.segments) {
        if (!seg || seg.action === 'drop') continue;
        if (seg.type === 'formula' && seg.latex) {
          pushEntry(page, 'block', seg.latex, seg.index);
          addedOnPage++;
        }
        if (Array.isArray(seg.parts)) {
          for (const part of seg.parts) {
            if (part?.type === 'formula' && part.latex) {
              pushEntry(page, 'block', part.latex, seg.index);
              addedOnPage++;
            }
          }
        }
        if (Array.isArray(seg.inline)) {
          for (const m of seg.inline) {
            if (m?.latex) {
              pushEntry(page, 'inline', m.latex, seg.index);
              addedOnPage++;
            }
          }
        }
      }
      if (addedOnPage > 0) pagesWithVision.add(page);
    }
  }

  // 2. Local 2D parsed pages (currentPage + pageParaArchive)
  const localPages = new Map<number, any[]>();
  if (pageParaArchive && typeof pageParaArchive.forEach === 'function') {
    pageParaArchive.forEach((list, p) => {
      if (Number.isFinite(p) && Array.isArray(list)) localPages.set(p, list);
    });
  }
  if (Number.isFinite(currentPage) && currentPage >= 1 && Array.isArray(currentParagraphs) && currentParagraphs.length > 0) {
    localPages.set(currentPage, currentParagraphs);
  }

  const sortedPageNums = Array.from(localPages.keys()).sort((a, b) => a - b);
  for (const page of sortedPageNums) {
    if (pagesWithVision.has(page)) continue;
    const paras = localPages.get(page) || [];
    paras.forEach((p, idx) => {
      if (!p) return;
      if (p.type === 'formula') {
        const tex = p.visionLatex || (Array.isArray(p.localMath) && p.localMath[0]?.latex) || '';
        if (tex) pushEntry(page, 'block', tex, p.id ?? idx);
        return;
      }
      if (Array.isArray(p.inlineMathTokens) && p.inlineMathTokens.length > 0) {
        for (const tok of p.inlineMathTokens) {
          if (tok?.latex && tok.latex.length >= 3) {
            pushEntry(page, 'inline', tok.latex, p.id ?? idx);
          }
        }
      } else if (Array.isArray(p.localMath)) {
        for (const m of p.localMath) {
          if (m?.latex && m.latex.length >= 3) {
            pushEntry(page, 'inline', m.latex, p.id ?? idx);
          }
        }
      }
    });
  }

  results.sort((a, b) => a.page - b.page);
  return results;
}

export function createSnipTool(bridge: SnipToolBridge): PdfSnipToolController {
  const ctrl = new PdfSnipToolController(bridge);
  ctrl.init();
  return ctrl;
}

export const AcademicV2 = {
  stripSubsetPrefix,
  classifyFontFamily,
  decodeGlyphString,
  decodePageGlyphs,
  UNICODE_MATH_TO_LATEX,
  extractRawPageVectors,
  classifyPageVectors,
  reconstructMath2D,
  evaluateDisplayFormulaLine,
  computeFormulaCropBox,
  findInlineMathSubstrings,
  buildInlineMathRegistry,
  resolveInlineMathPlaceholders,
  restorePlaceholdersToMarkdownLatex,
  solveAcademicPageLayout,
  splitSentencesBilingual,
  TextBufferBuilder,
  renderSentenceEnWithMathTokens,
  renderZhWithMathTokens,
  cropFormulaCanvasWithMasks,
  collectUnifiedFormulas,
  createSnipTool,
};

declare global {
  interface Window {
    AcademicV2?: typeof AcademicV2;
    __pageV2MathCache?: Map<number, PageMathCacheEntry>;
  }
}

if (typeof window !== 'undefined') {
  window.AcademicV2 = AcademicV2;
  if (!window.__pageV2MathCache) {
    window.__pageV2MathCache = new Map<number, PageMathCacheEntry>();
  }
}
