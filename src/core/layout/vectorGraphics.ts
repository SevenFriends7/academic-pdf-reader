/**
 * PDF Vector Graphics Extractor & Classifier (`src/core/layout/vectorGraphics.ts`)
 *
 * 1. Extracts horizontal lines down to `2.2pt` width (capturing `\frac{1}{2}`, `\sqrt{x}`,
 *    wide fraction bars, radical overbars, footnote rules, algorithm rules, and table rules).
 * 2. Eliminates the catastrophic full-page `tableRegions` wipeout bug (`AOT.pdf` p2-p5, `cycle.pdf` p6)
 *    by clustering ONLY aligned rules with bounded vertical spacing AND verifying tabular text geometry
 *    so prose paragraphs and display equations are NEVER deleted.
 */

import {
  ClassifiedPageVectors,
  DecodedGlyphItem,
  RawPageGraphics,
  TableRegionBox,
  VectorHLine,
  VectorRect,
  VectorVLine,
} from '../types';

export interface PdfJsOpsTable {
  save: number;
  restore: number;
  transform: number;
  moveTo: number;
  lineTo: number;
  rectangle: number;
  constructPath: number;
  curveTo?: number;
  closePath?: number;
}

export interface PdfOperatorListLike {
  fnArray: number[];
  argsArray: unknown[][];
}

function mulMatrix(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyPt(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Extract raw vector lines and rectangles from a PDF.js `getOperatorList()` result.
 * Captures horizontal segments down to `2.2pt` so short fraction/radical bars are preserved.
 */
export function extractRawPageVectors(
  opList: PdfOperatorListLike | null | undefined,
  ops: PdfJsOpsTable | null | undefined,
  pageW: number,
  pageH: number
): RawPageGraphics {
  if (!opList || !Array.isArray(opList.fnArray) || !ops) {
    return { hLines: [], vLines: [], rects: [] };
  }

  const hLines: VectorHLine[] = [];
  const vLines: VectorVLine[] = [];
  const rects: VectorRect[] = [];

  const addSeg = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    if (dy <= 1.2 && dx >= 2.2) {
      hLines.push({
        x1: Math.min(x1, x2),
        x2: Math.max(x1, x2),
        y: (y1 + y2) / 2,
        thickness: Math.max(0.4, dy),
      });
    } else if (dx <= 1.2 && dy >= 4.0) {
      vLines.push({
        x: (x1 + x2) / 2,
        y1: Math.min(y1, y2),
        y2: Math.max(y1, y2),
        thickness: Math.max(0.4, dx),
      });
    }
  };

  const addRect = (x: number, y: number, w: number, h: number) => {
    if (!(w > 0) || !(h > 0)) return;
    // Many TeX engines (`pdftex` / `dvips` / `xelatex`) draw `\frac` & `\sqrt` bars as filled thin rectangles!
    if (h <= 2.6 && w >= 2.2) {
      hLines.push({ x1: x, x2: x + w, y: y + h / 2, thickness: h });
    } else if (w <= 2.6 && h >= 4.0) {
      vLines.push({ x: x + w / 2, y1: y, y2: y + h, thickness: w });
    } else if (w >= 14 && h >= 12) {
      rects.push({ x, y, w, h });
    }
  };

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  let last: [number, number] | null = null;

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (fn === ops.save) {
      stack.push(ctm.slice());
    } else if (fn === ops.restore) {
      ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === ops.transform && Array.isArray(args) && args.length >= 6) {
      ctm = mulMatrix(ctm, args.map(Number));
    } else if (fn === ops.moveTo && Array.isArray(args)) {
      last = applyPt(ctm, Number(args[0]) || 0, Number(args[1]) || 0);
    } else if (fn === ops.lineTo && Array.isArray(args)) {
      const p = applyPt(ctm, Number(args[0]) || 0, Number(args[1]) || 0);
      if (last) addSeg(last[0], last[1], p[0], p[1]);
      last = p;
    } else if (fn === ops.rectangle && Array.isArray(args)) {
      const rx = Number(args[0]) || 0;
      const ry = Number(args[1]) || 0;
      const rw = Number(args[2]) || 0;
      const rh = Number(args[3]) || 0;
      const p = applyPt(ctm, rx, ry);
      const q = applyPt(ctm, rx + rw, ry + rh);
      addRect(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1]));
      last = null;
    } else if (fn === ops.constructPath && Array.isArray(args) && args[0] && args[1]) {
      const subOps = args[0] as ArrayLike<number>;
      const coords = args[1] as ArrayLike<number>;
      let k = 0;
      last = null;
      for (let j = 0; j < subOps.length; j++) {
        const op = subOps[j];
        if (op === ops.moveTo) {
          last = applyPt(ctm, Number(coords[k++]) || 0, Number(coords[k++]) || 0);
        } else if (op === ops.lineTo) {
          const p = applyPt(ctm, Number(coords[k++]) || 0, Number(coords[k++]) || 0);
          if (last) addSeg(last[0], last[1], p[0], p[1]);
          last = p;
        } else if (op === ops.rectangle) {
          const rx = Number(coords[k++]) || 0;
          const ry = Number(coords[k++]) || 0;
          const rw = Number(coords[k++]) || 0;
          const rh = Number(coords[k++]) || 0;
          const p = applyPt(ctm, rx, ry);
          const q = applyPt(ctm, rx + rw, ry + rh);
          addRect(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1]));
          last = null;
        } else if (ops.curveTo !== undefined && op === ops.curveTo) {
          k += 6;
          last = null;
        } else if (ops.closePath !== undefined && op === ops.closePath) {
          last = null;
        }
      }
    }
  }

  const inPage = (x: number, y: number) => x >= -8 && x <= pageW + 8 && y >= -8 && y <= pageH + 8;

  // Deduplicate within 0.5pt precision so short adjacent math bars are never collided
  const seenH = new Set<string>();
  const dedupH: VectorHLine[] = [];
  hLines.sort((a, b) => b.y - a.y || a.x1 - b.x1);
  for (const h of hLines) {
    if (!inPage(h.x1, h.y) || !inPage(h.x2, h.y)) continue;
    const key = `${Math.round(h.y * 2)}:${Math.round(h.x1 * 2)}:${Math.round(h.x2 * 2)}`;
    if (!seenH.has(key)) {
      seenH.add(key);
      dedupH.push(h);
    }
    if (dedupH.length >= 2500) break;
  }

  const seenV = new Set<string>();
  const dedupV: VectorVLine[] = [];
  vLines.sort((a, b) => a.x - b.x || b.y2 - a.y2);
  for (const v of vLines) {
    if (!inPage(v.x, v.y1) || !inPage(v.x, v.y2)) continue;
    const key = `${Math.round(v.x * 2)}:${Math.round(v.y1 * 2)}:${Math.round(v.y2 * 2)}`;
    if (!seenV.has(key)) {
      seenV.add(key);
      dedupV.push(v);
    }
    if (dedupV.length >= 1800) break;
  }

  return {
    hLines: dedupH,
    vLines: dedupV,
    rects: rects.slice(0, 600),
  };
}

/**
 * Verify whether a cluster of aligned horizontal rules actually bounds a tabular data region
 * (vs architecture diagram boxes or rules spanning over normal body prose / display formulas).
 */
function isGenuineTableRegion(
  box: TableRegionBox,
  glyphs: DecodedGlyphItem[],
  bodyFontSize: number
): boolean {
  const height = box.maxY - box.minY;
  if (height < bodyFontSize * 2.5 || height > 520) return false;

  const inside = glyphs.filter((g) => {
    if (!g.text.trim() || g.isDelimiterExt) return false;
    const cx = g.x + g.w / 2;
    return cx >= box.x1 - 4 && cx <= box.x2 + 4 && g.y >= box.minY - 4 && g.y <= box.maxY + 4;
  });

  // Empty diagram box with 0 text is not a text table
  if (inside.length < 4) return false;

  // Group inside glyphs into visual baselines
  const rows: Array<{ y: number; items: DecodedGlyphItem[] }> = [];
  for (const g of inside) {
    let row = rows.find((r) => Math.abs(r.y - g.y) <= Math.max(2.5, bodyFontSize * 0.32));
    if (!row) {
      row = { y: g.y, items: [] };
      rows.push(row);
    }
    row.items.push(g);
  }
  if (rows.length < 2) return false;

  let tabularRows = 0;
  let continuousProseRows = 0;
  const colGapThreshold = Math.max(11, bodyFontSize * 1.25);

  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let largeGaps = 0;
    let rowText = '';
    for (let i = 0; i < r.items.length; i++) {
      rowText += ' ' + r.items[i].text;
      if (i > 0) {
        const gap = r.items[i].x - r.items[i - 1].right;
        if (gap >= colGapThreshold) largeGaps++;
      }
    }
    const cleanRow = rowText.trim();
    // Equation numbered lines `(1)` inside region -> NOT a table! Never wipe out equations!
    if (/\(\s*\d{1,3}[a-z]?\s*\)\s*$/.test(cleanRow) && /[=+\-−∑∏∫≤≥≈∈]/.test(cleanRow)) {
      return false;
    }

    const words = (cleanRow.match(/[A-Za-z]{2,}/g) || []).length;
    const numbers = (cleanRow.match(/\b\d+(?:\.\d+)?%?\b/g) || []).length;
    const rowSpanW = r.items[r.items.length - 1].right - r.items[0].x;

    if (largeGaps >= 2 || (largeGaps >= 1 && numbers >= 2) || numbers >= 3) {
      tabularRows++;
    } else if (words >= 9 && largeGaps === 0 && rowSpanW > (box.x2 - box.x1) * 0.65) {
      continuousProseRows++;
    }
  }

  // If continuous prose lines dominate or >= 3 prose lines exist inside, this is NOT a table!
  if (continuousProseRows >= 3 || continuousProseRows > tabularRows) {
    return false;
  }
  return tabularRows >= Math.max(2, Math.floor(rows.length * 0.35));
}

/**
 * Classify raw page vector graphics into:
 * - `tableRegions`: verified ruled tables (safe to exclude from prose column clustering)
 * - `algoBoxes`: ruled algorithm blocks (`Algorithm 1 ...`)
 * - `footnoteRules`: bottom-left footnote separator rules
 * - `mathBars`: horizontal fraction bars (`\frac`) and radical overbars (`\sqrt`)
 */
export function classifyPageVectors(
  raw: RawPageGraphics | null | undefined,
  glyphs: DecodedGlyphItem[],
  pageW: number,
  pageH: number,
  bodyFontSize = 10
): ClassifiedPageVectors {
  const hLines = raw?.hLines || [];
  const vLines = raw?.vLines || [];
  const rects = raw?.rects || [];

  if (hLines.length === 0) {
    return {
      hLines: [],
      vLines,
      rects,
      mathBars: [],
      tableRegions: [],
      algoBoxes: [],
      footnoteRules: [],
    };
  }

  const usedLineIndices = new Set<number>();

  // 1. Footnote separator rules: bottom 34% of page, left-aligned, width 30pt..190pt
  const footnoteRules: VectorHLine[] = [];
  hLines.forEach((ln, idx) => {
    const w = ln.x2 - ln.x1;
    if (
      ln.y > bodyFontSize * 4.2 &&
      ln.y < pageH * 0.34 &&
      ln.x1 < pageW * 0.24 &&
      w >= 28 &&
      w <= Math.min(200, pageW * 0.36)
    ) {
      // Check there isn't math immediately centered on this bar (fractions have items both closely above & below)
      const closeAbove = glyphs.some(
        (g) => g.x < ln.x2 && g.right > ln.x1 && g.bottom >= ln.y - 1.5 && g.bottom <= ln.y + bodyFontSize * 0.85
      );
      const closeBelow = glyphs.some(
        (g) => g.x < ln.x2 && g.right > ln.x1 && g.top <= ln.y + 1.5 && g.top >= ln.y - bodyFontSize * 0.85
      );
      if (!(closeAbove && closeBelow && w < 90)) {
        footnoteRules.push(ln);
        usedLineIndices.add(idx);
      }
    }
  });

  // 2. Cluster wide aligned horizontal rules into candidate Algorithm or Table boxes
  // Uses Math.min(pageW * 0.20, 118) to reliably catch single-column and multi-table ablation sub-tables (e.g. 150pt wide in CVPR/ICCV)
  const minTableRuleW = Math.min(pageW * 0.20, 118);
  const wideCandidates = hLines
    .map((ln, idx) => ({ ln, idx, w: ln.x2 - ln.x1 }))
    .filter(
      (c) =>
        !usedLineIndices.has(c.idx) &&
        c.ln.y > 28 &&
        c.ln.y < pageH - 28 &&
        c.w >= minTableRuleW
    )
    .sort((a, b) => b.ln.y - a.ln.y); // top-to-bottom in PDF y (high y -> low y)

  const clusters: Array<Array<{ ln: VectorHLine; idx: number }>> = [];
  for (const cand of wideCandidates) {
    let attached = false;
    for (const cl of clusters) {
      const last = cl[cl.length - 1];
      const sameSpan =
        Math.abs(cand.ln.x1 - last.ln.x1) <= 16 && Math.abs(cand.ln.x2 - last.ln.x2) <= 16;
      const gapY = last.ln.y - cand.ln.y;

      // Never merge separate vertically stacked sub-tables if a Table caption sits between them
      const hasCaptionBetween = glyphs.some(
        (g) =>
          g.y < last.ln.y - 2 &&
          g.y > cand.ln.y + 2 &&
          g.x >= Math.min(last.ln.x1, cand.ln.x1) - 10 &&
          g.right <= Math.max(last.ln.x2, cand.ln.x2) + 10 &&
          /^(?:Table|Tab\.)/i.test(g.text)
      );

      // Consecutive horizontal rules in a table or algorithm box are within <= 160pt
      if (sameSpan && gapY >= 0 && gapY <= 160 && !hasCaptionBetween) {
        cl.push({ ln: cand.ln, idx: cand.idx });
        attached = true;
        break;
      }
    }
    if (!attached) {
      clusters.push([{ ln: cand.ln, idx: cand.idx }]);
    }
  }

  const tableRegions: TableRegionBox[] = [];
  const algoBoxes: TableRegionBox[] = [];

  for (const cl of clusters) {
    // Deduplicate rules at virtually identical Y (e.g. double rules `\hline\hline`)
    const distinctY: VectorHLine[] = [];
    for (const item of cl) {
      if (!distinctY.some((d) => Math.abs(d.y - item.ln.y) <= 2.5)) {
        distinctY.push(item.ln);
      }
    }
    if (distinctY.length < 3) continue;

    const box: TableRegionBox = {
      x1: Math.min(...cl.map((c) => c.ln.x1)),
      x2: Math.max(...cl.map((c) => c.ln.x2)),
      minY: Math.min(...cl.map((c) => c.ln.y)),
      maxY: Math.max(...cl.map((c) => c.ln.y)),
      ruleCount: distinctY.length,
    };

    // Check if top band of this ruled box starts with `Algorithm N` / `Procedure N`
    const topBandText = glyphs
      .filter(
        (g) =>
          g.x >= box.x1 - 6 &&
          g.right <= box.x2 + 6 &&
          g.y <= box.maxY + 4 &&
          g.y >= box.maxY - bodyFontSize * 3.0
      )
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((g) => g.text)
      .join(' ')
      .trim();

    if (/^(?:Algorithm|Procedure|Protocol)\s+\d+/i.test(topBandText)) {
      algoBoxes.push(box);
      cl.forEach((c) => usedLineIndices.add(c.idx));
      continue;
    }

    if (isGenuineTableRegion(box, glyphs, bodyFontSize)) {
      tableRegions.push(box);
      cl.forEach((c) => usedLineIndices.add(c.idx));
    }
  }

  // 3. Identify Math Fraction Bars & Radical Overbars!
  // A horizontal bar `2.2pt <= width <= 230pt` that is NOT part of a table/algo/footnote rule
  // AND has math/glyph content closely above (`\frac` numerator) and/or closely below (`\frac` denominator or `\sqrt` radicand).
  const mathBars: VectorHLine[] = [];
  hLines.forEach((ln, idx) => {
    if (usedLineIndices.has(idx)) return;
    const w = ln.x2 - ln.x1;
    if (w < 2.2 || w > Math.min(240, pageW * 0.46)) return;
    if ((ln.thickness ?? 0.6) > 2.4) return;
    if (ln.y < bodyFontSize * 4.5 || ln.y > pageH - bodyFontSize * 4.5) return;

    // Exclude bars inside verified table regions
    const inTable = tableRegions.some(
      (t) => ln.x1 >= t.x1 - 4 && ln.x2 <= t.x2 + 4 && ln.y >= t.minY - 4 && ln.y <= t.maxY + 4
    );
    if (inTable) return;

    // Exclude rectangle edges (e.g. diagram nodes where vertical lines meet both ends `[x1, x2]`)
    const hasLeftVert = vLines.some(
      (v) => Math.abs(v.x - ln.x1) <= 1.8 && ln.y >= v.y1 - 1.8 && ln.y <= v.y2 + 1.8 && v.y2 - v.y1 >= 8
    );
    const hasRightVert = vLines.some(
      (v) => Math.abs(v.x - ln.x2) <= 1.8 && ln.y >= v.y1 - 1.8 && ln.y <= v.y2 + 1.8 && v.y2 - v.y1 >= 8
    );
    if (hasLeftVert && hasRightVert) return;

    // Check nearby glyphs above or below within tight math vertical distance
    const maxSearchV = bodyFontSize * 1.9;
    let hasAbove = false;
    let hasBelow = false;
    let hasLeftRadical = false;

    for (const g of glyphs) {
      if (!g.text.trim() && !g.isRadicalSign) continue;
      if (g.isRadicalSign && Math.abs(g.right - ln.x1) <= bodyFontSize * 0.9 && Math.abs(g.top - ln.y) <= bodyFontSize * 1.2) {
        hasLeftRadical = true;
      }
      const xOverlap = Math.min(g.right, ln.x2 + 1.5) - Math.max(g.x, ln.x1 - 1.5);
      if (xOverlap <= 0) continue;
      // Numerator sits above bar: glyph baseline or bottom is >= ln.y - 1.5 and within maxSearchV
      if (g.y >= ln.y - 0.5 && g.y - ln.y <= maxSearchV) {
        hasAbove = true;
      }
      // Denominator or sqrt radicand sits below bar: glyph top/baseline is <= ln.y + 2.5 and within maxSearchV
      if (g.y < ln.y + 0.5 && ln.y - g.y <= maxSearchV * 1.15) {
        hasBelow = true;
      }
    }

    // Fraction bar has both numerator above AND denominator below; radical overbar has radical sign + radicand below
    if ((hasAbove && hasBelow) || (hasLeftRadical && hasBelow)) {
      mathBars.push(ln);
    }
  });

  return {
    hLines,
    vLines,
    rects,
    mathBars,
    tableRegions,
    algoBoxes,
    footnoteRules,
  };
}
