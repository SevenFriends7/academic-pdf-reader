/**
 * Publisher-Agnostic PDF Font & Glyph Decoder (`src/core/glyphs/fontDecoder.ts`)
 *
 * Solves Root Cause 2 (inline symbols & control-char garbage `ctrl-glyph`) and
 * Root Cause 1b (publisher-diverse math font classification across TeX, IEEE/Word,
 * Springer, Elsevier, Cambria Math, Adobe Symbol, and CJK papers).
 */

import { DecodedGlyphItem, FontRole, PdfTextItemLike } from '../types';

/** Strip 6-uppercase-letter PDF subset prefix like `QZLXPR+CMMI10` -> `CMMI10` */
export function stripSubsetPrefix(fontName: string): string {
  return String(fontName || '').replace(/^[A-Z]{6}\+/, '').trim();
}

/**
 * TeX OML encoding (`CMMI*`, `CMMIB*`, `LMMathItalic*`, `EURM*`, `MTMI*`)
 * Slots 0x00..0x3F when PDF lacks a proper ToUnicode CMap emit control chars `U+0000..0x001F`!
 */
const OML_LOW_SLOTS: Record<number, [string, string]> = {
  0x00: ['Γ', '\\Gamma'],
  0x01: ['Δ', '\\Delta'],
  0x02: ['Θ', '\\Theta'],
  0x03: ['Λ', '\\Lambda'],
  0x04: ['Ξ', '\\Xi'],
  0x05: ['Π', '\\Pi'],
  0x06: ['Σ', '\\Sigma'],
  0x07: ['Υ', '\\Upsilon'],
  0x08: ['Φ', '\\Phi'],
  0x09: ['Ψ', '\\Psi'],
  0x0a: ['Ω', '\\Omega'],
  0x0b: ['α', '\\alpha'],
  0x0c: ['β', '\\beta'],
  0x0d: ['γ', '\\gamma'],
  0x0e: ['δ', '\\delta'],
  0x0f: ['ϵ', '\\epsilon'],
  0x10: ['ζ', '\\zeta'],
  0x11: ['η', '\\eta'],
  0x12: ['θ', '\\theta'],
  0x13: ['ι', '\\iota'],
  0x14: ['κ', '\\kappa'],
  0x15: ['λ', '\\lambda'],
  0x16: ['μ', '\\mu'],
  0x17: ['ν', '\\nu'],
  0x18: ['ξ', '\\xi'],
  0x19: ['π', '\\pi'],
  0x1a: ['ρ', '\\rho'],
  0x1b: ['σ', '\\sigma'],
  0x1c: ['τ', '\\tau'],
  0x1d: ['υ', '\\upsilon'],
  0x1e: ['ϕ', '\\phi'],
  0x1f: ['χ', '\\chi'],
  0x20: ['ψ', '\\psi'],
  0x21: ['ω', '\\omega'],
  0x22: ['ε', '\\varepsilon'],
  0x23: ['ϑ', '\\vartheta'],
  0x24: ['ϖ', '\\varpi'],
  0x25: ['ϱ', '\\varrho'],
  0x26: ['ς', '\\varsigma'],
  0x27: ['φ', '\\varphi'],
  0x3a: ['.', '.'],
  0x3b: [',', ','],
  0x3c: ['<', '<'],
  0x3d: ['/', '/'],
  0x3e: ['>', '>'],
  0x3f: ['⋆', '\\star'],
  0x40: ['∂', '\\partial'],
  0x5b: ['♭', '\\flat'],
  0x5c: ['♮', '\\natural'],
  0x5d: ['♯', '\\sharp'],
  0x5e: ['⌣', '\\smile'],
  0x5f: ['⌢', '\\frown'],
  0x60: ['ℓ', '\\ell'],
  0x7b: ['ı', '\\imath'],
  0x7c: ['ȷ', '\\jmath'],
  0x7d: ['℘', '\\wp'],
  0x7e: ['⃗', '\\vec'],
};

/**
 * TeX OMS encoding (`CMSY*`, `CMBSY*`, `LMMathSymbols*`, `MTSYN*`)
 * Slots 0x00..0x7F map to operators, relations, arrows, and calligraphic capitals (0x41..0x5A).
 */
const OMS_SLOTS: Record<number, [string, string]> = {
  0x00: ['−', '-'],
  0x01: ['⋅', '\\cdot'],
  0x02: ['×', '\\times'],
  0x03: ['∗', '\\ast'],
  0x04: ['÷', '\\div'],
  0x05: ['⋄', '\\diamond'],
  0x06: ['±', '\\pm'],
  0x07: ['∓', '\\mp'],
  0x08: ['⊕', '\\oplus'],
  0x09: ['⊖', '\\ominus'],
  0x0a: ['⊗', '\\otimes'],
  0x0b: ['⊘', '\\oslash'],
  0x0c: ['⊙', '\\odot'],
  0x0d: ['◯', '\\bigcirc'],
  0x0e: ['∘', '\\circ'],
  0x0f: ['∙', '\\bullet'],
  0x10: ['≍', '\\asymp'],
  0x11: ['≡', '\\equiv'],
  0x12: ['⊆', '\\subseteq'],
  0x13: ['⊇', '\\supseteq'],
  0x14: ['≤', '\\leq'],
  0x15: ['≥', '\\geq'],
  0x16: ['≼', '\\preceq'],
  0x17: ['≽', '\\succeq'],
  0x18: ['∼', '\\sim'],
  0x19: ['≈', '\\approx'],
  0x1a: ['⊂', '\\subset'],
  0x1b: ['⊃', '\\supset'],
  0x1c: ['≪', '\\ll'],
  0x1d: ['≫', '\\gg'],
  0x1e: ['≺', '\\prec'],
  0x1f: ['≻', '\\succ'],
  0x20: ['←', '\\leftarrow'],
  0x21: ['→', '\\rightarrow'],
  0x22: ['↑', '\\uparrow'],
  0x23: ['↓', '\\downarrow'],
  0x24: ['↔', '\\leftrightarrow'],
  0x25: ['↗', '\\nearrow'],
  0x26: ['↘', '\\searrow'],
  0x27: ['≃', '\\simeq'],
  0x28: ['⇐', '\\Leftarrow'],
  0x29: ['⇒', '\\Rightarrow'],
  0x2a: ['⇑', '\\Uparrow'],
  0x2b: ['⇓', '\\Downarrow'],
  0x2c: ['⇔', '\\Leftrightarrow'],
  0x2d: ['↖', '\\nwarrow'],
  0x2e: ['↙', '\\swarrow'],
  0x2f: ['∝', '\\propto'],
  0x30: ['′', '^\\prime'],
  0x31: ['∞', '\\infty'],
  0x32: ['∈', '\\in'],
  0x33: ['∋', '\\ni'],
  0x34: ['△', '\\triangle'],
  0x35: ['▽', '\\bigtriangledown'],
  0x36: ['̸', '\\not'],
  0x38: ['∀', '\\forall'],
  0x39: ['∃', '\\exists'],
  0x3a: ['¬', '\\neg'],
  0x3b: ['∅', '\\emptyset'],
  0x3c: ['ℜ', '\\Re'],
  0x3d: ['ℑ', '\\Im'],
  0x3e: ['⊤', '\\top'],
  0x3f: ['⊥', '\\perp'],
  0x5b: ['∪', '\\cup'],
  0x5c: ['∩', '\\cap'],
  0x5d: ['⊎', '\\uplus'],
  0x5e: ['∧', '\\wedge'],
  0x5f: ['∨', '\\vee'],
  0x60: ['⊢', '\\vdash'],
  0x61: ['⊣', '\\dashv'],
  0x62: ['⌊', '\\lfloor'],
  0x63: ['⌋', '\\rfloor'],
  0x64: ['⌈', '\\lceil'],
  0x65: ['⌉', '\\rceil'],
  0x66: ['{', '\\{'],
  0x67: ['}', '\\}'],
  0x68: ['⟨', '\\langle'],
  0x69: ['⟩', '\\rangle'],
  0x6a: ['|', '|'],
  0x6b: ['∥', '\\|'],
  0x6e: ['\\', '\\setminus'],
  0x70: ['√', '\\sqrt'],
  0x72: ['∇', '\\nabla'],
  0x73: ['∫', '\\int'],
  0x74: ['⊔', '\\sqcup'],
  0x75: ['⊓', '\\sqcap'],
  0x76: ['⊑', '\\sqsubseteq'],
  0x77: ['⊒', '\\sqsupseteq'],
  0x78: ['§', '\\S'],
  0x79: ['†', '\\dagger'],
  0x7a: ['‡', '\\ddagger'],
};

/**
 * TeX OMX encoding (`CMEX*`, `LMMathExtension*`) — tall delimiters, radicals, big operators.
 * Also notes which slots are multi-piece delimiter extension pieces so they don't pollute text!
 */
interface OmxEntry {
  uni: string;
  tex: string;
  bigOp?: boolean;
  delim?: boolean;
  delimExt?: boolean;
  radical?: boolean;
  accent?: boolean;
}

const OMX_SLOTS: Record<number, OmxEntry> = {
  0x00: { uni: '(', tex: '(', delim: true },
  0x01: { uni: ')', tex: ')', delim: true },
  0x02: { uni: '[', tex: '[', delim: true },
  0x03: { uni: ']', tex: ']', delim: true },
  0x04: { uni: '⌊', tex: '\\lfloor', delim: true },
  0x05: { uni: '⌋', tex: '\\rfloor', delim: true },
  0x06: { uni: '⌈', tex: '\\lceil', delim: true },
  0x07: { uni: '⌉', tex: '\\rceil', delim: true },
  0x08: { uni: '{', tex: '\\{', delim: true },
  0x09: { uni: '}', tex: '\\}', delim: true },
  0x0a: { uni: '⟨', tex: '\\langle', delim: true },
  0x0b: { uni: '⟩', tex: '\\rangle', delim: true },
  0x0c: { uni: '|', tex: '|', delim: true, delimExt: true },
  0x0d: { uni: '∥', tex: '\\|', delim: true, delimExt: true },
  0x0e: { uni: '/', tex: '/', delim: true },
  0x0f: { uni: '\\', tex: '\\backslash', delim: true },
  0x10: { uni: '(', tex: '(', delim: true },
  0x11: { uni: ')', tex: ')', delim: true },
  0x12: { uni: '(', tex: '(', delim: true },
  0x13: { uni: ')', tex: ')', delim: true },
  0x14: { uni: '[', tex: '[', delim: true },
  0x15: { uni: ']', tex: ']', delim: true },
  0x16: { uni: '⌊', tex: '\\lfloor', delim: true },
  0x17: { uni: '⌋', tex: '\\rfloor', delim: true },
  0x18: { uni: '⌈', tex: '\\lceil', delim: true },
  0x19: { uni: '⌉', tex: '\\rceil', delim: true },
  0x1a: { uni: '{', tex: '\\{', delim: true },
  0x1b: { uni: '}', tex: '\\}', delim: true },
  0x1c: { uni: '⟨', tex: '\\langle', delim: true },
  0x1d: { uni: '⟩', tex: '\\rangle', delim: true },
  0x20: { uni: '(', tex: '(', delim: true },
  0x21: { uni: ')', tex: ')', delim: true },
  0x22: { uni: '[', tex: '[', delim: true },
  0x23: { uni: ']', tex: ']', delim: true },
  0x28: { uni: '{', tex: '\\{', delim: true },
  0x29: { uni: '}', tex: '\\}', delim: true },
  0x2a: { uni: '⟨', tex: '\\langle', delim: true },
  0x2b: { uni: '⟩', tex: '\\rangle', delim: true },
  // Multi-part delimiter pieces (top/mid/bottom/extenders): mark first piece, suppress extenders
  0x30: { uni: '(', tex: '(', delim: true },
  0x31: { uni: ')', tex: ')', delim: true },
  0x32: { uni: '[', tex: '[', delim: true },
  0x33: { uni: ']', tex: ']', delim: true },
  0x34: { uni: '', tex: '', delimExt: true },
  0x35: { uni: '', tex: '', delimExt: true },
  0x36: { uni: '', tex: '', delimExt: true },
  0x37: { uni: '', tex: '', delimExt: true },
  0x38: { uni: '{', tex: '\\{', delim: true },
  0x39: { uni: '}', tex: '\\}', delim: true },
  0x3a: { uni: '', tex: '', delimExt: true },
  0x3b: { uni: '', tex: '', delimExt: true },
  0x3c: { uni: '', tex: '', delimExt: true },
  0x3d: { uni: '', tex: '', delimExt: true },
  0x3e: { uni: '', tex: '', delimExt: true },
  0x3f: { uni: '', tex: '', delimExt: true },
  0x40: { uni: '', tex: '', delimExt: true },
  0x41: { uni: '', tex: '', delimExt: true },
  0x42: { uni: '', tex: '', delimExt: true },
  0x43: { uni: '', tex: '', delimExt: true },
  // Big operators in CMEX
  0x46: { uni: '⊔', tex: '\\bigsqcup', bigOp: true },
  0x47: { uni: '⊔', tex: '\\bigsqcup', bigOp: true },
  0x48: { uni: '∮', tex: '\\oint', bigOp: true },
  0x49: { uni: '∮', tex: '\\oint', bigOp: true },
  0x4a: { uni: '⊙', tex: '\\bigodot', bigOp: true },
  0x4b: { uni: '⊙', tex: '\\bigodot', bigOp: true },
  0x4c: { uni: '⊕', tex: '\\bigoplus', bigOp: true },
  0x4d: { uni: '⊕', tex: '\\bigoplus', bigOp: true },
  0x4e: { uni: '⊗', tex: '\\bigotimes', bigOp: true },
  0x4f: { uni: '⊗', tex: '\\bigotimes', bigOp: true },
  0x50: { uni: '∑', tex: '\\sum', bigOp: true },
  0x51: { uni: '∏', tex: '\\prod', bigOp: true },
  0x52: { uni: '∫', tex: '\\int', bigOp: true },
  0x53: { uni: '⋃', tex: '\\bigcup', bigOp: true },
  0x54: { uni: '⋂', tex: '\\bigcap', bigOp: true },
  0x55: { uni: '⊎', tex: '\\biguplus', bigOp: true },
  0x56: { uni: '⋀', tex: '\\bigwedge', bigOp: true },
  0x57: { uni: '⋁', tex: '\\bigvee', bigOp: true },
  0x58: { uni: '∑', tex: '\\sum', bigOp: true },
  0x59: { uni: '∏', tex: '\\prod', bigOp: true },
  0x5a: { uni: '∫', tex: '\\int', bigOp: true },
  0x5b: { uni: '⋃', tex: '\\bigcup', bigOp: true },
  0x5c: { uni: '⋂', tex: '\\bigcap', bigOp: true },
  0x5d: { uni: '⊎', tex: '\\biguplus', bigOp: true },
  0x5e: { uni: '⋀', tex: '\\bigwedge', bigOp: true },
  0x5f: { uni: '⋁', tex: '\\bigvee', bigOp: true },
  0x60: { uni: '∐', tex: '\\coprod', bigOp: true },
  0x61: { uni: '∐', tex: '\\coprod', bigOp: true },
  0x62: { uni: '̂', tex: '\\widehat', accent: true },
  0x63: { uni: '̂', tex: '\\widehat', accent: true },
  0x64: { uni: '̂', tex: '\\widehat', accent: true },
  0x65: { uni: '̃', tex: '\\widetilde', accent: true },
  0x66: { uni: '̃', tex: '\\widetilde', accent: true },
  0x67: { uni: '̃', tex: '\\widetilde', accent: true },
  0x70: { uni: '√', tex: '\\sqrt', radical: true },
  0x71: { uni: '√', tex: '\\sqrt', radical: true },
  0x72: { uni: '√', tex: '\\sqrt', radical: true },
  0x73: { uni: '√', tex: '\\sqrt', radical: true },
  0x74: { uni: '√', tex: '\\sqrt', radical: true },
  0x75: { uni: '', tex: '', delimExt: true },
  0x76: { uni: '', tex: '', delimExt: true },
};

/** TeX OT1 (`CMR*`, `CMBX*`, `CMTI*`, `CMSS*`, `CMTT*`) low control slots 0x00..0x1F */
const OT1_LOW_SLOTS: Record<number, [string, string]> = {
  0x00: ['Γ', '\\Gamma'],
  0x01: ['Δ', '\\Delta'],
  0x02: ['Θ', '\\Theta'],
  0x03: ['Λ', '\\Lambda'],
  0x04: ['Ξ', '\\Xi'],
  0x05: ['Π', '\\Pi'],
  0x06: ['Σ', '\\Sigma'],
  0x07: ['Υ', '\\Upsilon'],
  0x08: ['Φ', '\\Phi'],
  0x09: ['Ψ', '\\Psi'],
  0x0a: ['Ω', '\\Omega'],
  0x0b: ['ff', 'ff'],
  0x0c: ['fi', 'fi'],
  0x0d: ['fl', 'fl'],
  0x0e: ['ffi', 'ffi'],
  0x0f: ['ffl', 'ffl'],
  0x10: ['ı', '\\imath'],
  0x11: ['ȷ', '\\jmath'],
  0x12: ['`', '`'],
  0x13: ['´', "'"],
  0x14: ['ˇ', '\\check'],
  0x15: ['˘', '\\breve'],
  0x16: ['¯', '\\bar'],
  0x17: ['˚', '\\mathring'],
  0x19: ['ß', 'ss'],
  0x1a: ['æ', 'ae'],
  0x1b: ['œ', 'oe'],
  0x1c: ['ø', 'o'],
  0x1d: ['Æ', 'AE'],
  0x1e: ['Œ', 'OE'],
  0x1f: ['Ø', 'O'],
};

/** Adobe Symbol / Windows SymbolMT / Word & WPS PUA (`U+F000..U+F0FF`) encoding table */
const ADOBE_SYMBOL_SLOTS: Record<number, { uni: string; tex: string; bigOp?: boolean; radical?: boolean; delimExt?: boolean }> = {
  0x22: { uni: '∀', tex: '\\forall' },
  0x24: { uni: '∃', tex: '\\exists' },
  0x27: { uni: '∋', tex: '\\ni' },
  0x2a: { uni: '∗', tex: '\\ast' },
  0x2d: { uni: '−', tex: '-' },
  0x40: { uni: '≅', tex: '\\cong' },
  0x41: { uni: 'Α', tex: 'A' },
  0x42: { uni: 'Β', tex: 'B' },
  0x43: { uni: 'Χ', tex: 'X' },
  0x44: { uni: 'Δ', tex: '\\Delta' },
  0x45: { uni: 'Ε', tex: 'E' },
  0x46: { uni: 'Φ', tex: '\\Phi' },
  0x47: { uni: 'Γ', tex: '\\Gamma' },
  0x48: { uni: 'Η', tex: 'H' },
  0x49: { uni: 'Ι', tex: 'I' },
  0x4a: { uni: 'ϑ', tex: '\\vartheta' },
  0x4b: { uni: 'Κ', tex: 'K' },
  0x4c: { uni: 'Λ', tex: '\\Lambda' },
  0x4d: { uni: 'Μ', tex: 'M' },
  0x4e: { uni: 'Ν', tex: 'N' },
  0x4f: { uni: 'Ο', tex: 'O' },
  0x50: { uni: 'Π', tex: '\\Pi' },
  0x51: { uni: 'Θ', tex: '\\Theta' },
  0x52: { uni: 'Ρ', tex: 'P' },
  0x53: { uni: 'Σ', tex: '\\Sigma' },
  0x54: { uni: 'Τ', tex: 'T' },
  0x55: { uni: 'Υ', tex: '\\Upsilon' },
  0x56: { uni: 'ς', tex: '\\varsigma' },
  0x57: { uni: 'Ω', tex: '\\Omega' },
  0x58: { uni: 'Ξ', tex: '\\Xi' },
  0x59: { uni: 'Ψ', tex: '\\Psi' },
  0x5a: { uni: 'Ζ', tex: 'Z' },
  0x5e: { uni: '⊥', tex: '\\perp' },
  0x61: { uni: 'α', tex: '\\alpha' },
  0x62: { uni: 'β', tex: '\\beta' },
  0x63: { uni: 'χ', tex: '\\chi' },
  0x64: { uni: 'δ', tex: '\\delta' },
  0x65: { uni: 'ε', tex: '\\varepsilon' },
  0x66: { uni: 'φ', tex: '\\phi' },
  0x67: { uni: 'γ', tex: '\\gamma' },
  0x68: { uni: 'η', tex: '\\eta' },
  0x69: { uni: 'ι', tex: '\\iota' },
  0x6a: { uni: 'ϕ', tex: '\\varphi' },
  0x6b: { uni: 'κ', tex: '\\kappa' },
  0x6c: { uni: 'λ', tex: '\\lambda' },
  0x6d: { uni: 'μ', tex: '\\mu' },
  0x6e: { uni: 'ν', tex: '\\nu' },
  0x6f: { uni: 'ο', tex: 'o' },
  0x70: { uni: 'π', tex: '\\pi' },
  0x71: { uni: 'θ', tex: '\\theta' },
  0x72: { uni: 'ρ', tex: '\\rho' },
  0x73: { uni: 'σ', tex: '\\sigma' },
  0x74: { uni: 'τ', tex: '\\tau' },
  0x75: { uni: 'υ', tex: '\\upsilon' },
  0x76: { uni: 'ϖ', tex: '\\varpi' },
  0x77: { uni: 'ω', tex: '\\omega' },
  0x78: { uni: 'ξ', tex: '\\xi' },
  0x79: { uni: 'ψ', tex: '\\psi' },
  0x7a: { uni: 'ζ', tex: '\\zeta' },
  0x7e: { uni: '∼', tex: '\\sim' },
  0xa2: { uni: '′', tex: '^\\prime' },
  0xa3: { uni: '≤', tex: '\\leq' },
  0xa5: { uni: '∞', tex: '\\infty' },
  0xab: { uni: '↔', tex: '\\leftrightarrow' },
  0xac: { uni: '←', tex: '\\leftarrow' },
  0xad: { uni: '↑', tex: '\\uparrow' },
  0xae: { uni: '→', tex: '\\rightarrow' },
  0xaf: { uni: '↓', tex: '\\downarrow' },
  0xb1: { uni: '±', tex: '\\pm' },
  0xb2: { uni: '″', tex: '^{\\prime\\prime}' },
  0xb3: { uni: '≥', tex: '\\geq' },
  0xb4: { uni: '×', tex: '\\times' },
  0xb5: { uni: '∝', tex: '\\propto' },
  0xb6: { uni: '∂', tex: '\\partial' },
  0xb7: { uni: '∙', tex: '\\bullet' },
  0xb8: { uni: '÷', tex: '\\div' },
  0xb9: { uni: '≠', tex: '\\neq' },
  0xba: { uni: '≡', tex: '\\equiv' },
  0xbb: { uni: '≈', tex: '\\approx' },
  0xc4: { uni: '⊗', tex: '\\otimes' },
  0xc5: { uni: '⊕', tex: '\\oplus' },
  0xc6: { uni: '∅', tex: '\\emptyset' },
  0xc7: { uni: '∩', tex: '\\cap' },
  0xc8: { uni: '∪', tex: '\\cup' },
  0xc9: { uni: '⊃', tex: '\\supset' },
  0xca: { uni: '⊇', tex: '\\supseteq' },
  0xcc: { uni: '⊂', tex: '\\subset' },
  0xcd: { uni: '⊆', tex: '\\subseteq' },
  0xce: { uni: '∈', tex: '\\in' },
  0xcf: { uni: '∉', tex: '\\notin' },
  0xd1: { uni: '∇', tex: '\\nabla' },
  0xd5: { uni: '∏', tex: '\\prod', bigOp: true },
  0xd6: { uni: '√', tex: '\\sqrt', radical: true },
  0xd7: { uni: '⋅', tex: '\\cdot' },
  0xd8: { uni: '¬', tex: '\\neg' },
  0xd9: { uni: '∧', tex: '\\wedge' },
  0xda: { uni: '∨', tex: '\\vee' },
  0xdb: { uni: '⇔', tex: '\\Leftrightarrow' },
  0xdc: { uni: '⇐', tex: '\\Leftarrow' },
  0xde: { uni: '⇒', tex: '\\Rightarrow' },
  0xe1: { uni: '⟨', tex: '\\langle' },
  0xe5: { uni: '∑', tex: '\\sum', bigOp: true },
  0xf1: { uni: '⟩', tex: '\\rangle' },
  0xf2: { uni: '∫', tex: '\\int', bigOp: true },
  0xe6: { uni: '', tex: '', delimExt: true },
  0xe7: { uni: '', tex: '', delimExt: true },
  0xe8: { uni: '', tex: '', delimExt: true },
  0xe9: { uni: '', tex: '', delimExt: true },
  0xea: { uni: '', tex: '', delimExt: true },
  0xeb: { uni: '', tex: '', delimExt: true },
  0xec: { uni: '', tex: '', delimExt: true },
  0xed: { uni: '', tex: '', delimExt: true },
  0xee: { uni: '', tex: '', delimExt: true },
  0xef: { uni: '', tex: '', delimExt: true },
  0xf3: { uni: '', tex: '', delimExt: true },
  0xf4: { uni: '', tex: '', delimExt: true },
  0xf5: { uni: '', tex: '', delimExt: true },
  0xf6: { uni: '', tex: '', delimExt: true },
  0xf7: { uni: '', tex: '', delimExt: true },
  0xf8: { uni: '', tex: '', delimExt: true },
  0xf9: { uni: '', tex: '', delimExt: true },
  0xfa: { uni: '', tex: '', delimExt: true },
  0xfb: { uni: '', tex: '', delimExt: true },
  0xfc: { uni: '', tex: '', delimExt: true },
  0xfd: { uni: '', tex: '', delimExt: true },
  0xfe: { uni: '', tex: '', delimExt: true },
};

const BMP_MATHBB_CHARS: Record<string, string> = {
  C: 'ℂ',
  H: 'ℍ',
  N: 'ℕ',
  P: 'ℙ',
  Q: 'ℚ',
  R: 'ℝ',
  Z: 'ℤ',
};

/** Unicode Mathematical Symbol -> LaTeX mapping */
export const UNICODE_MATH_TO_LATEX: Record<string, string> = {
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'ε': '\\varepsilon', 'ϵ': '\\epsilon', 'ζ': '\\zeta', 'η': '\\eta',
  'θ': '\\theta', 'ϑ': '\\vartheta', 'ι': '\\iota', 'κ': '\\kappa',
  'λ': '\\lambda', 'μ': '\\mu', 'µ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi',
  'π': '\\pi', 'ϖ': '\\varpi', 'ρ': '\\rho', 'ϱ': '\\varrho',
  'σ': '\\sigma', 'ς': '\\varsigma', 'τ': '\\tau', 'υ': '\\upsilon',
  'φ': '\\varphi', 'ϕ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', '∆': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
  'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon', 'Φ': '\\Phi',
  'Ψ': '\\Psi', 'Ω': '\\Omega', 'Ω': '\\Omega',
  '∂': '\\partial', '∇': '\\nabla', '∞': '\\infty', 'ℓ': '\\ell', 'ℏ': '\\hbar',
  '∅': '\\emptyset', 'varnothing': '\\varnothing', '∀': '\\forall', '∃': '\\exists',
  '∄': '\\nexists', '¬': '\\neg', '∈': '\\in', '∉': '\\notin', '∋': '\\ni',
  '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq',
  '⊊': '\\subsetneq', '⊋': '\\supsetneq', '∪': '\\cup', '∩': '\\cap',
  '⊎': '\\uplus', '∖': '\\setminus', '∧': '\\wedge', '∨': '\\vee',
  '⊕': '\\oplus', '⊖': '\\ominus', '⊗': '\\otimes', '⊘': '\\oslash', '⊙': '\\odot',
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '⋅': '\\cdot', '·': '\\cdot',
  '∘': '\\circ', '∙': '\\bullet', '∗': '\\ast', '⋆': '\\star', '∝': '\\propto',
  '∼': '\\sim', '≃': '\\simeq', '≅': '\\cong', '≈': '\\approx', '≡': '\\equiv',
  '≠': '\\neq', '≤': '\\leq', '⩽': '\\leqslant', '≥': '\\geq', '⩾': '\\geqslant',
  '≪': '\\ll', '≫': '\\gg', '≺': '\\prec', '≻': '\\succ', '≼': '\\preceq', '≽': '\\succeq',
  '⊥': '\\perp', '⊤': '\\top', '⊢': '\\vdash', '⊣': '\\dashv', '⊨': '\\models',
  '←': '\\leftarrow', '→': '\\rightarrow', '↑': '\\uparrow', '↓': '\\downarrow',
  '↔': '\\leftrightarrow', '⇐': '\\Leftarrow', '⇒': '\\Rightarrow', '⇔': '\\Leftrightarrow',
  '↦': '\\mapsto', '⟶': '\\longrightarrow', '⟵': '\\longleftarrow', '⟹': '\\Longrightarrow',
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint',
  '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap', '⨁': '\\bigoplus', '⨂': '\\bigotimes',
  '⋁': '\\bigvee', '⋀': '\\bigwedge', '⨄': '\\biguplus', '⨆': '\\bigsqcup',
  '√': '\\sqrt', '∥': '\\|', '⟨': '\\langle', '⟩': '\\rangle',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil',
  '′': '^\\prime', '″': '^{\\prime\\prime}', '−': '-', '–': '-',
  'ℝ': '\\mathbb{R}', 'ℂ': '\\mathbb{C}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}',
  'ℚ': '\\mathbb{Q}', '𝔼': '\\mathbb{E}', 'ℙ': '\\mathbb{P}', '𝕀': '\\mathbb{I}',
  'ℜ': '\\Re', 'ℑ': '\\Im', '℘': '\\wp', 'ℵ': '\\aleph',
  // Unicode Multi-piece Delimiters & Bracket Pieces (U+239B..U+23AD)
  '': '(', '': '', '': ')',
  '': ')', '': '', '': ')',
  '': '[', '': '', '': ']',
  '': ']', '': '', '': ']',
  '': '\\{', '': '', '': '\\}',
  '': '\\}', '': '', '': '\\}',
};

const BIG_OP_CHARS = new Set(['∑', '∏', '∐', '∫', '∬', '∭', '∮', '⋃', '⋂', '⨁', '⨂', '⋁', '⋀', '⨄', '⨆']);
const ACCENT_CHARS = new Set(['\u0300', '\u0301', '\u0302', '\u0303', '\u0304', '\u0305', '\u0307', '\u0308', '\u20d7', 'ˆ', '˜', '¯', '˙', '¨', '⃗']);
const STANDARD_LIGATURES: Record<string, string> = {
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
};

/**
 * Decode Unicode Mathematical Alphanumeric Symbols (`U+1D400..U+1D7FF`)
 * into clean ASCII/Greek base + LaTeX wrapper (`\mathbf`, `\mathcal`, `\mathbb`, `\mathfrak`, italic).
 */
export function decodeUnicodeMathAlnum(cp: number): { uni: string; tex: string; isMath: boolean } | null {
  // Bold A-Z / a-z
  if (cp >= 0x1d400 && cp <= 0x1d419) {
    const ch = String.fromCharCode(0x41 + (cp - 0x1d400));
    return { uni: ch, tex: `\\mathbf{${ch}}`, isMath: true };
  }
  if (cp >= 0x1d41a && cp <= 0x1d433) {
    const ch = String.fromCharCode(0x61 + (cp - 0x1d41a));
    return { uni: ch, tex: `\\mathbf{${ch}}`, isMath: true };
  }
  // Italic A-Z / a-z
  if (cp >= 0x1d434 && cp <= 0x1d44d) {
    const ch = String.fromCharCode(0x41 + (cp - 0x1d434));
    return { uni: ch, tex: ch, isMath: true };
  }
  if (cp >= 0x1d44e && cp <= 0x1d467) {
    const ch = String.fromCharCode(0x61 + (cp - 0x1d44e));
    return { uni: ch, tex: ch, isMath: true };
  }
  // Bold Italic A-Z / a-z
  if (cp >= 0x1d468 && cp <= 0x1d481) {
    const ch = String.fromCharCode(0x41 + (cp - 0x1d468));
    return { uni: ch, tex: `\\boldsymbol{${ch}}`, isMath: true };
  }
  if (cp >= 0x1d482 && cp <= 0x1d49b) {
    const ch = String.fromCharCode(0x61 + (cp - 0x1d482));
    return { uni: ch, tex: `\\boldsymbol{${ch}}`, isMath: true };
  }
  // Script / Calligraphic A-Z
  if (cp >= 0x1d49c && cp <= 0x1d4b5) {
    const ch = String.fromCharCode(0x41 + (cp - 0x1d49c));
    return { uni: ch, tex: `\\mathcal{${ch}}`, isMath: true };
  }
  if (cp >= 0x1d4d0 && cp <= 0x1d4e9) {
    const ch = String.fromCharCode(0x41 + (cp - 0x1d4d0));
    return { uni: ch, tex: `\\mathcal{${ch}}`, isMath: true };
  }
  // Fraktur A-Z / a-z
  if (cp >= 0x1d504 && cp <= 0x1d51d) {
    const ch = String.fromCharCode(0x41 + (cp - 0x1d504));
    return { uni: ch, tex: `\\mathfrak{${ch}}`, isMath: true };
  }
  if (cp >= 0x1d51e && cp <= 0x1d537) {
    const ch = String.fromCharCode(0x61 + (cp - 0x1d51e));
    return { uni: ch, tex: `\\mathfrak{${ch}}`, isMath: true };
  }
  // Double-struck (Blackboard bold) A-Z / 0-9
  if (cp >= 0x1d538 && cp <= 0x1d551) {
    const ch = String.fromCharCode(0x41 + (cp - 0x1d538));
    return { uni: ch, tex: `\\mathbb{${ch}}`, isMath: true };
  }
  if (cp >= 0x1d7d8 && cp <= 0x1d7e1) {
    const ch = String.fromCharCode(0x30 + (cp - 0x1d7d8));
    return { uni: ch, tex: `\\mathbb{${ch}}`, isMath: true };
  }
  // Bold digits 0-9
  if (cp >= 0x1d7ce && cp <= 0x1d7d7) {
    const ch = String.fromCharCode(0x30 + (cp - 0x1d7ce));
    return { uni: ch, tex: `\\mathbf{${ch}}`, isMath: true };
  }
  // Mathematical Greek blocks (U+1D6A8..U+1D7CB): map modulo Greek alphabet
  const greekUpper = ['Γ', 'Δ', 'Θ', 'Λ', 'Ξ', 'Π', 'Σ', 'Υ', 'Φ', 'Ψ', 'Ω'];
  const greekLower = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ξ', 'ο', 'π', 'ρ', 'ς', 'σ', 'τ', 'υ', 'φ', 'χ', 'ψ', 'ω', '∂', 'ϵ', 'ϑ', 'ϰ', 'ϕ', 'ϱ', 'ϖ'];
  for (const base of [0x1d6a8, 0x1d6e2, 0x1d71c, 0x1d756, 0x1d790]) {
    if (cp >= base + 26 && cp < base + 26 + greekLower.length) {
      const g = greekLower[cp - (base + 26)];
      return { uni: g, tex: UNICODE_MATH_TO_LATEX[g] || g, isMath: true };
    }
    if (cp >= base && cp <= base + 25) {
      const idx = cp - base;
      const upperMap: Record<number, string> = { 2: 'Γ', 3: 'Δ', 7: 'Θ', 10: 'Λ', 13: 'Ξ', 15: 'Π', 17: 'Σ', 19: 'Υ', 20: 'Φ', 22: 'Ψ', 23: 'Ω' };
      const g = upperMap[idx];
      if (g) return { uni: g, tex: UNICODE_MATH_TO_LATEX[g] || g, isMath: true };
    }
  }
  return null;
}

/** Classify font family name into a semantic FontRole */
export function classifyFontFamily(realFontName: string): {
  role: FontRole;
  isItalic: boolean;
  isBold: boolean;
} {
  const clean = stripSubsetPrefix(realFontName);
  const up = clean.toUpperCase();

  const isBold = /(?:BOLD|CMBX|CMMIB|CMBSY|BX|BD|HEAVY|BLACK|-B\b)/i.test(clean);
  const isItalic = /(?:ITALIC|OBLIQUE|SLANT|CMMI|CMTI|CMSL|MTMI|EURM|-IT\b|MATHITALIC)/i.test(clean);

  // 1. TeX / OpenType Math Extension (big ops, tall delimiters, radicals)
  if (/^(?:CMEX|LMEX|LMMATHEXTENSION|EUEX|MTEX|TXEX|PXEX|STIXSIZE|MATHDESIGN.*EX)/i.test(up)) {
    return { role: 'math-ext', isItalic: false, isBold };
  }
  // 2. Blackboard bold / AMS symbols (`MSBM`, `MSAM`, `BBOLD`, `DSROM`)
  if (/^(?:MSBM|BBOLD|BBM|DSROM|EUSB)/i.test(up)) {
    return { role: 'math-bb', isItalic: false, isBold };
  }
  // 3. Calligraphic / Euler Script (`EUSM`, `RSFS`, `CALLIG`)
  if (/^(?:EUSM|RSFS|CMSY.*CAL)/i.test(up)) {
    return { role: 'math-cal', isItalic: true, isBold };
  }
  // 4. Fraktur (`EUFM`, `EUFB`)
  if (/^(?:EUFM|EUFB)/i.test(up)) {
    return { role: 'math-frak', isItalic: false, isBold };
  }
  // 5. Math Symbols (`CMSY`, `CMBSY`, `MSAM`, `LMMathSymbols`, `MTSYN`, `Symbol`, `TXSY`, `PXSY`, `CambriaMath`)
  if (
    /^(?:CMSY|CMBSY|MSAM|LMSY|LMMATHSYMBOLS|MTSYN|TXSY|PXSY|SYMBOL|STANDARD\s*SYMBOLS)/i.test(up) ||
    /(?:CAMBRIAMATH|STIXMATH|XITSMATH|ASANA-MATH|LATINMODERN-MATH|TEXGYRE.*MATH)/i.test(up)
  ) {
    return { role: 'math-symbol', isItalic, isBold };
  }
  // 6. Math Italic (`CMMI`, `CMMIB`, `LMMathItalic`, `MTMI`, `EURM`, `EUBM`, `TXMI`, `PXMI`)
  if (/^(?:CMMI|CMMIB|LMMI|LMMATHITALIC|MTMI|EURM|EUBM|TXMI|PXMI)/i.test(up)) {
    return { role: 'math-italic', isItalic: true, isBold };
  }
  // 7. CJK fonts (SimSun, SimHei, KaiTi, FangSong, Songti, SourceHan, NotoSansCJK, Fandol, STSong)
  if (/(?:SIMSUN|SIMHEI|KAITI|FANGSONG|SONGTI|HEITI|YAHEI|SOURCEHAN|NOTO.*CJK|NOTO.*SC|FANDOL|STSONG|STHEITI|DFKAI|MINGLIU|GOTHIC|MINCHO|^FZ)/i.test(up)) {
    return { role: 'cjk', isItalic, isBold };
  }
  // 8. Monospace (`CMTT`, `Courier`, `Consolas`, `Inconsolata`, `Menlo`, `Monaco`)
  if (/^(?:CMTT|LMTT|ECTT)|(?:COURIER|CONSOLAS|INCONSOLATA|MENLO|MONACO|FIRA\s*CODE|JETBRAINS\s*MONO|MONOSPACE)/i.test(up)) {
    return { role: 'mono', isItalic, isBold };
  }
  // 9. Sans-serif (`CMSS`, `Arial`, `Helvetica`, `Calibri`, `Roboto`, `NimbusSan`)
  if (/^(?:CMSS|LMSS|ECSS)|(?:ARIAL|HELVETICA|CALIBRI|ROBOTO|NIMBUSSAN|UNIVERS|FRUTIGER|GILL\s*SANS|VERDANA|TAHOMA)/i.test(up)) {
    return { role: 'body-sans', isItalic, isBold };
  }
  // 10. Body Serif (`CMR`, `CMTI`, `CMBX`, `Times`, `NimbusRom`, `Palatino`, `Garamond`, `Georgia`, `STIXGeneral`)
  if (/^(?:CMR|CMTI|CMBX|CMSL|LMR|ECTI|ECRM|ECBX)|(?:TIMES|NIMBUSROM|PALATINO|GARAMOND|GEORGIA|CHARTER|UTOPIA|MINION|CENTURY|BOOKMAN|BASKERVILLE)/i.test(up)) {
    return { role: 'body-serif', isItalic, isBold };
  }

  return { role: 'unknown', isItalic, isBold };
}

/**
 * Decode a single raw string from a PDF text item according to its classified FontRole
 * and real font name, returning clean readable Unicode + LaTeX + semantic flags.
 */
export function decodeGlyphString(
  rawStr: string,
  roleOrFontName: FontRole | string,
  realFontNameArg?: string,
  isBoldArg?: boolean
): {
  text: string;
  latex: string;
  isDelimiterExt: boolean;
  isBigOp: boolean;
  isTallDelim: boolean;
  isAccent: boolean;
  isRadicalSign: boolean;
  hasMathSymbol: boolean;
} {
  if (!rawStr) {
    return {
      text: '',
      latex: '',
      isDelimiterExt: false,
      isBigOp: false,
      isTallDelim: false,
      isAccent: false,
      isRadicalSign: false,
      hasMathSymbol: false,
    };
  }

  let role: FontRole;
  let realFontName: string;
  let isBold: boolean;
  if (realFontNameArg === undefined) {
    realFontName = String(roleOrFontName || '');
    const classified = classifyFontFamily(realFontName);
    role = classified.role;
    isBold = isBoldArg ?? classified.isBold;
  } else {
    role = roleOrFontName as FontRole;
    realFontName = realFontNameArg;
    isBold = Boolean(isBoldArg);
  }

  const cleanFont = stripSubsetPrefix(realFontName).toUpperCase();
  const isOmlFont = role === 'math-italic' && /^(?:CMMI|LMMI|LMMATHITALIC|MTMI|EURM|EUBM|TXMI|PXMI)/.test(cleanFont);
  const isOmsFont = role === 'math-symbol' && /^(?:CMSY|CMBSY|LMSY|LMMATHSYMBOLS|MTSYN|TXSY|PXSY)/.test(cleanFont);
  const isAdobeSymbolFont = /^(?:SYMBOL|SYMBOLMT|STANDARD\s*SYMBOLS\s*L|PSYMBOL)$/.test(cleanFont);
  const isOmxFont = role === 'math-ext';
  const isOt1Font = /^(?:CMR|CMBX|CMTI|CMSL|CMSS|CMTT)\d/.test(cleanFont);

  let outText = '';
  let outLatex = '';
  let allDelimExt = true;
  let anyChar = false;
  let isBigOp = false;
  let isTallDelim = false;
  let isAccent = false;
  let isRadicalSign = false;
  let hasMathSymbol = false;

  for (const ch of Array.from(rawStr)) {
    anyChar = true;
    // 0. ASCII whitespace must NEVER be looked up in TeX encoding tables (0x20 != \psi, 0x20 != \leftarrow)!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      outText += ' ';
      outLatex += ' ';
      allDelimExt = false;
      continue;
    }

    let cp = ch.codePointAt(0) ?? 0;

    // Private Use Area U+F000..U+F0FF (commonly Symbol/TeX shifted by +0xF000 in Windows/Word PDFs)
    const wasPua = cp >= 0xf000 && cp <= 0xf0ff;
    if (wasPua) {
      cp = cp - 0xf000;
    }

    // 1. Standard ligatures
    if (STANDARD_LIGATURES[ch]) {
      const lig = STANDARD_LIGATURES[ch];
      outText += lig;
      outLatex += lig;
      allDelimExt = false;
      continue;
    }

    // 2. Unicode Mathematical Alphanumerics (U+1D400..U+1D7FF)
    const mathAlnum = decodeUnicodeMathAlnum(cp);
    if (mathAlnum) {
      outText += mathAlnum.uni;
      outLatex += mathAlnum.tex + ' ';
      hasMathSymbol = true;
      allDelimExt = false;
      continue;
    }

    // 3. OMX (`CMEX*`) tall delimiters, extenders, radicals, and big ops
    if (isOmxFont && OMX_SLOTS[cp]) {
      const entry = OMX_SLOTS[cp];
      if (entry.delimExt && !entry.uni) {
        // Pure extension piece: keep allDelimExt = true if entire item is extenders
        continue;
      }
      allDelimExt = false;
      outText += entry.uni;
      outLatex += entry.tex + (entry.tex.startsWith('\\') ? ' ' : '');
      if (entry.bigOp) isBigOp = true;
      if (entry.delim) isTallDelim = true;
      if (entry.radical) isRadicalSign = true;
      if (entry.accent) isAccent = true;
      hasMathSymbol = true;
      continue;
    }

    // 4. OMS (`CMSY*`) math symbols & `\mathcal{A..Z}`
    if (isOmsFont) {
      if (cp >= 0x41 && cp <= 0x5a) {
        const letter = String.fromCharCode(cp);
        outText += letter;
        outLatex += `\\mathcal{${letter}} `;
        hasMathSymbol = true;
        allDelimExt = false;
        continue;
      }
      if (OMS_SLOTS[cp]) {
        const [uni, tex] = OMS_SLOTS[cp];
        outText += uni;
        outLatex += tex + (tex.startsWith('\\') ? ' ' : '');
        if (uni === '√') isRadicalSign = true;
        if (uni === '∫') isBigOp = true;
        hasMathSymbol = true;
        allDelimExt = false;
        continue;
      }
    }

    // 5. OML (`CMMI*`) low control slots (0x00..0x27) & special slots when not already decoded to Unicode Greek
    if (isOmlFont && (cp <= 0x27 || wasPua) && OML_LOW_SLOTS[cp]) {
      const [uni, tex] = OML_LOW_SLOTS[cp];
      outText += uni;
      outLatex += (isBold && tex.startsWith('\\') ? `\\boldsymbol{${tex}}` : tex) + ' ';
      hasMathSymbol = true;
      allDelimExt = false;
      continue;
    }

    // 6. OT1 (`CMR*`) low control slots (0x00..0x1F)
    if (isOt1Font && cp <= 0x1f && OT1_LOW_SLOTS[cp]) {
      const [uni, tex] = OT1_LOW_SLOTS[cp];
      outText += uni;
      outLatex += tex + (tex.startsWith('\\') ? ' ' : '');
      if (cp <= 0x0a) hasMathSymbol = true;
      allDelimExt = false;
      continue;
    }

    // 7. Blackboard bold (`MSBM*`) uppercase A-Z
    if (role === 'math-bb' && cp >= 0x41 && cp <= 0x5a) {
      const letter = String.fromCharCode(cp);
      outText += BMP_MATHBB_CHARS[letter] || letter;
      outLatex += `\\mathbb{${letter}} `;
      hasMathSymbol = true;
      allDelimExt = false;
      continue;
    }

    // 7.5. Adobe Symbol / SymbolMT / Word & WPS PUA (`U+F000..U+F0FF`)
    if ((isAdobeSymbolFont || (wasPua && !isOmlFont && !isOmsFont && !isOmxFont)) && ADOBE_SYMBOL_SLOTS[cp]) {
      const sym = ADOBE_SYMBOL_SLOTS[cp];
      if (sym.delimExt && !sym.uni) {
        continue;
      }
      outText += sym.uni;
      outLatex += sym.tex + (sym.tex.startsWith('\\') ? ' ' : '');
      if (sym.bigOp) isBigOp = true;
      if (sym.radical) isRadicalSign = true;
      hasMathSymbol = true;
      allDelimExt = false;
      continue;
    }

    // 8. Calligraphic (`EUSM*`, `RSFS*`) uppercase A-Z
    if (role === 'math-cal' && cp >= 0x41 && cp <= 0x5a) {
      const letter = String.fromCharCode(cp);
      outText += letter;
      outLatex += `\\mathcal{${letter}} `;
      hasMathSymbol = true;
      allDelimExt = false;
      continue;
    }

    // 9. Residual control characters (`U+0000..U+001F`, `U+007F..U+009F`):
    // Even if font name was unknown/subsetted, rescue well-known TeX control slots (e.g. U+000F -> ε)
    // and strip unprintable control garbage so `ctrl-glyph` is 0!
    if ((cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) {
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
        outText += ' ';
        outLatex += ' ';
        allDelimExt = false;
        continue;
      }
      // Rescue well-known TeX CMMIB epsilon (U+000F)
      if (cp === 0x0f) {
        outText += 'ϵ';
        outLatex += isBold ? '\\boldsymbol{\\epsilon} ' : '\\epsilon ';
        hasMathSymbol = true;
        allDelimExt = false;
        continue;
      }
      // Rescue CMEX tall delimiters if font is math-ext
      if (isOmxFont && OMX_SLOTS[cp]) {
        const entry = OMX_SLOTS[cp];
        if (entry.delimExt && !entry.uni) continue;
        allDelimExt = false;
        outText += entry.uni;
        outLatex += entry.tex + (entry.tex.startsWith('\\') ? ' ' : '');
        if (entry.delim) isTallDelim = true;
        hasMathSymbol = true;
        continue;
      }
      if (isOmlFont && OML_LOW_SLOTS[cp]) {
        const [uni, tex] = OML_LOW_SLOTS[cp];
        outText += uni;
        outLatex += (isBold && tex.startsWith('\\') ? `\\boldsymbol{${tex}}` : tex) + ' ';
        hasMathSymbol = true;
        allDelimExt = false;
        continue;
      }
      // Unmapped raw control code -> drop cleanly instead of leaving invisible garbage
      continue;
    }

    // 10. Known Unicode math / Greek / operator symbol
    const effChar = wasPua ? String.fromCodePoint(cp) : ch;
    if (BIG_OP_CHARS.has(effChar)) isBigOp = true;
    if (ACCENT_CHARS.has(effChar)) isAccent = true;
    if (effChar === '√') isRadicalSign = true;

    if (UNICODE_MATH_TO_LATEX[effChar]) {
      const tex = UNICODE_MATH_TO_LATEX[effChar];
      outText += effChar;
      outLatex += tex + (tex.startsWith('\\') ? ' ' : '');
      hasMathSymbol = true;
      allDelimExt = false;
      continue;
    }

    // 11. Regular printable character
    outText += effChar;
    if (isBold && role === 'math-italic' && /[A-Za-z]/.test(effChar)) {
      outLatex += `\\boldsymbol{${effChar}} `;
    } else if (effChar === '%' || effChar === '#' || effChar === '&' || effChar === '_') {
      outLatex += `\\${effChar}`;
    } else {
      outLatex += effChar;
    }
    allDelimExt = false;
  }

  return {
    text: outText,
    latex: outLatex.replace(/\s+/g, ' ').trim(),
    isDelimiterExt: anyChar && allDelimExt,
    isBigOp,
    isTallDelim,
    isAccent,
    isRadicalSign,
    hasMathSymbol,
  };
}

/**
 * Decode all PDF.js `textContent.items` on a page into normalized `DecodedGlyphItem[]`
 * with whole-page statistical body-font calibration.
 */
export function decodePageGlyphs(
  items: PdfTextItemLike[],
  fontNameResolver: (fontKey: string) => string,
  defaultBodySize = 10
): {
  glyphs: DecodedGlyphItem[];
  bodyFontSize: number;
  dominantBodyFont: string;
} {
  if (!Array.isArray(items) || items.length === 0) {
    return { glyphs: [], bodyFontSize: defaultBodySize, dominantBodyFont: '' };
  }

  // First pass: estimate dominant body font & bodyFontSize weighted by printable character count
  const fontCharCounts = new Map<string, number>();
  const sizeHist = new Map<number, number>();

  for (const it of items) {
    const s = String(it?.str || '').trim();
    if (s.length < 3 || !Array.isArray(it?.transform)) continue;
    const fs = Math.hypot(Number(it.transform[2]) || 0, Number(it.transform[3]) || 0) || Number(it.height) || 10;
    if (fs >= 6 && fs <= 18) {
      const bucket = Math.round(fs * 2) / 2;
      sizeHist.set(bucket, (sizeHist.get(bucket) || 0) + s.length);
    }
    const fk = String(it.fontName || '');
    const real = stripSubsetPrefix(fontNameResolver(fk) || fk);
    if (/[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}/.test(s)) {
      fontCharCounts.set(real, (fontCharCounts.get(real) || 0) + s.length);
    }
  }

  let bodyFontSize = defaultBodySize;
  let maxSizeCount = 0;
  sizeHist.forEach((cnt, sz) => {
    if (cnt > maxSizeCount) {
      maxSizeCount = cnt;
      bodyFontSize = sz;
    }
  });
  bodyFontSize = Math.max(7, Math.min(14, bodyFontSize));

  let dominantBodyFont = '';
  let maxFontCount = 0;
  fontCharCounts.forEach((cnt, fn) => {
    if (cnt > maxFontCount) {
      maxFontCount = cnt;
      dominantBodyFont = fn;
    }
  });

  // Second pass: decode every item with calibrated font semantics
  const glyphs: DecodedGlyphItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const tr = Array.isArray(it?.transform) ? it.transform : [10, 0, 0, 10, 0, 0];
    const a = Number(tr[0]) || 0;
    const b = Number(tr[1]) || 0;
    const c = Number(tr[2]) || 0;
    const d = Number(tr[3]) || 0;
    const x = Number(tr[4]) || 0;
    const y = Number(tr[5]) || 0;

    const fontSize = Math.hypot(c, d) || Math.hypot(a, b) || Number(it?.height) || bodyFontSize;
    const isRotated = Math.abs(b) > Math.abs(a) * 0.45 && Math.abs(c) > Math.abs(d) * 0.45;
    const fontKey = String(it?.fontName || '');
    const realFontName = fontNameResolver(fontKey) || fontKey;
    const cleanReal = stripSubsetPrefix(realFontName);
    const rawStr = String(it?.str ?? '');
    const rawChars = Array.from(rawStr);
    const { role, isItalic, isBold } = classifyFontFamily(realFontName);

    // Multi-character delimiter unpacker:
    // In TeX/PDF output, compound delimiters like `])` or `))` may appear in a single show-text item in CMEX.
    // Each delimiter symbol must be an individual addressable glyph with its own geometry.
    if (rawChars.length > 1 && (role === 'math-ext' || (role === 'math-symbol' && /^[()\[\]|{}⟨⟩⌊⌋⌈⌉]+$/.test(rawStr.trim())))) {
      const weights = rawChars.map((ch) => {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp === 0x14 || cp === 0x15 || cp === 0x02 || cp === 0x03) return 0.528;
        if (cp === 0x12 || cp === 0x13 || cp === 0x00 || cp === 0x01) return 0.736;
        if (cp === 0x1a || cp === 0x1b || cp === 0x08 || cp === 0x09) return 0.75;
        return 0.6;
      });
      const sumWeights = weights.reduce((sum, w) => sum + w, 0) || 1;
      const itemTotalW = Math.max(0, Number(it?.width) || (rawChars.length * fontSize * 0.48));
      let curX = x;

      for (let ci = 0; ci < rawChars.length; ci++) {
        const ch = rawChars[ci];
        const charW = itemTotalW * (weights[ci] / sumWeights);
        const dec = decodeGlyphString(ch, role, realFontName, isBold);
        const charAscent = dec.isTallDelim || dec.isBigOp ? Math.max(fontSize * 0.85, fontSize * 0.9) : fontSize * 0.82;
        const charDescent = dec.isTallDelim || dec.isBigOp ? Math.max(fontSize * 0.55, fontSize * 0.35) : fontSize * 0.24;

        glyphs.push({
          index: i,
          rawStr: ch,
          text: dec.text,
          latex: dec.latex,
          fontKey,
          realFontName,
          fontRole: role,
          isItalic,
          isBold,
          isRotated,
          isMathFont: true,
          isMathToken: true,
          isBigOp: dec.isBigOp,
          isDelimiterExt: dec.isDelimiterExt,
          isTallDelim: dec.isTallDelim,
          isAccent: dec.isAccent,
          isRadicalSign: dec.isRadicalSign,
          x: curX,
          y,
          w: charW,
          h: Math.max(fontSize * 0.85, Number(it?.height) || fontSize),
          fontSize,
          top: y + charAscent,
          bottom: y - charDescent,
          right: curX + charW,
        });
        curX += charW;
      }
      continue;
    }

    // Multi-token operator word unpacker (e.g. `) = min` or `= 2 max` or `, max`):
    // In TeX/PDF output, operator words like `min` or `max` in Roman font may get merged with preceding punctuation `= `
    const wordOpMatch = /^([^\w]*(?:[=()\[\],;:]\s*|\s+))(max|min|argmin|argmax|sup|inf|lim)\b(.*)$/i.exec(rawStr);
    if (wordOpMatch && (role === 'body-serif' || role === 'math-symbol' || role === 'unknown')) {
      const prefix = wordOpMatch[1];
      const opWord = wordOpMatch[2];
      const suffix = wordOpMatch[3];
      const parts = [prefix, opWord];
      if (suffix) parts.push(suffix);

      const totalLen = rawStr.length || 1;
      const totalW = Math.max(0, Number(it?.width) || (totalLen * fontSize * 0.48));
      let curX = x;

      for (let pi = 0; pi < parts.length; pi++) {
        const pStr = parts[pi];
        const pW = totalW * (pStr.length / totalLen);
        const dec = decodeGlyphString(pStr, role, realFontName, isBold);
        const isOp = pi === 1;
        glyphs.push({
          index: i,
          rawStr: pStr,
          text: dec.text,
          latex: isOp ? `\\${opWord.toLowerCase()}` : dec.latex,
          fontKey,
          realFontName,
          fontRole: role,
          isItalic,
          isBold,
          isRotated,
          isMathFont: isOp ? true : role === 'math-symbol',
          isMathToken: isOp ? true : dec.hasMathSymbol,
          isBigOp: false,
          isDelimiterExt: false,
          isTallDelim: false,
          isAccent: false,
          isRadicalSign: false,
          x: curX,
          y,
          w: pW,
          h: Math.max(fontSize * 0.85, Number(it?.height) || fontSize),
          fontSize,
          top: y + fontSize * 0.82,
          bottom: y - fontSize * 0.24,
          right: curX + pW,
        });
        curX += pW;
      }
      continue;
    }

    const decoded = decodeGlyphString(rawStr, role, realFontName, isBold);

    const isDedicatedMathRole =
      role === 'math-italic' ||
      role === 'math-symbol' ||
      role === 'math-ext' ||
      role === 'math-bb' ||
      role === 'math-cal' ||
      role === 'math-frak';

    // Handle non-TeX papers (Times-Italic single-letter / short math variables when body font is upright)
    const trimmed = decoded.text.trim();
    const isShortItalicVar =
      !isDedicatedMathRole &&
      isItalic &&
      cleanReal !== dominantBodyFont &&
      /^[A-Za-z](?:[0-9]|'[0-9]?)?$/.test(trimmed);

    const isMathFont = isDedicatedMathRole || isShortItalicVar;
    const isMathToken =
      isMathFont ||
      decoded.hasMathSymbol ||
      decoded.isBigOp ||
      decoded.isTallDelim ||
      decoded.isRadicalSign ||
      /^[=+\-−×÷±∓≤≥≠≈≡∼∝∈∉⊂⊃⊆⊇∪∩⊕⊗⊥⊤∥∑∏∫√∂∇]+$/.test(trimmed);

    const w = Math.max(0, Number(it?.width) || (trimmed.length * fontSize * 0.48));
    const h = Math.max(fontSize * 0.85, Number(it?.height) || fontSize);
    // Tall delimiters / big ops in CMEX often place baseline near top or middle; compute safe top/bottom
    const ascent = decoded.isTallDelim || decoded.isBigOp ? Math.max(h * 0.85, fontSize * 0.9) : h * 0.82;
    const descent = decoded.isTallDelim || decoded.isBigOp ? Math.max(h * 0.55, fontSize * 0.35) : h * 0.24;

    glyphs.push({
      index: i,
      rawStr: String(it?.str ?? ''),
      text: decoded.text,
      latex: decoded.latex,
      fontKey,
      realFontName,
      fontRole: role,
      isItalic,
      isBold,
      isRotated,
      isMathFont,
      isMathToken,
      isBigOp: decoded.isBigOp,
      isDelimiterExt: decoded.isDelimiterExt,
      isTallDelim: decoded.isTallDelim,
      isAccent: decoded.isAccent,
      isRadicalSign: decoded.isRadicalSign,
      x,
      y,
      w,
      h,
      fontSize,
      top: y + ascent,
      bottom: y - descent,
      right: x + w,
    });
  }

  return { glyphs, bodyFontSize, dominantBodyFont };
}
