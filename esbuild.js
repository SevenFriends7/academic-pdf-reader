const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

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

  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: false,
    sourcemap: true,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
  });

  if (watch) {
    console.log('[build] Watching for changes...');
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('[build] Extension build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
