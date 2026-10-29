/**
 * 发版后核对商店实际状态（不依赖浏览器，输出很短）。
 *
 * 用法：node scratch/check_marketplace.js
 *
 * 检查三件事：
 *   1. 商店线上版本号（对比 package.json 的 version）
 *   2. 商店页 HTML 里图标资源路径中的版本号（这是服务端渲染的，最直接）
 *   3. 商店页是否已渲染 README 里的界面截图
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FQN = `${pkg.publisher}.${pkg.name}`;

const get = url =>
  new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'academic-pdf-reader-release-check' } }, res => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', c => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      })
      .on('error', reject);
  });

// 商店页里的截图必须是绝对 HTTPS 地址；HEAD 一下确认 CDN 真的能返回图片。
const head = url =>
  new Promise(resolve => {
    const req = https.request(
      url,
      { method: 'HEAD', headers: { 'User-Agent': 'academic-pdf-reader-release-check' } },
      res => {
        res.resume();
        resolve(res.statusCode || 0);
      }
    );
    req.on('error', () => resolve(0));
    req.setTimeout(30000, () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });

(async () => {
  console.log(`本地 package.json 版本：${pkg.version}`);
  console.log(`扩展标识：${FQN}\n`);

  // 主判据：商店页 HTML 里图标资源路径带的版本号（服务端渲染，最新）
  let pageVersion = null;
  let hasCdnShots = false;
  let hasRelativeShots = false;
  let shotUrls = [];
  let hasBadgeService = false;
  let retiredBadge = false;
  try {
    const r = await get(`https://marketplace.visualstudio.com/items?itemName=${FQN}`);
    pageVersion = (r.body.match(new RegExp(`${pkg.name}/(\\d+\\.\\d+\\.\\d+)/`)) || [])[1] || null;
    const matches = [...r.body.matchAll(/<img[^>]+src="([^"]*(?:reading-highlights|annotations|ai-qa)[^"]*)"/g)];
    shotUrls = [...new Set(matches.map(m => m[1].replace(/&amp;/g, '&')))];
    hasCdnShots = shotUrls.some(u => /^https:\/\//.test(u));
    hasRelativeShots = shotUrls.some(u => !/^https?:\/\//.test(u));
    hasBadgeService = /vsmarketplacebadges\.dev/.test(r.body);
    retiredBadge = /img\.shields\.io\/visual-studio-marketplace/.test(r.body);
  } catch (e) {
    console.log(`商店页查询失败：${e.message}`);
  }

  const pageOk = pageVersion === pkg.version;
  console.log(`1) 商店页版本（主判据，服务端渲染）：${pageVersion || '未解析到'}   ${pageOk ? '✅ 与本地一致' : '⏳ 尚未生效'}`);
  console.log(`2) 页面已渲染界面截图（CDN 绝对地址）：${hasCdnShots ? '✅ 是' : '❌ 否'}`);
  console.log(`   截图仍用相对路径（商店页会 404）：${hasRelativeShots ? '❌ 是' : '✅ 否'}`);
  if (shotUrls.length === 0) {
    console.log('   （未解析到截图 URL）');
  }
  for (const u of shotUrls.filter(u => /^https:\/\//.test(u)).slice(0, 3)) {
    const status = await head(u);
    console.log(`   ${status === 200 ? '✅' : '❌'} HTTP ${status || 'ERR'} ${u}`);
  }
  console.log(`3) 徽章已换成 vsmarketplacebadges.dev：${hasBadgeService ? '✅' : '❌ 否（尚未生效）'}`);
  console.log(`   仍在使用已停用的 shields 市场徽章：${retiredBadge ? '❌ 是' : '✅ 否'}`);

  // 参考项：第三方徽章服务有缓存延迟（实测过：页面已换版它仍报旧版本），只能当粗略参考
  try {
    const r = await get(`https://vsmarketplacebadges.dev/version-short/${FQN}.svg`);
    const m = r.body.match(/v(\d+\.\d+\.\d+)/);
    console.log(`\n（参考）第三方徽章服务报的版本：${m ? m[1] : '未解析到'} —— 该服务有缓存延迟，不要用它判断是否生效`);
  } catch {
    /* 忽略 */
  }

  console.log(
    pageOk
      ? '\n🎉 线上已是当前版本。'
      : '\n提示：市场校验（verifying）通常几分钟，偶尔更久；期间线上是上一版。过一会儿再跑一次本脚本即可。'
  );
})();
