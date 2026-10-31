import * as vscode from 'vscode';
import { callOpenAICompatStream, LlmError, LlmImage } from './llmClient';

export interface VisionProviderConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  isConfigured: boolean;
  isTextOnlyFallback: boolean;
  isDedicatedVision: boolean;
  reason?: string;
}

export interface VisionPreset {
  label: string;
  description: string;
  endpoint: string;
  defaultModel: string;
}

export const VISION_PROVIDER_PRESETS: VisionPreset[] = [
  {
    label: '通义千问 Qwen-VL（阿里云百炼，公式与图表识别极强，推荐）',
    description: 'dashscope.aliyuncs.com · qwen-vl-max',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-vl-max',
  },
  {
    label: '硅基流动 SiliconFlow（支持 Qwen2.5-VL，新用户有免费额度）',
    description: 'api.siliconflow.cn · Qwen/Qwen2.5-VL-72B-Instruct',
    endpoint: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
  },
  {
    label: 'Google Gemini 视觉（速度快、多模态理解强）',
    description: 'generativelanguage.googleapis.com · gemini-2.5-flash',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  },
  {
    label: 'OpenAI GPT-4o / GPT-4o-mini',
    description: 'api.openai.com · gpt-4o',
    endpoint: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
  },
  {
    label: '智谱清言 GLM-4V',
    description: 'open.bigmodel.cn · glm-4v-plus',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4v-plus',
  },
  {
    label: '自定义 OpenAI 兼容多模态端点（vLLM / Ollama / 中转站）',
    description: '手动填写 Endpoint 与视觉模型名',
    endpoint: '',
    defaultModel: '',
  },
];

const KNOWN_TEXT_ONLY_MODEL_RE =
  /^(?:deepseek-chat|deepseek-reasoner|deepseek-coder|deepseek-v[23]|qwen-(?:turbo|plus|max)(?!-vl)|glm-[34](?!v)|moonshot-v1-(?:8k|32k|128k)$)/i;

/**
 * Resolve decoupled Vision API settings (`visionApiEndpoint`, `visionApiKey`, `visionModel`),
 * falling back cleanly to primary LLM settings if primary model supports vision.
 */
export function resolveVisionProviderConfig(): VisionProviderConfig {
  const cfg = vscode.workspace.getConfiguration('academicReader');

  const visionEndpoint = (cfg.get<string>('visionApiEndpoint') || '').trim();
  const visionKey = (cfg.get<string>('visionApiKey') || '').trim();
  const visionModel = (cfg.get<string>('visionModel') || '').trim();

  const mainEndpoint = (cfg.get<string>('apiEndpoint') || 'https://api.deepseek.com/v1').trim();
  const mainKey = (cfg.get<string>('apiKey') || '').trim();
  const mainModel = (cfg.get<string>('aiModel') || cfg.get<string>('modelName') || 'deepseek-chat').trim();

  const endpoint = (visionEndpoint || mainEndpoint).replace(/\/+$/, '');
  const apiKey = visionKey || mainKey;
  const model = visionModel || mainModel;
  const isDedicatedVision = Boolean(visionEndpoint || visionKey || visionModel);

  if (!apiKey) {
    return {
      endpoint,
      apiKey: '',
      model,
      isConfigured: false,
      isTextOnlyFallback: false,
      isDedicatedVision,
      reason: '尚未配置视觉 API Key。可点击「配置视觉引擎」独立配置 Qwen-VL / Gemini / GPT-4o（不影响当前 DeepSeek 文本翻译）。',
    };
  }

  if (!visionModel && KNOWN_TEXT_ONLY_MODEL_RE.test(model)) {
    return {
      endpoint,
      apiKey,
      model,
      isConfigured: false,
      isTextOnlyFallback: true,
      isDedicatedVision: false,
      reason: `当前主模型「${model}」是纯文本模型，不支持图片输入。请点击「配置视觉引擎」单独填入 Qwen-VL / SiliconFlow / GPT-4o 等视觉模型（正文翻译仍继续走 ${model}）。`,
    };
  }

  return {
    endpoint,
    apiKey,
    model,
    isConfigured: Boolean(endpoint && apiKey && model),
    isTextOnlyFallback: false,
    isDedicatedVision,
  };
}

export function parseDataUrlToLlmImage(dataUrlOrBase64: string, defaultMime = 'image/png'): LlmImage {
  const raw = String(dataUrlOrBase64 || '').trim();
  const m = /^data:([^;]+);base64,(.+)$/s.exec(raw);
  if (m) {
    return { mimeType: m[1], base64: m[2].replace(/\s+/g, '') };
  }
  return { mimeType: defaultMime, base64: raw.replace(/\s+/g, '') };
}

/** Clean fenced markdown / `$$` wrappers around VLM-returned LaTeX */
export function cleanVlmLatexOutput(raw: string): string {
  let s = String(raw || '').trim();
  // Strip ```latex ... ``` or ``` ... ```
  const fence = /```(?:latex|tex|math)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) {
    s = fence[1].trim();
  }
  // Strip outer $$...$$ or \[...\] or $...$
  if (s.startsWith('$$') && s.endsWith('$$') && s.length > 4) {
    s = s.slice(2, -2).trim();
  } else if (s.startsWith('\\[') && s.endsWith('\\]') && s.length > 4) {
    s = s.slice(2, -2).trim();
  } else if (s.startsWith('$') && s.endsWith('$') && !s.slice(1, -1).includes('$')) {
    s = s.slice(1, -1).trim();
  }
  return s.trim();
}

export type SnipRecognitionMode = 'latex' | 'translate' | 'explain';

export interface SnipRecognitionRequest {
  mode: SnipRecognitionMode;
  imageDataUrl: string;
  targetLangName?: string;
  localHintText?: string;
  localHintLatex?: string;
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
}

export interface SnipRecognitionResult {
  text: string;
  latex?: string;
  model: string;
  usedVision: boolean;
}

/**
 * Perform targeted multimodal recognition on a cropped PDF region (1-3s latency):
 * - `'latex'`: High-precision formula OCR -> pure KaTeX-compilable LaTeX
 * - `'translate'`: Visual OCR + academic translation (supports tables, figures, formulas + text)
 * - `'explain'`: Step-by-step explanation of cropped equation / architecture diagram / table
 */
export async function recognizeSnipRegion(req: SnipRecognitionRequest): Promise<SnipRecognitionResult> {
  const vcfg = resolveVisionProviderConfig();
  if (!vcfg.isConfigured) {
    throw new LlmError({
      kind: vcfg.apiKey ? 'invalid-request' : 'no-key',
      model: vcfg.model,
      apiMessage: vcfg.reason || '未配置支持图片输入的视觉模型',
    });
  }

  const image = parseDataUrlToLlmImage(req.imageDataUrl, 'image/png');
  const lang = req.targetLangName || '简体中文';

  let systemInstruction = '';
  let userPrompt = '';

  if (req.mode === 'latex') {
    systemInstruction =
      'You are an expert academic mathematical OCR engine. Convert the mathematical expression in the image into exact, standard KaTeX-compatible LaTeX. ' +
      'Output ONLY the raw LaTeX code itself — NO markdown code fences (no ```latex), NO outer $$ or \\[ delimiters, and NO explanations. ' +
      'Use \\begin{aligned} ... \\end{aligned} for multi-line equations, \\begin{cases} ... \\end{cases} for piecewise functions, and \\begin{bmatrix} / \\begin{pmatrix} for matrices. ' +
      'Do NOT include trailing equation numbers like (1) unless integral to the expression.';
    userPrompt = req.localHintLatex
      ? `Recognize the exact LaTeX from this cropped PDF image. (Optional noisy PDF text-layer hint for symbol reference only — trust the visual image first: ${req.localHintLatex})`
      : 'Recognize the exact LaTeX from this cropped PDF image.';
  } else if (req.mode === 'translate') {
    systemInstruction =
      `你是一位精通计算机与理工科学术文献的视觉精读与翻译专家。请直接读取图片中的学术内容并高质量翻译为${lang}：\n` +
      `1. 若图片是**学术正文或图注**：输出精准流畅的${lang}学术译文，行内公式用 $...$ 保留，行间公式用 $$...$$ 保留。\n` +
      `2. 若图片是**表格**：还原为清晰的 Markdown 表格，表头与说明翻译为${lang}，指标缩写与数值原样保留。\n` +
      `3. 若图片是**架构图 / 流程图**：按模块顺序列出图中关键组件英文原名与${lang}功能说明。\n` +
      `只输出最终结果，不要寒暄。`;
    userPrompt = `请识别并将这张论文局部截图精准翻译/整理为${lang}。`;
  } else {
    systemInstruction =
      `你是一位耐心的学术论文导师。请结合这张论文局部截图，用清晰易懂的${lang}为读者讲透其中的核心内容（如果是公式：逐项拆解每个符号含义与物理/数学直觉；如果是架构图或表格：梳理信息流向与核心实验结论）。公式使用 $...$ 或 $$...$$ 书写。`;
    userPrompt = '请帮我深入浅出地讲解这张截图里的内容。';
  }

  const res = await callOpenAICompatStream({
    endpoint: vcfg.endpoint,
    apiKey: vcfg.apiKey,
    model: vcfg.model,
    systemInstruction,
    turns: [{ role: 'user', text: userPrompt }],
    images: [image],
    temperature: req.mode === 'latex' ? 0.05 : 0.25,
    maxOutputTokens: req.mode === 'latex' ? 1024 : 2500,
    signal: req.signal,
    onDelta: req.onDelta,
    idleTimeoutMs: 45000,
    totalTimeoutMs: 120000,
  });

  if (req.mode === 'latex') {
    const cleanTex = cleanVlmLatexOutput(res.text);
    return {
      text: cleanTex,
      latex: cleanTex,
      model: vcfg.model,
      usedVision: true,
    };
  }

  return {
    text: res.text.trim(),
    model: vcfg.model,
    usedVision: true,
  };
}
