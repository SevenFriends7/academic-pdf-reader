/**
 * Extra regression tests for the formula visual crop / vision-split boundary.
 *
 * Why this file exists:
 *   The formula card used to take `para.rawSpans` as its crop rectangle. A PDF
 *   text layer is ordered by content stream, not by reading order, so an
 *   equation can be split into several pseudo-paragraphs (Xu 2020 p4 eq.5 is
 *   split into six). The card then shows only half an equation, and the raw
 *   char-layer residue underneath looks like garbage.
 *
 *   These tests pin two invariants:
 *     1. The crop rectangle comes from **math run geometry**, expanded only
 *        across runs that are actually adjacent (not across the 7pt gap
 *        between two different equations, and not across the 18pt gap to the
 *        following "where ..." prose).
 *     2. A vision split point is never allowed to land inside a formula.
 *
 * Run: node scratch/formula_crop_extra_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8');

function extractFunction(name, extraNames) {
  const start = code.indexOf(`  function ${name}(`);
  if (start < 0) throw new Error(`anchor not found: ${name}`);
  let depth = 0;
  let end = -1;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error(`unbalanced: ${name}`);
  return code.slice(start, end);
}

const cropSrc = extractFunction('formulaCropRectFromMathRuns');
const snapSrc = extractFunction('snapCutOutsideMath');
// eslint-disable-next-line no-new-func
const M = new Function(`${cropSrc}\n${snapSrc}\nreturn { formulaCropRectFromMathRuns, snapCutOutsideMath };`)();

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? `   ${extra}` : ''}`);
  }
}

const run = (id, minX, maxX, minY, maxY) => ({ id, box: { minX, maxX, minY, maxY } });

/*
 * Real Xu 2020 p4 coordinates (PDF points, y grows upward):
 * `z^t_{d_ij} - || V_k x_i^t - V_k x_j^t ||_2^2`
 * The text layer splits it into several items; math runs still cover the whole
 * formula. The next formula line (detection residual) is only 7pt below, so
 * the inline threshold (4.5pt) must keep it out.
 */
const distanceRuns = [
  run(0, 313, 328, 392, 402),
  run(1, 328, 345, 392, 402),
  run(2, 347, 357, 400, 410),
  run(3, 357, 403, 394, 402),
  run(4, 404, 423, 403, 413),
  run(5, 409, 419, 391, 401),
  run(6, 509, 519, 383, 393),
];
const inlinePara = { type: 'body', rawSpans: [{ _mathInfo: { math: true, runId: 3 } }] };
const rr = M.formulaCropRectFromMathRuns(inlinePara, distanceRuns, 612, 792, { block: false });
check('inline formula crop covers full formula (x 313..423)', rr && rr.x0 <= 313 && rr.x1 >= 423, JSON.stringify(rr));
check('inline formula crop does not swallow the next formula (x1 < 430)', rr && rr.x1 < 430, JSON.stringify(rr));

/* Display formula: three lines 8pt apart; "where ..." is 18pt below. */
const blockRuns = [
  run(10, 347, 532, 506, 523),
  run(11, 366, 381, 497, 507),
  run(12, 403, 463, 492, 500),
  run(13, 347, 354, 431, 441),
];
const blockPara = { type: 'formula', rawSpans: [{ _mathInfo: { math: true, runId: 10 } }] };
const rb = M.formulaCropRectFromMathRuns(blockPara, blockRuns, 612, 792, { block: true });
check('display formula crop joins all three lines', rb && rb.x0 <= 347 && rb.x1 >= 532 && rb.y1 >= 300, JSON.stringify(rb));
check('display formula crop stops before "where" prose (18pt gap)', rb && rb.y1 < 340, JSON.stringify(rb));

check(
  'no math runs -> null (caller falls back to span union)',
  M.formulaCropRectFromMathRuns({ rawSpans: [{ _mathInfo: null }] }, distanceRuns, 612, 792, {}) === null,
);

/* Vision split boundary: `abc zx - y K def`, formula = chars 4..12. */
const mathSpan = { _mathInfo: { math: true } };
const bodySpan = { _mathInfo: { math: false } };
const text = 'abc zx - y K def';
const charMap = text.split('').map((ch, i) => ({ span: i >= 4 && i <= 12 ? mathSpan : bodySpan, offset: 0 }));
const splitPara = { cleanText: text, charMap, segments: [] };
const inside = text.indexOf('y');
check(
  'cut inside formula -> body part starts after the formula',
  M.snapCutOutsideMath(splitPara, inside, false) === text.indexOf('def'),
  String(M.snapCutOutsideMath(splitPara, inside, false)),
);
check(
  'cut inside formula -> formula part starts at the formula',
  M.snapCutOutsideMath(splitPara, inside, true) === text.indexOf('zx') - 1,
  String(M.snapCutOutsideMath(splitPara, inside, true)),
);
check(
  'cut already at a prose boundary -> unchanged',
  M.snapCutOutsideMath(splitPara, text.indexOf('abc'), false) === text.indexOf('abc'),
);

console.log(`\n===== ????: ${pass} passed / ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
