import * as fs from 'fs';
import * as path from 'path';
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

import { extractRawPageVectors, classifyPageVectors } from '../src/core/layout/vectorGraphics';
import { decodePageGlyphs } from '../src/core/glyphs/fontDecoder';
import { evaluateDisplayFormulaLine } from '../src/core/math/mathEngine2D';

const PROSE_WORD_REGEX = /\b(?:where|with|for|and|as|the|in|that|which|is|are|we|by|from|to|can|be|of|loss|detector|matrix|coefficient|equation|overlap|based|on|above|denotes|determinant|covariance|count|within|training|image|omits|diagonal|elements)\b/i;

function isProseLine(text: string): boolean {
  if (PROSE_WORD_REGEX.test(text)) return true;
  const words = text.split(/\s+/).filter(w => /^[a-zA-Z]{3,}$/.test(w));
  return words.length >= 2;
}

function isPureMathLine(glyphs: any[]): boolean {
  if (!glyphs || glyphs.length === 0) return false;
  return glyphs.every(g =>
    g.isMathFont ||
    g.isMathToken ||
    /^[0-9+\-−=/().,θ\[\]{}|\\_′'~^]+$/.test(g.text.trim()) ||
    /^(?:sin|cos|tan|exp|log|ln|det|max|min|lim|sup|inf)$/i.test(g.text.trim())
  );
}

console.log('Testing prose detection:');
console.log('approximated by Bhattacharyya:', isProseLine('approximated by the Bhattacharyya coefficient [60] as:'));
console.log('where mu = mu2 - mu1:', isProseLine('where μ = μ 2 − μ 1 , Σ = 2 (Σ 1 + Σ 2 ) , | Σ | denotes the'));
console.log('0 h/2:', isProseLine('0 h/2'), 'isPureMath:', isPureMathLine([{ text: '0' }, { text: 'h/2', isMathFont: true }]));
console.log('i != j:', isProseLine('i ̸ = j'), 'isPureMath:', isPureMathLine([{ text: 'i', isMathFont: true }, { text: '̸=', isMathToken: true }, { text: 'j', isMathFont: true }]));
console.log('1 X:', isProseLine('1 X'));
