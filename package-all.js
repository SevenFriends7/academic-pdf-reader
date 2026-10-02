const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 1. 重新打包 VSIX
console.log('=== 步骤 1: 重新打包扩展 VSIX ===');
require('./package-vsix.js');

const rootDir = __dirname;
const parentDir = path.dirname(rootDir);
const vsixName = 'academic-pdf-reader-0.1.0.vsix';
const vsixPath = path.join(rootDir, vsixName);
const vsixParentPath = path.join(parentDir, vsixName);
const zipPath = path.join(parentDir, 'academic-pdf-reader.zip');

// 2. 拷贝 VSIX 到根目录方便直接安装
console.log('=== 步骤 2: 拷贝 VSIX 到上级目录 ===');
fs.copyFileSync(vsixPath, vsixParentPath);
console.log(`已同步 VSIX 到: ${vsixParentPath}`);

// 3. 重新生成源码压缩包 academic-pdf-reader.zip
console.log('=== 步骤 3: 重新压缩源码与依赖包 ===');
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
  console.log('已清理旧的 zip 压缩包');
}

const psCmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${rootDir}', '${zipPath}', [System.IO.Compression.CompressionLevel]::Optimal, $true)"`;
execSync(psCmd, { stdio: 'inherit' });

const statZip = fs.statSync(zipPath);
const statVsix = fs.statSync(vsixPath);

console.log('=== 打包完成 ===');
console.log(`插件安装包 (.vsix): ${vsixPath} (${(statVsix.size / 1024).toFixed(2)} KB)`);
console.log(`插件独立包 (.vsix): ${vsixParentPath}`);
console.log(`源码完整包 (.zip):  ${zipPath} (${(statZip.size / (1024 * 1024)).toFixed(2)} MB)`);
