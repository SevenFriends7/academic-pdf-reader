import * as vscode from 'vscode';
import { PdfDualReaderProvider } from './pdfEditorProvider';
import { detectPaddlePython } from './formulaModel';
import { VISION_PROVIDER_PRESETS, resolveVisionProviderConfig } from './visionService';

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

  // 注册命令：从「真实可用模型列表」里挑模型（不再让用户手打模型名）
  const pickModelCmd = vscode.commands.registerCommand('academicReader.pickModel', async () => {
    await provider.pickModel();
  });
  context.subscriptions.push(pickModelCmd);

  // 注册命令：独立配置视觉识别引擎（公式转 LaTeX / 区域视觉翻译 / 带图问 AI）
  const configureVisionCmd = vscode.commands.registerCommand(
    'academicReader.configureVision',
    async () => {
      await configureVisionLLM(vscode.workspace.getConfiguration('academicReader'));
    }
  );
  context.subscriptions.push(configureVisionCmd);

  // 注册命令：打开综合设置与大模型翻译配置菜单
  const openSettingsCmd = vscode.commands.registerCommand(
    'academicReader.openSettings',
    async () => {
      const config = vscode.workspace.getConfiguration('academicReader');
      const currentService = config.get<string>('translationService', 'openai-compatible');
      const vcfg = resolveVisionProviderConfig();

      const items = [
        {
          label: '$(server-process) 配置翻译 / AI 问答模型 API（DeepSeek / Kimi / 通义 / OpenAI …）',
          description:
            currentService === 'openai-compatible'
              ? '【当前使用中】选一个常用文本模型，填上 API Key 即可'
              : '选一个常用模型，填上 API Key 即可',
          action: 'custom'
        },
        {
          label: '$(device-camera) 配置独立视觉识别引擎（框选公式转 LaTeX / 区域视觉翻译 / 带图问 AI）',
          description: vcfg.isConfigured
            ? `【已就绪：${vcfg.model}】可与 DeepSeek 文本翻译搭配使用`
            : '推荐配置通义 Qwen-VL / 硅基流动 / Gemini / GPT-4o（与正文翻译互不影响）',
          action: 'vision'
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
        placeHolder: '文献阅读器：请选择要配置的服务（支持 DeepSeek 正文翻译 + 独立多模态视觉识别双引擎）'
      });

      if (!selected) return;

      if (selected.action === 'custom') {
        await configureCustomLLM(config);
      } else if (selected.action === 'vision') {
        await configureVisionLLM(config);
      } else if (selected.action === 'builtin') {
        await config.update('translationService', 'built-in', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('✅ 已切换为内置免费翻译引擎（无需 API Key）。');
      } else if (selected.action === 'settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'academicReader');
      }
    }
  );
  context.subscriptions.push(openSettingsCmd);

  /*
   * 注册命令：一键启用本地公式识别。
   *
   * 【为什么需要这个命令】它要两件事同时配好才生效——开关 + 解释器路径，
   * 而"哪个 python 里装了 paddleocr"用户通常不知道（实测这台机器上 `python`
   * 指向的是 Microsoft Store 占位符，真解释器在 D:\python\python3.13）。
   * 让用户自己去设置里翻两个 key、再猜路径，是最容易半途放弃的地方。
   */
  const setupFormulaCmd = vscode.commands.registerCommand(
    'academicReader.setupLocalFormulaModel',
    async () => {
      const cfg = vscode.workspace.getConfiguration('academicReader');
      const chosen = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '正在查找装了 paddleocr 的 Python…',
          cancellable: false
        },
        async () => detectPaddlePython(cfg.get<string>('formulaModel.pythonPath', '') || '')
      );

      if (!chosen) {
        const action = await vscode.window.showErrorMessage(
          '没找到装了 paddleocr 的 Python。可先在终端执行：pip install "paddleocr>=3.7" paddlepaddle pillow，再重试本命令。',
          '打开相关设置'
        );
        if (action) {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'academicReader.formulaModel');
        }
        return;
      }

      await cfg.update('formulaModel.pythonPath', chosen.path, vscode.ConfigurationTarget.Global);
      await cfg.update('formulaModel.enabled', true, vscode.ConfigurationTarget.Global);
      const pick = await vscode.window.showInformationMessage(
        `已启用本地公式识别：${chosen.path}（paddleocr ${chosen.version}）。` +
          '打开 PDF 翻到有公式的页面即可看到效果；首次会花十几秒加载模型，之后约 0.4 秒/条。',
        '打开一篇 PDF 试试'
      );
      if (pick) {
        await vscode.commands.executeCommand('academicReader.openPdf');
      }
    }
  );
  context.subscriptions.push(setupFormulaCmd);

  void maybePromptLocalFormulaModel(context);
}

/**
 * 首次运行时主动问一句"要不要启用本地公式识别"。
 *
 * 【为什么值得主动问】这个功能的开关默认是关的（它依赖 Python + paddleocr，
 * 不是所有机器都有），但**本机已经有环境的人不知道要去设置里翻两个 key**——
 * 实测用户装完就直接打开论文看，看到的还是老样子，于是以为"装了没用"。
 *
 * 只在**从未提示过**（globalState 记账）且开关仍为关时做一次；探测是同步 spawn，
 * 要 2~4 秒（paddle 会加载一堆算子库），所以延迟 3 秒，不挡扩展激活。
 */
async function maybePromptLocalFormulaModel(context: vscode.ExtensionContext): Promise<void> {
  const KEY = 'formulaModelPrompted.v1';
  if (context.globalState.get<boolean>(KEY)) return;
  const cfg = vscode.workspace.getConfiguration('academicReader');
  if (cfg.get<boolean>('formulaModel.enabled', false)) return;

  setTimeout(async () => {
    let found: ReturnType<typeof detectPaddlePython> = null;
    try {
      found = detectPaddlePython(cfg.get<string>('formulaModel.pythonPath', '') || '');
    } finally {
      // 探过就记账：找不到也别每次启动都再花几秒试一遍
      await context.globalState.update(KEY, true);
    }
    if (!found) return;
    const pick = await vscode.window.showInformationMessage(
      `检测到本机已装 paddleocr（${found.version}），可以启用「本地公式识别」把公式还原成准确的 LaTeX（分式、根号、嵌套上下标）。要现在启用吗？`,
      '启用',
      '以后再说'
    );
    if (pick !== '启用') return;
    await cfg.update('formulaModel.pythonPath', found.path, vscode.ConfigurationTarget.Global);
    await cfg.update('formulaModel.enabled', true, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      `已启用本地公式识别（${found.path}）。打开 PDF 翻到有公式的页面即可；首次会花十几秒加载模型。`
    );
  }, 3000);
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

async function configureVisionLLM(config: vscode.WorkspaceConfiguration) {
  const curEndpoint = (config.get<string>('visionApiEndpoint', '') || '').trim();
  const curModel = (config.get<string>('visionModel', '') || '').trim();

  const items = [
    ...VISION_PROVIDER_PRESETS.map(p => ({
      label: p.label,
      description: p.description,
      detail: p.endpoint ? `端点：${p.endpoint}` : undefined,
      _preset: p,
      _clear: false
    })),
    {
      label: '$(clear-all) 清空独立视觉配置（沿用主模型；无视觉 Key 时框选公式仍走内置离线 2D 重建）',
      description: '恢复继承主端点与主模型',
      detail: undefined,
      _preset: null,
      _clear: true
    }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: '配置独立视觉识别引擎（框选公式转 LaTeX / 区域视觉翻译 / 带图问 AI）',
    placeHolder: curModel ? `当前独立视觉模型：${curModel} @ ${curEndpoint || '主端点'}` : '选择一个多模态视觉平台（不影响当前 DeepSeek 等正文翻译配置）',
    ignoreFocusOut: true,
    matchOnDescription: true
  });
  if (!picked) return;

  if (picked._clear) {
    await config.update('visionApiEndpoint', '', vscode.ConfigurationTarget.Global);
    await config.update('visionApiKey', '', vscode.ConfigurationTarget.Global);
    await config.update('visionModel', '', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('已清空独立视觉配置，将沿用主模型或内置离线 2D 公式重建。');
    return;
  }

  const preset = picked._preset!;
  let endpoint = preset.endpoint || curEndpoint;
  if (!preset.endpoint) {
    const epIn = await vscode.window.showInputBox({
      title: '配置视觉 API 端点 (Base URL)',
      prompt: '兼容 OpenAI 多模态 /chat/completions 的端点（通常以 /v1 结尾）',
      value: curEndpoint || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ignoreFocusOut: true
    });
    if (epIn === undefined) return;
    endpoint = epIn.trim();
  }

  const modelIn = await vscode.window.showInputBox({
    title: '配置视觉模型名称',
    prompt: '支持图片输入的多模态模型名（如 qwen-vl-max、Qwen/Qwen2.5-VL-72B-Instruct、gemini-2.5-flash、gpt-4o）',
    value: preset.defaultModel || curModel || 'qwen-vl-max',
    ignoreFocusOut: true
  });
  if (modelIn === undefined || !modelIn.trim()) return;

  const curKey = config.get<string>('visionApiKey', '');
  const keyIn = await vscode.window.showInputBox({
    title: `配置 ${modelIn.trim()} - 视觉 API Key`,
    prompt: '粘贴该视觉平台的 API Key（若与主翻译平台相同可留空沿用主 Key）',
    value: curKey,
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-...（留空则沿用主 apiKey）'
  });
  if (keyIn === undefined) return;

  await config.update('visionApiEndpoint', endpoint, vscode.ConfigurationTarget.Global);
  await config.update('visionModel', modelIn.trim(), vscode.ConfigurationTarget.Global);
  await config.update('visionApiKey', keyIn.trim(), vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(
    `✅ 独立视觉引擎已就绪：${modelIn.trim()}（现在可在 PDF 上按住 Shift+拖拽 或点「框选识别」体验公式转 LaTeX、区域视觉翻译与带图问 AI！）`
  );
}

export function deactivate() {}
