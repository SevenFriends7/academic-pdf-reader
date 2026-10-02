const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function buildVsix() {
  console.log('[vsix] Starting VSIX package creation...');

  // 1. 确保最新编译
  execSync('node esbuild.js', { stdio: 'inherit' });

  const distDir = path.join(__dirname, 'dist');
  const mediaDir = path.join(__dirname, 'media');
  const tempVsixDir = path.join(__dirname, '.vsix_staging');

  // 清理并创建临时暂存目录
  if (fs.existsSync(tempVsixDir)) {
    fs.rmSync(tempVsixDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempVsixDir, { recursive: true });

  const extDir = path.join(tempVsixDir, 'extension');
  fs.mkdirSync(extDir, { recursive: true });

  // 复制 package.json 与 README
  fs.copyFileSync(path.join(__dirname, 'package.json'), path.join(extDir, 'package.json'));
  if (fs.existsSync(path.join(__dirname, 'README.md'))) {
    fs.copyFileSync(path.join(__dirname, 'README.md'), path.join(extDir, 'README.md'));
  // 商店会展示 CHANGELOG；LICENSE 与第三方声明是发布所需的合规文件
  ['CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'].forEach(f => {
    const src = path.join(__dirname, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extDir, f));
  });
  }

  // 复制 dist
  fs.cpSync(distDir, path.join(extDir, 'dist'), { recursive: true });
  // 源码映射体积大且会暴露源码，发布包里不需要
  fs.rmSync(path.join(extDir, 'dist', 'extension.js.map'), { force: true });

  // 复制 media
  fs.cpSync(mediaDir, path.join(extDir, 'media'), { recursive: true });

  // 生成 [Content_Types].xml
  const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="css" ContentType="text/css"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`;
  fs.writeFileSync(path.join(tempVsixDir, '[Content_Types].xml'), contentTypesXml, 'utf-8');

  // 读取 package.json 获取信息
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

  // 生成 extension.vsixmanifest
  const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Id="${pkg.name}" Version="${pkg.version}" Language="en-US" Publisher="${pkg.publisher || 'academic-tools'}" />
    <DisplayName>${escapeXml(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description || '')}</Description>
    <Categories>Other,Education</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>`;
  fs.writeFileSync(path.join(tempVsixDir, 'extension.vsixmanifest'), vsixManifest, 'utf-8');

  // 【重要】产物刻意命名成 -local.vsix：
  // 本脚本手写 extension.vsixmanifest，本机 IDE 安装不校验，但**扩展市场会严格校验
  // 并报 "Error occurred while parsing the manifest file"**。
  // 要上传到扩展市场/Open VSX，请用官方工具：npm run vsix（vsce package）。
  const vsixOutput = path.join(__dirname, `${pkg.name}-${pkg.version}-local.vsix`);
  if (fs.existsSync(vsixOutput)) {
    fs.unlinkSync(vsixOutput);
  }

  // 使用 PowerShell Zip 打包为 .vsix
  const psCmd = `powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${tempVsixDir}', '${vsixOutput}', [System.IO.Compression.CompressionLevel]::Optimal, $false)"`;
  execSync(psCmd, { stdio: 'inherit' });

  // 清理暂存目录
  fs.rmSync(tempVsixDir, { recursive: true, force: true });

  console.log(`[vsix] 已生成本机安装包: ${vsixOutput}`);
  console.log('[vsix] 注意：仅用于本机安装；上传扩展市场请用 `npm run vsix`');

  // 自动同步安装到当前系统的 Antigravity 与 VS Code 扩展目录
  const os = require('os');
  const userHome = os.homedir();
  const extFolderName = `${pkg.publisher || 'academic-tools'}.${pkg.name}-${pkg.version}`;
  const extRoots = [
    path.join(userHome, '.antigravity-ide', 'extensions'),
    path.join(userHome, '.antigravity', 'extensions'),
    path.join(userHome, '.vscode', 'extensions')
  ];

  // 1) 先通过 CLI 正式安装（这一步才会更新 extensions.json 注册表）
  const cliCommands = [
    `"D:\\Antigravity IDE\\bin\\antigravity-ide.cmd" --install-extension "${vsixOutput}" --force`
  ];
  const codeCli = process.env.VSCODE_CLI || 'code';
  try {
    // VS Code 若存在 CLI 也一并装上，避免旧版残留在其注册表里
    if (process.env.INSTALL_VSCODE === '1') {
      cliCommands.push(`"${codeCli}" --install-extension "${vsixOutput}" --force`);
    }
  } catch (e) {}

  cliCommands.forEach(cmd => {
    try {
      execSync(cmd, { stdio: 'inherit' });
      console.log(`[vsix] Successfully installed via CLI: ${cmd}`);
    } catch (e) {
      console.warn(`[vsix] CLI install notice:`, e.message);
    }
  });

  // 2) 直接同步文件到目标目录（CLI 不覆盖的场景兜底）
  const targetDirs = extRoots.map((root) => path.join(root, extFolderName));
  targetDirs.forEach((targetDir) => {
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.cpSync(distDir, path.join(targetDir, 'dist'), { recursive: true });
  fs.rmSync(path.join(targetDir, 'dist', 'extension.js.map'), { force: true });
      fs.cpSync(mediaDir, path.join(targetDir, 'media'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'package.json'), path.join(targetDir, 'package.json'));
      if (fs.existsSync(path.join(__dirname, 'README.md'))) {
        fs.copyFileSync(path.join(__dirname, 'README.md'), path.join(targetDir, 'README.md'));
  ['CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'].forEach(f => {
    const src = path.join(__dirname, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDir, f));
  });
      }
      console.log(`[vsix] Synced latest build directly to: ${targetDir}`);
    } catch (err) {
      console.warn(`[vsix] Could not sync to ${targetDir}:`, err.message);
    }
  });

  // 3) 清理旧版本目录——但绝不删除 extensions.json 里仍被引用的目录，避免把 IDE 装坏
  const prefix = `${pkg.publisher || 'academic-tools'}.${pkg.name}-`;
  extRoots.forEach((root) => {
    try {
      if (!fs.existsSync(root)) return;
      const registryPath = path.join(root, 'extensions.json');
      let referenced = new Set();
      if (fs.existsSync(registryPath)) {
        try {
          const list = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
          (Array.isArray(list) ? list : []).forEach((it) => {
            const id = it && it.identifier && it.identifier.id;
            const ver = it && it.version;
            if (id === `${pkg.publisher || 'academic-tools'}.${pkg.name}` && ver) {
              referenced.add(`${prefix}${ver}`);
            }
          });
        } catch (e) {}
      }
      fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
        .filter((d) => d.name !== extFolderName && !referenced.has(d.name))
        .forEach((d) => {
          fs.rmSync(path.join(root, d.name), { recursive: true, force: true });
          console.log(`[vsix] Removed stale extension dir: ${d.name}`);
        });
      if (referenced.size > 0) {
        console.log(`[vsix] ${root} 注册表仍引用: ${Array.from(referenced).join(', ')}（保留，不删）`);
      }
    } catch (err) {
      console.warn(`[vsix] Could not clean old dirs in ${root}:`, err.message);
    }
  });
}

function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

buildVsix();
