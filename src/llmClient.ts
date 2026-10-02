import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * 统一 LLM 客户端 (Gemini 原生协议)
 *
 * 设计原则（针对旧版 translator.ts 的教训）：
 * 1. 绝不臆造内容。任何失败都以结构化 LlmError 抛出，由 UI 显式展示原因。
 * 2. 绝不"智能改写"用户配置的模型名。若配置的模型不可用，先回退到可用模型，
 *    并把真实发生的情况（fellBackFrom）返回给调用方，让用户知情。
 * 3. 内部一律走 SSE 流式：这样"空闲超时"才是有意义的（非流式请求首字节=末字节，
 *    任何超时设置都只能靠猜）。
 * 4. 错误按语义分类（auth / not-found / rate-limit / timeout ...），可重试的才重试。
 */

export type LlmErrorKind =
  | 'no-key'
  | 'auth'
  | 'permission'
  | 'not-found'
  | 'rate-limit'
  | 'quota'
  | 'invalid-request'
  | 'safety'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'empty'
  | 'parse'
  | 'unknown';

export interface LlmErrorInfo {
  kind: LlmErrorKind;
  status?: number;
  model?: string;
  apiMessage?: string;
  tip?: string;
}

export class LlmError extends Error {
  public readonly kind: LlmErrorKind;
  public readonly status?: number;
  public readonly model?: string;
  public readonly apiMessage?: string;
  public readonly tip?: string;
  public readonly rawBody?: string;

  constructor(info: LlmErrorInfo, rawBody?: string) {
    super(info.apiMessage || info.kind);
    this.name = 'LlmError';
    this.kind = info.kind;
    this.status = info.status;
    this.model = info.model;
    this.apiMessage = info.apiMessage;
    this.tip = info.tip;
    this.rawBody = rawBody;
  }

  /** 可直接显示给用户的中文说明（绝不含编造内容） */
  public toUserMessage(): string {
    switch (this.kind) {
      case 'no-key':
        return '未配置 Google Gemini API Key。请执行命令「文献阅读：配置学术翻译引擎与 API Key」填入密钥。';
      case 'auth':
        return `API Key 无效或已被撤销（HTTP ${this.status || 401}）。请在设置中更新 academicReader.geminiApiKey。`;
      case 'permission':
        return `该 API Key 无权访问此模型${this.model ? `（${this.model}）` : ''}（HTTP ${this.status || 403}）。请确认项目已启用 Generative Language API。`;
      case 'not-found':
        return `模型不存在或已下线${this.model ? `（${this.model}）` : ''}（HTTP 404）。请执行命令「文献阅读：从可用模型列表中选择翻译 / AI 问答模型」换用当前可用的模型。`;
      case 'quota':
        return `该模型在此 API Key 上没有可用配额（HTTP 429）：${
          this.apiMessage || '配额或账单额度已用尽'
        }。请在命令面板执行「文献阅读：从可用模型列表中选择翻译 / AI 问答模型」换用有配额的模型。`;
      case 'rate-limit':
        return `请求过于频繁（HTTP ${this.status || 429}）。已自动重试，若持续出现请降低「同时翻译请求数」（academicReader.translateConcurrency）。`;
      case 'invalid-request':
        return `请求参数被 API 拒绝（HTTP ${this.status || 400}）：${this.apiMessage || '参数非法'}`;
      case 'safety':
        return `该内容被模型安全策略拦截，无法生成结果。${this.apiMessage ? `原因：${this.apiMessage}` : ''}`;
      case 'server':
        return `Gemini 服务端暂时故障（HTTP ${this.status || 500}）。请稍后重试。`;
      case 'network':
        return `无法连接 generativelanguage.googleapis.com：${this.apiMessage || '网络不可达'}。请检查网络或代理设置。`;
      case 'timeout':
        return `请求超时（${this.apiMessage || '长时间无响应'}）。请重试；若反复超时，请执行命令「文献阅读：从可用模型列表中选择翻译 / AI 问答模型」换用响应更快的模型。`;
      case 'aborted':
        return '已取消本次请求。';
      case 'empty':
        return `模型返回了空内容${this.model ? `（${this.model}）` : ''}。请重试；若持续出现请更换模型。`;
      case 'parse':
        return `模型返回的内容无法解析为预期格式：${this.apiMessage || '格式错误'}`;
      default:
        return `调用 Gemini 失败：${this.apiMessage || this.message || '未知错误'}`;
    }
  }

  public get retriable(): boolean {
    return (
      this.kind === 'rate-limit' ||
      this.kind === 'server' ||
      this.kind === 'network' ||
      this.kind === 'timeout' ||
      this.kind === 'empty'
    );
  }
}

export interface LlmTurn {
  role: 'user' | 'model';
  text: string;
}

export interface GenerateOptions {
  /** 主模型；若不可用会自动回退并在结果中报告 */
  model: string;
  /** 回退候选模型（顺序尝试） */
  fallbackModels?: string[];
  systemInstruction?: string;
  /** 多轮对话（按时间顺序） */
  turns: LlmTurn[];
  temperature?: number;
  maxOutputTokens?: number;
  /** 设为 true 时启用 JSON 输出；配合 responseSchema 使用 */
  jsonSchema?: object;
  /** Gemini 思考配置，原样透传到 generationConfig.thinkingConfig */
  thinkingConfig?: object;
  signal?: AbortSignal;
  /** 每收到一段文本就回调（流式渲染用） */
  onDelta?: (chunk: string) => void;
  /** 空闲超时：多久没收到任何新数据就放弃（毫秒） */
  idleTimeoutMs?: number;
  /** 整次请求的硬上限（毫秒） */
  totalTimeoutMs?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  /** 若发生了模型回退，这里是实际被跳过的模型及原因 */
  fellBackFrom?: { model: string; reason: string }[];
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  finishReason?: string;
  ttftMs?: number;
  totalMs: number;
  retries: number;
}

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

/**
 * 已下线/新用户不可用的模型：直接过滤，避免每次调用都白跑一轮 404。
 * 实测该 key 下 /v1beta/models 仍会列出 gemini-2.5-flash，但调用时返回
 * 404 "no longer available to new users"；gemini-1.5 与 2.0 系列则已完全从列表消失。
 */
const RETIRED_MODEL_RE = /^gemini-(1\.[0-5]|2\.0|2\.5)(-|$)/i;

/**
 * 默认模型（2026-02 在本机这把 key 上实测的结论）：
 *   可用且快：gemini-3.6-flash（首字约 1s，5 句严格对齐全部 PASS）
 *   可用但慢：gemini-3.5-flash（首字 14~19s，偶发 503）
 *   配额超限：gemini-3.8-flash / gemini-flash-latest / gemini-3.1-pro-preview（HTTP 429）
 *   已不可用：gemini-2.5-flash（404 no longer available to new users）
 * 不同 Key 的配额不同，所以这里只定默认值，真正的可用性靠回退链逐個试。
 */
export const DEFAULT_TRANSLATION_MODEL = 'gemini-3.6-flash';
export const DEFAULT_ASSISTANT_MODEL = 'gemini-3.6-flash';

/** 回退链：按"本机实测的速度与可用性"排序，逐个尝试直到成功 */
export const KNOWN_GOOD_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-pro-latest'
];


export function filterUsableModel(name: string | undefined | null): string | undefined {
  const m = (name || '').trim();
  if (!m) return undefined;
  if (RETIRED_MODEL_RE.test(m)) return undefined;
  return m;
}

/** 构建模型尝试链：用户配置优先，其次已知可用模型，最后补默认值 */
export function buildModelChain(configured?: string, extra?: string[]): string[] {
  const chain: string[] = [];
  const push = (m?: string) => {
    const f = filterUsableModel(m);
    if (f && !chain.includes(f)) chain.push(f);
  };
  push(configured);
  (extra || []).forEach(push);
  KNOWN_GOOD_MODELS.forEach(push);
  return chain;
}

interface RawCallResult {
  text: string;
  finishReason?: string;
  usage?: GenerateResult['usage'];
  ttftMs?: number;
}

/**
 * 核心：一次模型调用（内部流式），失败抛 LlmError
 */
export async function callGeminiStream(
  apiKey: string,
  model: string,
  opts: GenerateOptions
): Promise<RawCallResult> {
  if (!apiKey) {
    throw new LlmError({ kind: 'no-key' });
  }

  const body: any = {
    contents: opts.turns.map(t => ({
      role: t.role === 'model' ? 'model' : 'user',
      parts: [{ text: t.text }]
    }))
  };
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }

  const generationConfig: any = {};
  if (typeof opts.temperature === 'number') generationConfig.temperature = opts.temperature;
  if (typeof opts.maxOutputTokens === 'number') generationConfig.maxOutputTokens = opts.maxOutputTokens;
  if (opts.jsonSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = opts.jsonSchema;
  }
  if (opts.thinkingConfig) {
    generationConfig.thinkingConfig = opts.thinkingConfig;
  }
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  const url = `${GEMINI_HOST}/${API_VERSION}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const payload = JSON.stringify(body);

  const idleTimeoutMs = opts.idleTimeoutMs ?? 60000;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 300000;

  return new Promise<RawCallResult>((resolve, reject) => {
    let settled = false;
    let ttftMs: number | undefined;
    const startedAt = Date.now();
    let buffer = '';
    let accText = '';
    let finishReason: string | undefined;
    let usage: GenerateResult['usage'];
    let blockReason: string | undefined;
    let sawAnyPayload = false;

    const timers: NodeJS.Timeout[] = [];
    let req: http.ClientRequest | undefined;

    const cleanup = () => {
      timers.forEach(t => clearTimeout(t));
      timers.length = 0;
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    const fail = (err: LlmError) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { req?.destroy(); } catch {}
      reject(err);
    };

    const succeed = (value: RawCallResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const resetIdle = () => {
      timers.push(
        setTimeout(() => {
          fail(
            new LlmError({
              kind: 'timeout',
              model,
              apiMessage: `已等待 ${Math.round(idleTimeoutMs / 1000)} 秒未收到新数据`
            })
          );
        }, idleTimeoutMs)
      );
    };

    function onAbort() {
      fail(new LlmError({ kind: 'aborted', model }));
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new LlmError({ kind: 'aborted', model }));
        return;
      }
      opts.signal.addEventListener('abort', onAbort);
    }

    timers.push(
      setTimeout(() => {
        fail(
          new LlmError({
            kind: 'timeout',
            model,
            apiMessage: `整次请求超过 ${Math.round(totalTimeoutMs / 1000)} 秒上限`
          })
        );
      }, totalTimeoutMs)
    );

    const handlePayload = (jsonText: string) => {
      let json: any;
      try {
        json = JSON.parse(jsonText);
      } catch {
        return; // 忽略无法解析的分片，不让它毁掉整个流
      }
      sawAnyPayload = true;

      if (json.promptFeedback && json.promptFeedback.blockReason) {
        blockReason = String(json.promptFeedback.blockReason);
      }

      const cand = json.candidates && json.candidates[0];
      if (!cand) return;

      if (cand.finishReason) finishReason = String(cand.finishReason);
      if (json.usageMetadata) usage = json.usageMetadata;

      const parts = (cand.content && cand.content.parts) || [];
      for (const p of parts) {
        // 关键：Gemini 3.x 会返回 thought:true 的思考分片，绝不能混进正文
        if (p && p.thought === true) continue;
        const t = p && typeof p.text === 'string' ? p.text : '';
        if (!t) continue;
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
        accText += t;
        if (opts.onDelta) {
          try { opts.onDelta(t); } catch {}
        }
      }
    };

    let client: typeof https | typeof http;
    let parsed: URL;
    try {
      parsed = new URL(url);
      client = parsed.protocol === 'https:' ? https : http;
    } catch (e: any) {
      reject(new LlmError({ kind: 'invalid-request', apiMessage: `URL 解析失败: ${e.message}` }));
      return;
    }

    req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Accept': 'text/event-stream',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 400) {
          let errData = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (errData += c));
          res.on('end', () => {
            fail(classifyHttpError(status, errData, model));
          });
          res.on('error', (e: any) => {
            fail(new LlmError({ kind: 'network', model, apiMessage: e.message }));
          });
          return;
        }

        res.setEncoding('utf8');
        resetIdle();

        res.on('data', (chunk: string) => {
          if (settled) return;
          resetIdle();
          buffer += chunk;

          // 按行切分 SSE；不完整的一行留到下次
          let nlIdx: number;
          while ((nlIdx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
            buffer = buffer.slice(nlIdx + 1);
            if (!line) continue;
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            handlePayload(data);
          }
        });

        res.on('end', () => {
          if (settled) return;
          // 处理残留的不完整行
          const rest = buffer.trim();
          if (rest.startsWith('data:')) {
            const data = rest.slice(5).trim();
            if (data && data !== '[DONE]') handlePayload(data);
          }

          const totalMs = Date.now() - startedAt;

          if (!accText.trim()) {
            if (blockReason) {
              fail(new LlmError({ kind: 'safety', model, apiMessage: blockReason }));
              return;
            }
            if (finishReason && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/i.test(finishReason)) {
              fail(new LlmError({ kind: 'safety', model, apiMessage: finishReason }));
              return;
            }
            if (usage && usage.candidatesTokenCount && usage.candidatesTokenCount > 0) {
              // 有输出 token 但正文为空 → 几乎全是思考内容，属于异常
              fail(
                new LlmError({
                  kind: 'empty',
                  model,
                  apiMessage: `仅产生思考内容（reasoning tokens: ${usage.thoughtsTokenCount || usage.candidatesTokenCount}），正文为空。可尝试降低思考预算或更换模型。`
                })
              );
              return;
            }
            fail(
              new LlmError({
                kind: 'empty',
                model,
                apiMessage: sawAnyPayload ? '响应中没有文本内容' : '响应为空（未收到任何数据块）'
              })
            );
            return;
          }

          succeed({ text: accText, finishReason, usage, ttftMs });
        });

        res.on('error', (e: any) => {
          fail(new LlmError({ kind: 'network', model, apiMessage: e.message }));
        });
      }
    );

    req.on('error', (e: any) => {
      const code = e && e.code;
      if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code === 'EPIPE') {
        fail(new LlmError({ kind: 'network', model, apiMessage: `${code}: 无法连接 ${parsed.hostname}` }));
      } else {
        fail(new LlmError({ kind: 'network', model, apiMessage: `${code || ''} ${e.message || e}`.trim() }));
      }
    });

    req.write(payload);
    req.end();
  });
}

export interface OpenAICompatOptions {
  /** 形如 https://api.deepseek.com/v1 */
  endpoint: string;
  apiKey: string;
  model: string;
  systemInstruction?: string;
  turns: LlmTurn[];
  temperature?: number;
  maxOutputTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

/**
 * OpenAI 兼容协议（DeepSeek / 通义 / Kimi / 本地 vLLM 等）的流式调用。
 *
 * 与 callGeminiStream 保持**完全相同的语义**：同样是 SSE 流式（空闲超时才有意义）、
 * 同样支持取消、同样把 HTTP 错误分类成 LlmError，这样上层 UI 不需要分叉处理。
 * DeepSeek 的 `delta.reasoning_content`（思维链）不计入正文，只取 `delta.content`。
 */
export async function callOpenAICompatStream(opts: OpenAICompatOptions): Promise<RawCallResult> {
  const { endpoint, apiKey, model } = opts;
  if (!apiKey) throw new LlmError({ kind: 'no-key', model, apiMessage: '未配置自定义大模型 API Key' });
  if (!endpoint) throw new LlmError({ kind: 'invalid-request', model, apiMessage: '未配置自定义大模型端点' });

  const url = new URL(`${endpoint.replace(/\/+$/, '')}/chat/completions`);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const messages: any[] = [];
  if (opts.systemInstruction) messages.push({ role: 'system', content: opts.systemInstruction });
  opts.turns.forEach(t => {
    if (t.text) messages.push({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text });
  });

  const body: any = {
    model,
    messages,
    stream: true,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4
  };
  if (typeof opts.maxOutputTokens === 'number') body.max_tokens = opts.maxOutputTokens;
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  const payload = JSON.stringify(body);

  const idleTimeoutMs = opts.idleTimeoutMs ?? 60000;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 300000;

  return new Promise<RawCallResult>((resolve, reject) => {
    let settled = false;
    let ttftMs: number | undefined;
    const startedAt = Date.now();
    let buffer = '';
    let accText = '';
    let finishReason: string | undefined;
    const timers: NodeJS.Timeout[] = [];
    let req: http.ClientRequest | undefined;

    const cleanup = () => {
      timers.forEach(t => clearTimeout(t));
      timers.length = 0;
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    const fail = (err: LlmError) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        req?.destroy();
      } catch {}
      reject(err);
    };

    const succeed = (value: RawCallResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const resetIdle = () => {
      timers.push(
        setTimeout(() => {
          fail(
            new LlmError({
              kind: 'timeout',
              model,
              apiMessage: `已等待 ${Math.round(idleTimeoutMs / 1000)} 秒未收到新数据`
            })
          );
        }, idleTimeoutMs)
      );
    };

    function onAbort() {
      fail(new LlmError({ kind: 'aborted', model }));
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new LlmError({ kind: 'aborted', model }));
        return;
      }
      opts.signal.addEventListener('abort', onAbort);
    }

    timers.push(
      setTimeout(() => {
        fail(
          new LlmError({
            kind: 'timeout',
            model,
            apiMessage: `整次请求超过 ${Math.round(totalTimeoutMs / 1000)} 秒上限`
          })
        );
      }, totalTimeoutMs)
    );

    /** 处理一行 SSE */
    const handleSseLine = (raw: string): boolean => {
      const line = raw.trim();
      if (!line || line.startsWith(':') || !line.startsWith('data:')) return true;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return true;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return true; // 忽略坏分片，不让它毁掉整个流
      }
      if (json.error) {
        fail(
          new LlmError({
            kind: classifyHttpError(Number(json.error.code) || 0, data, model).kind,
            model,
            apiMessage: String(json.error.message || '流式返回错误')
          })
        );
        return false;
      }
      const choice = json.choices && json.choices[0];
      if (!choice) return true;
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
      const delta = choice.delta || choice.message || {};
      // 只取正文；DeepSeek reasoner 的 reasoning_content 属于思考内容，不算回答
      const piece = typeof delta.content === 'string' ? delta.content : '';
      if (piece) {
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
        accText += piece;
        if (opts.onDelta) {
          try {
            opts.onDelta(piece);
          } catch {}
        }
      }
      return true;
    };

    req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      res => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (errBody += c));
          res.on('end', () => fail(classifyHttpError(status, errBody, model)));
          res.on('error', (e: any) => fail(new LlmError({ kind: 'network', model, apiMessage: e.message })));
          return;
        }

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          resetIdle();
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const raw of lines) {
            if (!handleSseLine(raw)) return;
          }
        });

        res.on('end', () => {
          if (settled) return;
          if (buffer.trim() && !handleSseLine(buffer)) return;
          if (!accText.trim()) {
            fail(
              new LlmError({
                kind: 'empty',
                model,
                apiMessage: finishReason ? `返回内容为空（finish_reason=${finishReason}）` : '响应中没有文本内容'
              })
            );
            return;
          }
          if (finishReason && /content_filter/i.test(finishReason)) {
            fail(new LlmError({ kind: 'safety', model, apiMessage: finishReason }));
            return;
          }
          succeed({ text: accText, finishReason, ttftMs });
        });

        res.on('error', (e: any) => fail(new LlmError({ kind: 'network', model, apiMessage: e.message })));
      }
    );

    req.on('error', (e: any) => {
      const code = e && e.code;
      if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code === 'EPIPE') {
        fail(new LlmError({ kind: 'network', model, apiMessage: `${code}: 无法连接 ${url.hostname}` }));
      } else {
        fail(new LlmError({ kind: 'network', model, apiMessage: `${code || ''} ${e.message || e}`.trim() }));
      }
    });

    req.write(payload);
    req.end();
  });
}

/** 把 HTTP 错误响应体转成分类明确的 LlmError */
export function classifyHttpError(status: number, body: string, model: string): LlmError {  let apiStatus = '';
  let apiMessage = '';
  try {
    const j = JSON.parse(body);
    const err = j && j.error;
    if (err) {
      apiStatus = String(err.status || '');
      apiMessage = String(err.message || '');
    }
  } catch {
    apiMessage = (body || '').slice(0, 300);
  }

  const combined = `${apiStatus} ${apiMessage}`;
  const base = { status, model, apiMessage: apiMessage || `HTTP ${status}` };

  if (status === 401 || /UNAUTHENTICATED|API_KEY_INVALID|API key not valid/i.test(combined)) {
    return new LlmError({ ...base, kind: 'auth' }, body);
  }
  if (status === 403 || /PERMISSION_DENIED/i.test(combined)) {
    return new LlmError({ ...base, kind: 'permission' }, body);
  }
  if (status === 404 || /NOT_FOUND|is not found|not supported for|no longer available/i.test(combined)) {
    return new LlmError({ ...base, kind: 'not-found' }, body);
  }
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(combined)) {
    // 区分「按分钟限流（可重试）」与「配额/账单用尽（换模型才有意义）」
    const isHardQuota = /quota|billing|free_tier|plan and billing|exceeded your current quota/i.test(combined);
    const kind: LlmErrorKind = isHardQuota ? 'quota' : 'rate-limit';
    return new LlmError(
      {
        ...base,
        kind,
        tip: isHardQuota
          ? '该模型在此 API Key 上没有可用配额，建议在「文献阅读：从可用模型列表中选择」里换一个模型'
          : undefined
      },
      body
    );
  }
  if (status === 400 || /INVALID_ARGUMENT|FAILED_PRECONDITION/i.test(combined)) {
    return new LlmError({ ...base, kind: 'invalid-request' }, body);
  }
  if (status >= 500) {
    return new LlmError({ ...base, kind: 'server' }, body);
  }
  return new LlmError({ ...base, kind: 'unknown' }, body);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * 带模型回退与可重试重试的调用。
 * - 模型 404 → 静默切下一个候选，并记录到 fellBackFrom（由 UI 提示用户）
 * - 401/403 → 直接失败（换模型没意义）
 * - 429/5xx/网络/超时 → 同一模型退避重试
 */
export async function generate(
  apiKey: string,
  opts: GenerateOptions,
  log?: (msg: string) => void
): Promise<GenerateResult> {
  const chain = buildModelChain(opts.model, opts.fallbackModels);
  const fellBackFrom: { model: string; reason: string }[] = [];
  const startedAt = Date.now();

  let lastErr: LlmError | undefined;
  // 若配置的模型本身是已下线模型，直接说明
  if (opts.model && filterUsableModel(opts.model) === undefined) {
    fellBackFrom.push({ model: opts.model, reason: '该模型已下线/已从可用列表中移除' });
  }

  for (const model of chain) {
    let attempt = 0;
    const maxAttempts = 3;
    // 某些模型不支持某些 thinkingConfig（实测 gemini-3.5-flash-lite 对 thinkingBudget:0
    // 直接返回 400）。命中一次就摘掉 thinkingConfig 重试，而不是让整次翻译失败。
    let thinking: object | undefined = opts.thinkingConfig;
    let droppedThinking = false;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const r = await callGeminiStream(apiKey, model, { ...opts, thinkingConfig: thinking });
        if (model !== opts.model && opts.model) {
          fellBackFrom.push({ model: opts.model, reason: '主模型调用失败' });
        }
        return {
          text: r.text,
          model,
          fellBackFrom: fellBackFrom.length ? fellBackFrom : undefined,
          usage: r.usage,
          finishReason: r.finishReason,
          ttftMs: r.ttftMs,
          totalMs: Date.now() - startedAt,
          retries: attempt - 1
        };
      } catch (e: any) {
        const err: LlmError = e instanceof LlmError ? e : new LlmError({ kind: 'unknown', model, apiMessage: e?.message });
        lastErr = err;

        if (err.kind === 'aborted') throw err;

        if (err.kind === 'not-found') {
          if (log) log(`[llm] 模型 ${model} 不可用：${err.apiMessage}，切换到下一个候选`);
          break; // 换模型
        }

        if (err.kind === 'auth' || err.kind === 'permission') {
          // 换模型不会有帮助
          throw err;
        }

        if (err.kind === 'invalid-request') {
          if (thinking && !droppedThinking) {
            droppedThinking = true;
            thinking = undefined;
            if (log) log(`[llm] ${model} 拒绝 thinkingConfig（${err.apiMessage}），去掉思考参数重试`);
            continue;
          }
          throw err;
        }

        if (err.retriable && attempt < maxAttempts) {
          const backoff = err.kind === 'rate-limit' ? 1500 * attempt : 700 * attempt;
          if (log) log(`[llm] ${model} 第 ${attempt} 次失败（${err.kind}），${backoff}ms 后重试`);
          await sleep(backoff);
          continue;
        }

        break; // 换模型
      }
    }
    if (lastErr && (lastErr.kind === 'auth' || lastErr.kind === 'permission' || lastErr.kind === 'invalid-request')) {
      throw lastErr;
    }
    if (chain.indexOf(model) < chain.length - 1) {
      fellBackFrom.push({ model, reason: lastErr ? lastErr.kind : '失败' });
    }
  }

  throw lastErr || new LlmError({ kind: 'unknown', apiMessage: '所有候选模型均失败' });
}

/** 让 UI 能在设置里列出真实可用模型 */
let modelListCache: { at: number; models: string[] } | undefined;

export async function listAvailableModels(apiKey: string, force = false): Promise<string[]> {
  if (!apiKey) throw new LlmError({ kind: 'no-key' });
  if (!force && modelListCache && Date.now() - modelListCache.at < 10 * 60 * 1000) {
    return modelListCache.models;
  }
  const raw = await new Promise<string>((resolve, reject) => {
    const url = `${GEMINI_HOST}/${API_VERSION}/models?pageSize=200`;
    const req = https.request(
      url,
      { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
      (res) => {
        const status = res.statusCode || 0;
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (status >= 400) {
            reject(classifyHttpError(status, data, '(models list)'));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', (e: any) => reject(new LlmError({ kind: 'network', apiMessage: e.message })));
    req.end();
  });

  const json = JSON.parse(raw);
  const models: string[] = (json.models || [])
    .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m: any) => String(m.name || '').replace(/^models\//, ''))
    .filter((n: string) => n && !/image|tts|transcribe|lyria|robotics|computer-use|embedding/i.test(n))
    .sort();

  modelListCache = { at: Date.now(), models };
  return models;
}
