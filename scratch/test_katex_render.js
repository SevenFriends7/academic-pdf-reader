const path = require('path');
const katex = require('../media/katex/katex.min.js');

const latexes = [
  `(x, y, w, h, \\theta) = f (I) \\qquad (1)`,
  `\\{ \\mu = [x_{c} y_{c}], \\Sigma = R \\begin{bmatrix} w/ 2 & 0 \\\\ 0 & h/ 2 \\end{bmatrix}^{2} R^{\\top} \\} \\qquad (2)`,
  `R = \\begin{bmatrix} \\cos \\theta & - \\sin \\theta \\\\ \\sin \\theta & \\cos \\theta \\end{bmatrix} \\qquad (3)`,
  `B (\\mathcal{N}_{1}, \\mathcal{N}_{2}) = \\exp \\begin{pmatrix} - & \\mu^{\\top} \\Sigma^{- 1} \\mu \\\\ 1 \\end{pmatrix} \\frac{1}{8} \\cdot \\frac{| \\Sigma_{1} |^{1 / 4} | \\Sigma_{2} |^{1 / 4}}{| \\Sigma |^{1 / 2}} \\qquad (4)`,
  `M_{i,j} = B (\\mathcal{N}_{i}, \\mathcal{N}_{j}) \\qquad (5)`,
  `\\mathcal{L}_{O} = \\frac{1}{N} \\sum_{i ̸ = j} (M_{i,j}) \\qquad (6)`,
  `V = \\mathrm{Voronoi} (X) \\qquad (7)`,
  `S = \\mathrm{Watershed} (I, X, V) \\qquad (8)`
];

latexes.forEach((lx, i) => {
  try {
    katex.renderToString(lx, { displayMode: true, throwOnError: true });
    console.log(`Eq ${i + 1}: KaTeX SUCCESS`);
  } catch (err) {
    console.error(`Eq ${i + 1}: KaTeX FAILED:`, err.message);
  }
});
