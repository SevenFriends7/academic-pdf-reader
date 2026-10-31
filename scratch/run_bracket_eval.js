const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = __dirname;
const diagBundlePath = path.join(ROOT, '.build-v2', 'test_bracket_eval.cjs');
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'test_bracket_eval.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: diagBundlePath,
  logLevel: 'error',
});
require(diagBundlePath);
