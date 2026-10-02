# 贡献与发布指南

面向参与开发或维护本扩展的人。使用说明请看 [README](README.md)。

---

## 🛠️ 开发者本地构建

```bash
# 1. 安装依赖
npm install

# 2. 编译代码
npm run compile

# 3. 一键打包并安装为 .vsix（会同时装到本机的 VS Code 与反重力 IDE）
npm run package
```

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run compile` | 编译 `src/*.ts` → `dist/extension.js` |
| `npm run watch` | 监听改动自动重编译（改 `src/` 时用） |
| `npm run package` | **仅供本机安装**：打包 `*-local.vsix` 并装到本机两个 IDE |
| `npm run vsix` | **用于上传商店**：用官方 `vsce` 打包标准 `.vsix` |
| `npm run ls:pack` | 列出 `vsce` 实际会打包的文件（上传前自查） |

> ⚠️ **两个产物不要混用。** `npm run package` 的 `*-local.vsix` 是本脚本手写 manifest 打出来的，
> 本机 IDE 安装没问题，但**上传扩展市场会报 `Error occurred while parsing the manifest file`**
> （市场的 manifest 校验更严格，要求 `<Properties>` 引擎声明、图标/许可证 `<Asset>` 等字段）。
> 上传商店、Open VSX、以及 CI 产物，一律用 `npm run vsix`（即官方 `vsce package`）。

修改 `media/viewer.js` / `media/viewer.css` 不需要编译，但**需要重启 IDE 才会生效**（或 `Developer: Reload Window`）。

### 测试

```bash
node scratch/llm-test/viewer-unit.js   # webview 侧单元测试（无需 API Key）
node scratch/scan_secrets.js           # 提交前密钥扫描
```

版面诊断工具（需要论文 PDF）：

```bash
PAPERS_DIR=/path/to/papers node scratch/audit_papers.js        # 全论文逐页审计
PAPERS_DIR=/path/to/papers node scratch/layout_truth.js 3      # 打印某页真实行分类
```

---

---

## 发布新版本

发布自动化已经配好，日常只需要三步。

### 1. 首次准备（只做一次）

**第 1 步：注册发布者**（必做）

1. 用 Microsoft 账号登录 <https://marketplace.visualstudio.com/manage>
2. 点 **Create publisher**：
   - **ID** 填 `paper-reader`（必须与 `package.json` 的 `publisher` 完全一致，创建后不可改）
   - **Name** 任意（商店页显示的名字）

**第 2 步：上架第一个版本**

有两条路，**优先走 A**——它不需要 PAT，也不需要 Azure 订阅：

| 路线 | 需要什么 | 适合 |
| --- | --- | --- |
| **A. 手动上传（推荐先走这条）** | 只要 Microsoft 账号 | 首次上架、偶尔发版 |
| **B. `vsce publish` 自动发布** | Azure DevOps 的 PAT | 频繁发版、想用 CI 全自动 |

**路线 A**：从 [GitHub Releases](https://github.com/SevenFriends7/academic-pdf-reader/releases) 或本机 `npm run vsix` 拿到 `.vsix`，
在 publisher 页面点 **New extension → Visual Studio Code** 上传即可。商店几分钟后可见。

**路线 B**：需要一个 PAT（见下方"关于 PAT"），然后：

```bash
npm run login          # 粘贴 PAT
npm run publish:patch  # 或 minor / major
```

**第 3 步（可选）：让 CI 全自动发布**

在仓库 **Settings → Secrets and variables → Actions** 添加 `VSCE_PAT`（路线 B 的 PAT）。
配好之后，`git push --follow-tags` 推 tag 就会自动发版；**没配也不会失败**，CI 只打包并上传 vsix 产物。

（可选）如果用户群体里有 VS Code 的**分支发行版**（VSCodium、各类国产 IDE 等），它们用的是 Open VSX，
需要另外在 <https://open-vsx.org> 注册并配置 `OVSX_PAT`。

#### 关于 PAT（路线 B 的前提，务必先读）

- **新建 Azure DevOps 组织现在要求「有效的 Azure 订阅」**
  （见 [Create an organization](https://learn.microsoft.com/azure/devops/organizations/accounts/create-organization)），
  没有订阅时这一步会卡住；可行替代是被加入一个已有的 Azure DevOps 组织再建 PAT。
- **全局 PAT 将于 2026-12-01 退役**，微软官方建议改用 Entra ID 方式发布。
- PAT 的 Scope 只需勾 **Marketplace → Manage**（Organization 选 "All accessible organizations"）。
- 生成入口有两处，哪个有就用哪个：
  1. Azure DevOps → User settings → Personal access tokens；
  2. Visual Studio Marketplace 的 publisher 页面 → **Security / PAT** 分区（部分账号直接提供）。
- 备选方案（都不成熟/有前提，暂时不推荐踩）：
  `vsce publish --oidc`（Trusted Publishing，无需任何 Azure 资源，但社区尚无成功验证）与
  `vsce publish --azure-credential`（需 Azure 托管标识，有成功先例但要 Azure 资源）。

### 2. 发布（二选一）

**本机发布**

```bash
# 先在 CHANGELOG.md 顶部写好本次改动，然后：
npm run publish:patch    # 修 bug / 改文案
npm run publish:minor    # 新增功能（兼容）
npm run publish:major    # 破坏性变更（改配置项名、改扩展 ID 等）
```

`publish:*` 会自动改 `package.json` 里的 version、触发编译、打包并上传。

**CI 发布（推荐）**

```bash
npm version patch        # 或 minor / major：改版本号并打 tag
git push --follow-tags
```

推 tag 后 GitHub Actions（`.github/workflows/release.yml`）会自动：
类型检查 → 单元测试 → 密钥扫描 → 校验 tag 与 package.json 版本一致 → 打包 →
发布到 Marketplace / Open VSX → 挂到 GitHub Release。

需要在仓库 **Settings → Secrets and variables → Actions** 里配置 `VSCE_PAT`（和可选的 `OVSX_PAT`）。

### 3. 注意事项

- **扩展 ID 一旦上架就不能改**（`paper-reader.academic-pdf-reader`）。改了就是另一个扩展，
  用户的设置与批注不会跟过去。
- 配置项名（`academicReader.*`）属于兼容性契约，重命名要按 major 走并在 CHANGELOG 里写迁移说明。
- 发布前建议先 `npm run package` 装到本机点一遍，再 `npm run ls:pack` 确认打包清单没有多余文件。
- 撤回用 `vsce unpublish`，但商店政策限制很严，会影响已有安装，尽量靠"发新版本修复"。

---
