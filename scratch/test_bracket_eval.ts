import { evaluateDisplayFormulaLine } from '../src/core/math/mathEngine2D';

const dummyGlyphs = [
  { text: '[', x: 412, right: 416, w: 4, h: 10, y: 201.7, top: 206.7, bottom: 196.7, fontSize: 10, isTallDelim: true, fontRole: 'math-ext', isMathToken: true },
  { text: ']', x: 475, right: 479, w: 4, h: 10, y: 201.7, top: 206.7, bottom: 196.7, fontSize: 10, isTallDelim: true, fontRole: 'math-ext', isMathToken: true }
];

const ev = evaluateDisplayFormulaLine(dummyGlyphs as any, [], 310, 560, 10);
console.log('evaluateDisplayFormulaLine for [ ]:', ev);
