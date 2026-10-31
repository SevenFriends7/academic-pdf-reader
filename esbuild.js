const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
// 打包发布时压缩：pdf-lib + fontkit 未压缩会让 dist 从 175KB 涨到 2.8MB。
// 开发/调试仍走不压缩（npm run compile），保留可读的堆栈与断点体验。
const minify = process.argv.includes('--minify') || process.env.ESBUILD_MINIFY === '1';

// Ensure media/pdfjs directory exists and copy pdfjs assets
function copyPdfJsAssets() {
  const targetDir = path.join(__dirname, 'media', 'pdfjs');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const pdfjsDistDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build');
  if (fs.existsSync(pdfjsDistDir)) {
    const filesToCopy = ['pdf.min.js', 'pdf.worker.min.js', 'pdf.worker.min.mjs'];
    for (const file of filesToCopy) {
      const src = path.join(pdfjsDistDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(targetDir, file));
        console.log(`[build] Copied ${file} to media/pdfjs/`);
      }
    }
  }
}

async function main() {
  copyPdfJsAssets();

  const hostCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify,
    sourcemap: true,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    charset: 'utf8',
    external: ['vscode'],
    logLevel: 'info',
  });

  const webviewEntry = path.join(__dirname, 'src', 'webview', 'v2EngineBundle.ts');
  const webviewCtx = fs.existsSync(webviewEntry)
    ? await esbuild.context({
        entryPoints: ['src/webview/v2EngineBundle.ts'],
        bundle: true,
        format: 'iife',
        target: ['es2020'],
        minify,
        sourcemap: true,
        sourcesContent: false,
        platform: 'browser',
        outfile: 'media/v2-engine.js',
        charset: 'utf8',
        logLevel: 'info',
      })
    : null;

  if (watch) {
    console.log('[build] Watching for changes...');
    await hostCtx.watch();
    if (webviewCtx) await webviewCtx.watch();
  } else {
    await hostCtx.rebuild();
    await hostCtx.dispose();
    if (webviewCtx) {
      await webviewCtx.rebuild();
      await webviewCtx.dispose();
    }
    console.log('[build] Extension + Webview v2 engine build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
