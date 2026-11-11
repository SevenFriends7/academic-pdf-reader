const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function escapeXml(unsafe) {
  return String(unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

function buildMarketVsix() {
  console.log('[vsix:market] 开始构建 VS Code 扩展商店发布版 VSIX...');

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  const version = pkg.version;
  const pkgName = pkg.name;

  // 1. 确保最新编译（压缩版）
  if (process.env.SKIP_BUILD === '1') {
    console.log('[vsix:market] SKIP_BUILD=1，跳过编译');
  } else {
    try {
      execSync(`"${process.execPath}" esbuild.js --minify`, { stdio: 'inherit' });
    } catch (e) {
      console.warn('[vsix:market] esbuild 原生版未就绪，使用 wasm 版编译…');
      const { spawnSync } = require('child_process');
      const r = spawnSync(process.execPath, [path.join(__dirname, 'esbuild-wasm.js'), '--minify'], {
        cwd: __dirname,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      });
      if (r.status !== 0) {
        throw new Error('wasm 编译失败: ' + (r.stderr || r.stdout));
      }
    }
  }

  const distDir = path.join(__dirname, 'dist');
  const mediaDir = path.join(__dirname, 'media');
  const tempVsixDir = path.join(__dirname, '.vsix_market_staging');

  if (fs.existsSync(tempVsixDir)) {
    fs.rmSync(tempVsixDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempVsixDir, { recursive: true });

  const extDir = path.join(tempVsixDir, 'extension');
  fs.mkdirSync(extDir, { recursive: true });

  // 复制 package.json、README、CHANGELOG、LICENSE、THIRD-PARTY-NOTICES
  fs.copyFileSync(path.join(__dirname, 'package.json'), path.join(extDir, 'package.json'));
  if (fs.existsSync(path.join(__dirname, 'README.md'))) {
    fs.copyFileSync(path.join(__dirname, 'README.md'), path.join(extDir, 'readme.md'));
  }
  if (fs.existsSync(path.join(__dirname, 'CHANGELOG.md'))) {
    fs.copyFileSync(path.join(__dirname, 'CHANGELOG.md'), path.join(extDir, 'changelog.md'));
  }
  if (fs.existsSync(path.join(__dirname, 'LICENSE'))) {
    fs.copyFileSync(path.join(__dirname, 'LICENSE'), path.join(extDir, 'LICENSE.txt'));
  }
  if (fs.existsSync(path.join(__dirname, 'THIRD-PARTY-NOTICES.md'))) {
    fs.copyFileSync(path.join(__dirname, 'THIRD-PARTY-NOTICES.md'), path.join(extDir, 'THIRD-PARTY-NOTICES.md'));
  }

  // 复制 dist
  fs.cpSync(distDir, path.join(extDir, 'dist'), { recursive: true });
  fs.rmSync(path.join(extDir, 'dist', 'extension.js.map'), { force: true });

  // 复制 media
  fs.cpSync(mediaDir, path.join(extDir, 'media'), { recursive: true });
  fs.rmSync(path.join(extDir, 'media', 'v2-engine.js.map'), { force: true });

  // 复制 py（公式 sidecar）
  const pyDir = path.join(__dirname, 'py');
  if (fs.existsSync(pyDir)) {
    fs.cpSync(pyDir, path.join(extDir, 'py'), { recursive: true });
  }

  // 商店规范 [Content_Types].xml
  const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".css" ContentType="text/css"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".py" ContentType="application/octet-stream"/><Default Extension=".ttf" ContentType="font/ttf"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".vsixmanifest" ContentType="text/xml"/><Default Extension=".woff" ContentType="font/woff"/><Default Extension=".woff2" ContentType="font/woff2"/></Types>`;
  fs.writeFileSync(path.join(tempVsixDir, '[Content_Types].xml'), contentTypesXml, 'utf-8');

  // 商店规范 extension.vsixmanifest
  const tags = (pkg.keywords || []).join(',');
  const categories = (pkg.categories || ['Other', 'Education']).join(',');
  const engine = (pkg.engines && pkg.engines.vscode) ? pkg.engines.vscode : '^1.80.0';
  const repoUrl = (pkg.repository && pkg.repository.url) ? pkg.repository.url : '';
  const bugsUrl = (pkg.bugs && pkg.bugs.url) ? pkg.bugs.url : '';
  const homepage = pkg.homepage || '';
  const bannerColor = (pkg.galleryBanner && pkg.galleryBanner.color) ? pkg.galleryBanner.color : '#0b578a';
  const bannerTheme = (pkg.galleryBanner && pkg.galleryBanner.theme) ? pkg.galleryBanner.theme : 'dark';

  const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
\t<Metadata>
\t\t<Identity Language="en-US" Id="${pkgName}" Version="${version}" Publisher="${pkg.publisher || 'paper-reader'}" />
\t\t<DisplayName>${escapeXml(pkg.displayName || pkgName)}</DisplayName>
\t\t<Description xml:space="preserve">${escapeXml(pkg.description || '')}</Description>
\t\t<Tags>${escapeXml(tags)}</Tags>
\t\t<Categories>${escapeXml(categories)}</Categories>
\t\t<GalleryFlags>Public</GalleryFlags>
\t\t
\t\t<Properties>
\t\t\t<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(engine)}" />
\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
\t\t\t<Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
\t\t\t<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
\t\t\t
\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
\t\t\t
\t\t\t<Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${escapeXml(repoUrl)}" />
\t\t\t<Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="${escapeXml(repoUrl)}" />
\t\t\t<Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="${escapeXml(repoUrl)}" />
\t\t\t<Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${escapeXml(bugsUrl)}" />
\t\t\t<Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${escapeXml(homepage)}" />
\t\t\t<Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="${escapeXml(bannerColor)}" />
\t\t\t<Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="${escapeXml(bannerTheme)}" />
\t\t\t<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
\t\t\t<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
\t\t</Properties>
\t\t<License>extension/LICENSE.txt</License>
\t\t<Icon>extension/media/icon.png</Icon>
\t</Metadata>
\t<Installation>
\t\t<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
\t</Installation>
\t<Dependencies/>
\t<Assets>
\t\t<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
\t\t<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
\t\t<Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
\t\t<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
\t\t<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
\t</Assets>
</PackageManifest>`;
  fs.writeFileSync(path.join(tempVsixDir, 'extension.vsixmanifest'), vsixManifest, 'utf-8');

  const vsixFileName = `${pkgName}-${version}.vsix`;
  const vsixOutput = path.join(__dirname, vsixFileName);
  if (fs.existsSync(vsixOutput)) {
    fs.unlinkSync(vsixOutput);
  }

  // 使用 PowerShell Zip 压缩打包为 .vsix
  const psCmd = `powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${tempVsixDir}', '${vsixOutput}', [System.IO.Compression.CompressionLevel]::Optimal, $false)"`;
  execSync(psCmd, { stdio: 'inherit' });

  // 清理暂存目录
  fs.rmSync(tempVsixDir, { recursive: true, force: true });

  console.log(`[vsix:market] ✅ 已成功生成商店标准发布包: ${vsixOutput}`);

  // 同步复制到根交付目录
  const rootDeliveryDir = path.resolve(__dirname, '..');
  const rootTarget = path.join(rootDeliveryDir, vsixFileName);
  fs.copyFileSync(vsixOutput, rootTarget);
  console.log(`[vsix:market] ✅ 已同步复制到交付包根目录: ${rootTarget}`);
}

buildMarketVsix();
