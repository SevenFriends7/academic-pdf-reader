const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const diagBundlePath = path.join(ROOT, 'scratch', '.build-v2', 'diagEngine.cjs');
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'scratch', 'diag_p4_detail.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['pdfjs-dist', 'canvas'],
  outfile: diagBundlePath,
  logLevel: 'error',
});
require(diagBundlePath);
