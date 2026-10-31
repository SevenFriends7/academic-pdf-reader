/**
 * 打包脚本的 **wasm 回退**版本。
 */
const path = require('path');
const fs = require('fs');

const minify = process.argv.includes('--minify') || process.env.ESBUILD_MINIFY === '1';

function copyPdfJsAssets() {
  const targetDir = path.join(__dirname, 'media', 'pdfjs');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const pdfjsDistDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build');
  if (!fs.existsSync(pdfjsDistDir)) return;
  for (const file of ['pdf.min.js', 'pdf.worker.min.js', 'pdf.worker.min.mjs']) {
    const src = path.join(pdfjsDistDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(targetDir, file));
      console.log(`[build] Copied ${file} to media/pdfjs/`);
    }
  }
}

async function main() {
  let esbuild;
  try {
    esbuild = require('esbuild-wasm');
  } catch {
    console.error('[build] 缺少 esbuild-wasm。先执行：npm install --no-save esbuild-wasm');
    process.exit(1);
  }
  copyPdfJsAssets();
  await esbuild.initialize({});

  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
    bundle: true,
    format: 'cjs',
    minify,
    sourcemap: true,
    sourcesContent: false,
    platform: 'node',
    outfile: path.join(__dirname, 'dist', 'extension.js'),
    charset: 'utf8',
    external: ['vscode'],
    logLevel: 'info'
  });
  if (result.errors.length) {
    console.error('[build] 失败：', result.errors);
    process.exit(1);
  }

  const webviewEntry = path.join(__dirname, 'src', 'webview', 'v2EngineBundle.ts');
  if (fs.existsSync(webviewEntry)) {
    const wvResult = await esbuild.build({
      entryPoints: [webviewEntry],
      bundle: true,
      format: 'iife',
      target: ['es2020'],
      minify,
      sourcemap: true,
      sourcesContent: false,
      platform: 'browser',
      outfile: path.join(__dirname, 'media', 'v2-engine.js'),
      charset: 'utf8',
      logLevel: 'info'
    });
    if (wvResult.errors.length) {
      console.error('[build] Webview 失败：', wvResult.errors);
      process.exit(1);
    }
  }
  console.log('[build] Extension + Webview v2 engine build complete (wasm).');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
