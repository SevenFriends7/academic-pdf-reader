const path = require('path');
const fs = require('fs');

async function run() {
  const { pack } = require('C:/Users/frog/AppData/Local/Temp/opencode/vsce-env/node_modules/@vscode/vsce/out/package.js');
  const projectDir = path.resolve(__dirname, '..');
  const outVsix = path.join(projectDir, 'academic-pdf-reader-2.0.7.vsix');

  console.log(`[PACK] Starting marketplace package for ${projectDir}...`);
  console.log(`[PACK] Output path: ${outVsix}`);

  const result = await pack({
    cwd: projectDir,
    packagePath: outVsix,
    baseContentUrl: 'https://github.com/SevenFriends7/academic-pdf-reader/blob/main/',
    baseImagesUrl: 'https://fastly.jsdelivr.net/gh/SevenFriends7/academic-pdf-reader@main/',
    rewriteRelativeLinks: true,
    dependencies: false,
    useYarn: false,
    allowMissingRepository: true,
    allowPackageAllSecrets: true,
    allowPackageEnvFile: true
  });

  const stat = fs.statSync(result.packagePath);
  console.log(`[PACK SUCCESS] Created: ${result.packagePath}`);
  console.log(`[PACK SUCCESS] Size: ${(stat.size / (1024 * 1024)).toFixed(2)} MB (${stat.size} bytes)`);
  console.log(`[PACK SUCCESS] Packaged files: ${result.files.length}`);

  // Also copy to parent delivery folder for convenience
  const parentVsix = path.resolve(projectDir, '..', 'academic-pdf-reader-2.0.7.vsix');
  fs.copyFileSync(result.packagePath, parentVsix);
  console.log(`[PACK SUCCESS] Copied to parent folder: ${parentVsix}`);
}

run().catch(err => {
  console.error('[PACK ERROR]', err);
  process.exit(1);
});
