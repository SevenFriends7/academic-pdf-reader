import * as vscode from 'vscode';
import { PdfDualReaderProvider } from './pdfEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('[AcademicReader] Academic Literature Reader extension is active!');

  // 注册自定义双栏 PDF 编辑器
  const { provider, disposable } = PdfDualReaderProvider.register(context);
  context.subscriptions.push(disposable);

  // 注册命令：打开 PDF
  const openCmd = vscode.commands.registerCommand(
    'academicReader.openPdf',
    async (fileUri?: vscode.Uri) => {
      let targetUri = fileUri;
      if (!targetUri) {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: {
            'PDF 文献': ['pdf']
          },
          openLabel: '在双栏阅读器中打开'
        });
        if (selected && selected.length > 0) {
          targetUri = selected[0];
        }
      }

      if (targetUri) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          PdfDualReaderProvider.viewType
        );
      }
    }
  );
  context.subscriptions.push(openCmd);

  // 注册命令：导出笔记为 Markdown（全文双语精读稿）
  const exportCmd = vscode.commands.registerCommand(
    'academicReader.exportNotesMarkdown',
    async () => {
      await provider.exportCurrentNotes();
    }
  );
  context.subscriptions.push(exportCmd);

  // 注册命令：导出「高光批注 PDF」（全篇原文 + 高亮画回原位 + 译文与笔记附录）
  const exportPdfCmd = vscode.commands.registerCommand(
    'academicReader.exportAnnotatedPdf',
    async () => {
      await provider.exportAnnotatedPdf();
    }
  );
  context.subscriptions.push(exportPdfCmd);

  // 注册命令：快速配置 Google Gemini API Key
  const setGeminiKeyCmd = vscode.commands.registerCommand(
    'academicReader.setGeminiApiKey',
    async () => {
      const config = vscode.workspace.getConfiguration('academicReader');
      const currentKey = config.get<string>('geminiApiKey', '');
      const input = await vscode.window.showInputBox({
        title: '🔑 配置 Google Gemini API Key',
        prompt:
          '请输入 Google Gemini API 密钥（AI Studio 或 Google Cloud 控制台获取；两种格式都支持：AIza... 或 AQ....）',
        value: currentKey,
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'AQ.Ab8... 或 AIzaSy...'
      });

      if (input === undefined) return;
      const key = input.trim();
      if (!key) {
        vscode.window.showWarningMessage('未填写 API Key，已取消。');
        return;
      }

      await config.update('geminiApiKey', key, vscode.ConfigurationTarget.Global);
      await config.update('translationService', 'gemini', vscode.ConfigurationTarget.Global);

      // 立刻实测这把 key 能不能用、能看到哪些模型，避免"填了但一直报错却不知道原因"
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在校验 Gemini API Key...' },
        async () => {
          try {
            const models = await provider.listModels(true);
            const hit = models.filter((m: string) => /flash|pro/.test(m)).slice(0, 6).join(', ');
            vscode.window
              .showInformationMessage(
                `✅ API Key 有效，共 ${models.length} 个可用模型（${hit}…）。已启用 Gemini 为首选引擎。`,
                '选择模型'
              )
              .then(choice => {
                if (choice === '选择模型') {
                  vscode.commands.executeCommand('academicReader.pickModel');
                }
              });
          } catch (err: any) {
            vscode.window.showErrorMessage(
              `⚠️ API Key 已保存，但校验失败：${err && err.message ? err.message : err}`
            );
          }
        }
      );
    }
  );
  context.subscriptions.push(setGeminiKeyCmd);

  // 注册命令：从「真实可用模型列表」里挑模型（不再让用户手打模型名）
  const pickModelCmd = vscode.commands.registerCommand('academicReader.pickModel', async () => {
    await provider.pickModel();
  });
  context.subscriptions.push(pickModelCmd);

  // 注册命令：打开综合设置与大模型翻译配置菜单
  const openSettingsCmd = vscode.commands.registerCommand(
    'academicReader.openSettings',
    async () => {
      const config = vscode.workspace.getConfiguration('academicReader');
      const currentService = config.get<string>('translationService', 'gemini');

      const items = [
        {
          label: '$(server-process) 配置模型 API（DeepSeek / Kimi / 通义 / OpenAI …）',
          description:
            currentService === 'openai-compatible'
              ? '【当前使用中】选一个常用模型，填上 API Key 即可'
              : '选一个常用模型，填上 API Key 即可',
          action: 'custom'
        },
        {
          label: '$(key) 配置 Google Gemini API Key',
          description: currentService === 'gemini' ? '【当前使用中】Google 官方接口' : 'Google 官方接口',
          action: 'gemini'
        },
        {
          label: '$(globe) 切换为内置免费翻译引擎（无需 Key）',
          description: currentService === 'built-in' ? '【当前使用中】开箱即用' : '无需申请密钥，网络直连',
          action: 'builtin'
        },
        {
          label: '$(settings-gear) 打开完整插件设置页面 (GUI)...',
          description: '在 IDE 设置面板中查看所有选项（目标语言、翻译模型等）',
          action: 'settings'
        }
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '文献阅读器：请选择要配置的学术翻译服务或选项（翻译与 AI 问答共用所选引擎）'
      });

      if (!selected) return;

      if (selected.action === 'gemini') {
        await vscode.commands.executeCommand('academicReader.setGeminiApiKey');
      } else if (selected.action === 'custom') {
        await configureCustomLLM(config);
      } else if (selected.action === 'builtin') {
        await config.update('translationService', 'built-in', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('✅ 已切换为内置免费翻译引擎（无需 API Key）。');
      } else if (selected.action === 'settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'academicReader');
      }
    }
  );
  context.subscriptions.push(openSettingsCmd);
}

/**
 * 常用 OpenAI 兼容服务商 / 模型。
 * 选一个就自动带出端点，用户只需要填 API Key——不必自己搞清 base URL 和模型名。
 */
const COMMON_MODELS: { label: string; description: string; endpoint: string }[] = [
  {
    label: 'deepseek-chat',
    description: 'DeepSeek 通用模型：便宜、快，翻译与问答都够用',
    endpoint: 'https://api.deepseek.com/v1'
  },
  {
    label: 'deepseek-reasoner',
    description: 'DeepSeek 推理模型：更强，但更慢更贵',
    endpoint: 'https://api.deepseek.com/v1'
  },
  {
    label: 'moonshot-v1-8k',
    description: 'Kimi（月之暗面），中文语感好',
    endpoint: 'https://api.moonshot.cn/v1'
  },
  {
    label: 'qwen-plus',
    description: '通义千问（阿里云百炼），国内直连稳定',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  {
    label: 'glm-4-plus',
    description: '智谱 GLM，国内直连',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4'
  },
  {
    label: 'gpt-4o-mini',
    description: 'OpenAI，需要能访问其网络环境',
    endpoint: 'https://api.openai.com/v1'
  },
  {
    label: '本地模型（Ollama / vLLM / LM Studio 等）',
    description: '自己填端点，例如 http://localhost:11434/v1',
    endpoint: ''
  },
  {
    label: '其它（手动输入模型名与端点）',
    description: '任何兼容 OpenAI /chat/completions 的服务',
    endpoint: ''
  }
];

async function configureCustomLLM(config: vscode.WorkspaceConfiguration) {
  const currentEndpoint = (config.get<string>('apiEndpoint', '') || '').trim();
  const currentModel = (config.get<string>('modelName', 'deepseek-chat') || '').trim();

  // ① 先选模型/服务商（自动带出端点）
  const picked = await vscode.window.showQuickPick(
    COMMON_MODELS.map(m => ({
      label: m.label,
      description: m.description,
      detail: m.endpoint ? `端点：${m.endpoint}` : undefined,
      picked: m.label === currentModel,
      _endpoint: m.endpoint
    })),
    {
      title: '选择要使用的模型',
      placeHolder: `当前：${currentModel || '(未设置)'}${currentEndpoint ? ` @ ${currentEndpoint}` : ''}`,
      ignoreFocusOut: true,
      matchOnDescription: true
    }
  );
  if (!picked) return;

  // ② API Key（唯一必填项）
  const currentKey = config.get<string>('apiKey', '');
  const keyInput = await vscode.window.showInputBox({
    title: `配置 ${picked.label} - API Key`,
    prompt: '粘贴该平台的 API Key（只在本地设置里保存，不会上传）',
    value: currentKey,
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-...'
  });
  if (keyInput === undefined) return;

  // ③ 端点：常用服务商自动带出；本地/其它才追问
  let endpoint = picked._endpoint || currentEndpoint;
  if (!picked._endpoint) {
    const endpointInput = await vscode.window.showInputBox({
      title: '配置 API 端点 (Base URL)',
      prompt: '兼容 OpenAI 格式的端点，通常以 /v1 结尾',
      value: currentEndpoint || 'http://localhost:11434/v1',
      ignoreFocusOut: true,
      placeHolder: 'http://localhost:11434/v1'
    });
    if (endpointInput === undefined) return;
    endpoint = endpointInput.trim();
  }

  // ④ 模型名：常用列表直接采用；"其它"才追问
  let modelName = picked.label;
  if (/^(其它|本地模型)/.test(picked.label)) {
    const modelInput = await vscode.window.showInputBox({
      title: '配置模型名称',
      prompt: '该服务端点的模型名，例如 qwen2.5:7b、llama-3.1-8b',
      value: currentModel,
      ignoreFocusOut: true,
      placeHolder: 'deepseek-chat'
    });
    if (modelInput === undefined) return;
    modelName = modelInput.trim();
  }

  await config.update('apiKey', keyInput.trim(), vscode.ConfigurationTarget.Global);
  await config.update('apiEndpoint', endpoint, vscode.ConfigurationTarget.Global);
  await config.update('modelName', modelName, vscode.ConfigurationTarget.Global);
  await config.update('translationService', 'openai-compatible', vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(
    `已启用 ${modelName} 作为翻译与 AI 问答引擎（端点 ${endpoint}）。`
  );
}

export function deactivate() {}
