/**
 * 打包脚本的 **wasm 回退**版本。
 *
 * ## 为什么需要它
 *
 * `esbuild` 的原生二进制在某些 Windows 环境里起不来（实测：`fatal error: winmm.dll not found
 * / runtime: panic before malloc heap initialized`）。这不是代码问题，是那个 .exe 在
 * 特定 PATH / 系统 DLL 组合下加载失败；同一台机器上 `node`、`tsc` 都好好的。
 * 没有回退时，开发者只能"改了代码但打不出包"，而且报错信息完全指不到问题所在。
 *
 * `esbuild-wasm` 是同一个编译器编译成 WebAssembly，不依赖任何系统 DLL，只慢一点
 * （2.4 秒 vs 0.2 秒，对本地开发完全够用）。
 *
 * 用法：
 *   node esbuild-wasm.js            # 不压缩，同 npm run compile
 *   node esbuild-wasm.js --minify   # 压缩，同 npm run vsix 之前那一步
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
  // Node 环境下不要传 wasmURL（那是浏览器专用），默认会加载包内的 esbuild.wasm
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
  console.log('[build] Extension build complete (wasm).');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
