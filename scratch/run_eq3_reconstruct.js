const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = __dirname;
const diagBundlePath = path.join(ROOT, '.build-v2', 'test_eq3_reconstruct.cjs');
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'test_eq3_reconstruct.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['pdfjs-dist', 'canvas'],
  outfile: diagBundlePath,
  logLevel: 'error',
});
require(diagBundlePath);
