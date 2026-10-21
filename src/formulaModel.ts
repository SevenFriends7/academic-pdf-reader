/**
 * 本地公式模型客户端（Python sidecar 的宿主侧管理）。
 *
 * ## 为什么要有这一层
 *
 * 插件的公式 LaTeX 一直有两个来源：
 *   ① 本地数学层：按 PDF 字体族 + 几何位置**确定性**拼装（`media/viewer.js` 的 math layer）；
 *   ② 云端视觉模型：整页图 → JSON（`segmentationEngine: 'vision'`）。
 *
 * ①的结构还原力有天花板：逐字符查表**不可能**知道根号管到哪里、分式的分子分母在哪，
 * 实测就是 `softmax(√)` 这种"被开方数永远是空的"。②则要联网、要钱、还要等十几秒。
 *
 * 本地识别器正好卡在中间：给定一小块裁图，它能把 `\frac{QK^{tr}}{\sqrt{C}}` 一次给对
 * （见 `formula_model_probe/FINDINGS.md` 的实测对照）。但**它不会找框**——
 * 框裁歪了就编造，所以框永远由前端用文本层算，这里只负责"图进、LaTeX 出"。
 *
 * ## 为什么是子进程 + stdio，而不是 HTTP
 *
 * · 不占端口：用户同时开几个 VS Code 窗口不会互相抢端口，也不会弹防火墙授权；
 * · 生命周期天然绑定：扩展宿主一退，子进程跟着走（sidecar 另有 --parent-pid 兜底轮询）；
 * · 不需要额外依赖：不引 express / ws，逐行 JSON 就够。
 *
 * ## 为什么是串行队列
 *
 * Paddle 的 predictor 不是线程安全的，且一页 5~20 条公式并发送进去只会把 CPU 打满、
 * 单条延迟反而更长。这里严格串行：前端一次送一批，这里一条一条发。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';

export interface FormulaModelSettings {
  enabled: boolean;
  pythonPath: string;
  modelName: string;
  /** 单条公式识别的超时（毫秒） */
  timeoutMs: number;
  /** 空闲多久后释放子进程（毫秒），0 = 不释放 */
  idleTimeoutMs: number;
}

export interface FormulaRecognizeItem {
  /** 前端自己的标识（通常是 `${page}_${paraId}`），原样回传 */
  key: string;
  imageBase64: string;
  mime?: string;
}

export interface FormulaRecognizeResult {
  key: string;
  latex: string;
  raw: string;
  ms: number;
  error?: string;
}

export interface FormulaModelStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  model: string;
  loadMs: number;
  avgMs: number;
  count: number;
  /** 最近一次失败原因（给设置页/状态栏用） */
  lastError: string;
  pid?: number;
}

/**
 * sidecar 输出的一行。
 *
 * 刻意写成**一个宽类型**而不是可辨识联合：协议是"事件行 + 应答行"混在一条流里，
 * 联合类型在这里只会让每个取字段的地方都要先窄化一次，而字段本来就是可选的。
 */
type SidecarMessage = {
  event?: 'alive' | 'ready' | 'fatal';
  id?: number;
  ok?: boolean;
  key?: string;
  latex?: string;
  raw?: string;
  ms?: number;
  error?: string;
  trace?: string;
  pid?: number;
  model?: string;
  loadMs?: number;
  count?: number;
  avgMs?: number;
};

const DEFAULT_SETTINGS: FormulaModelSettings = {
  enabled: false,
  pythonPath: '',
  modelName: 'PP-FormulaNet_plus-S',
  timeoutMs: 45000,
  idleTimeoutMs: 10 * 60 * 1000
};

/**
 * 从工作区配置读设置。
 * 单独抽出来是为了让"配置改了要不要重启"这件事有个唯一判据（见 onConfigChanged）。
 */
export function readFormulaModelSettings(): FormulaModelSettings {
  const cfg = vscode.workspace.getConfiguration('academicReader');
  return {
    enabled: cfg.get<boolean>('formulaModel.enabled', DEFAULT_SETTINGS.enabled),
    pythonPath: (cfg.get<string>('formulaModel.pythonPath', DEFAULT_SETTINGS.pythonPath) || '').trim(),
    modelName: (cfg.get<string>('formulaModel.model', DEFAULT_SETTINGS.modelName) || '').trim() || DEFAULT_SETTINGS.modelName,
    timeoutMs: Math.max(3000, cfg.get<number>('formulaModel.timeoutMs', DEFAULT_SETTINGS.timeoutMs)),
    idleTimeoutMs: Math.max(0, cfg.get<number>('formulaModel.idleTimeoutMs', DEFAULT_SETTINGS.idleTimeoutMs))
  };
}

/** 影响"进程本身"的配置项——变了必须重启子进程，否则用户改了路径却还在用旧进程 */
function processSignature(s: FormulaModelSettings): string {
  return `${s.pythonPath}|${s.modelName}`;
}

/**
 * 解析 Python 解释器路径。
 *
 * 空值时的候选顺序是刻意的：先 `python`（用户把 Python 装进 PATH 的常规情况），
 * 再 `py`（Windows 官方安装器的启动器，能自动挑版本），然后是几个常见安装位置——
 * 实测这台机器上 `python` 指向的是 Store 占位符，真正的解释器在 `D:\python\python3.13`。
 *
 * 不扫全盘、不猜 venv 目录名：猜错会在几十个路径上挨个超时，不如给几个高概率的再让用户填。
 */
function pythonCandidates(configured: string): string[] {
  if (configured) return [configured];
  const list = ['python'];
  if (process.platform === 'win32') {
    list.push('py', 'python3');
    const env = process.env;
    // conda / venv 已激活时，优先用当前环境的解释器（里面大概率有 paddleocr）
    if (env.CONDA_PREFIX) list.push(path.join(env.CONDA_PREFIX, 'python.exe'));
    if (env.VIRTUAL_ENV) list.push(path.join(env.VIRTUAL_ENV, 'Scripts', 'python.exe'));
    for (const v of ['3.13', '3.12', '3.11', '3.10']) {
      list.push(`D:/python/python${v}/python.exe`);
      list.push(`C:/python/python${v}/python.exe`);
      list.push(`C:/Python${v.replace('.', '')}/python.exe`);
    }
    list.push('C:/ProgramData/anaconda3/python.exe');
  } else {
    list.push('python3');
    if (process.env.CONDA_PREFIX) list.push(path.join(process.env.CONDA_PREFIX, 'bin', 'python'));
  }
  return list;
}

/**
 * 探测"装了 paddleocr 的那个 Python"，给一键启用命令用。
 *
 * 【为什么是同步的】它只在用户主动点命令时跑一次，走的是 QuickPick 之后的交互流程，
 * 阻塞一两秒换取"不用处理 Promise + 取消"的简单逻辑是划算的。
 * 每个候选最多等 25 秒——`import paddleocr` 本身就要 2~4 秒（paddle 会加载一堆算子库）。
 */
export function detectPaddlePython(configured: string): { path: string; version: string } | null {
  for (const cmd of pythonCandidates(configured)) {
    let r: ReturnType<typeof spawnSync> | undefined;
    try {
      r = spawnSync(cmd, ['-c', 'import paddleocr;print(paddleocr.__version__)'], {
        encoding: 'utf8',
        timeout: 25000,
        windowsHide: true
      });
    } catch {
      continue;
    }
    if (r && r.status === 0) {
      const version = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      return { path: cmd, version };
    }
  }
  return null;
}

export class FormulaModelClient implements vscode.Disposable {  private proc: ChildProcessWithoutNullStreams | undefined;
  private rl: readline.Interface | undefined;
  private state: FormulaModelStatus['state'] = 'stopped';
  private readyPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((e: Error) => void) | undefined;
  private status: FormulaModelStatus = {
    state: 'stopped',
    model: '',
    loadMs: 0,
    avgMs: 0,
    count: 0,
    lastError: ''
  };
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: SidecarMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderrTail: string[] = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private signature = '';
  /**
   * 最近一次启动失败的时间。
   *
   * 【为什么需要冷却】Python 环境没装对（没装 paddleocr、路径填错）时，
   * 每次翻页都会触发一次 `ensureReady` → spawn → 失败。而 spawn 一个 python
   * 本身就要几百毫秒到几秒，用户会感觉"每翻一页都卡一下"。
   * 失败后一分钟内直接返回同一个错误，不再尝试。
   */
  private failedAt = 0;
  private static readonly RETRY_COOLDOWN_MS = 60000;
  /** 每次 spawn 递增；用来丢弃"上一次尝试"迟到的 exit / error 事件 */
  private spawnSeq = 0;
  /** 串行队列：保证同时只有一条 recognize 在飞 */
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly log: (msg: string) => void) {
    this.signature = processSignature(readFormulaModelSettings());
  }

  dispose(): void {
    this.disposed = true;
    this.closeIdleTimer();
    this.kill();
  }

  getStatus(): FormulaModelStatus {
    return { ...this.status, state: this.state };
  }

  /**
   * 配置变更处理：返回 true 表示需要通知用户重启才生效（进程签名变了）。
   * 注意这里**不主动重启**——用户可能正在读一篇论文，突然杀掉子进程会让正在识别的公式全部失败。
   */
  onConfigChanged(): boolean {
    const next = processSignature(readFormulaModelSettings());
    const changed = next !== this.signature;
    this.signature = next;
    return changed;
  }

  /** 预热。用户明确点了"启用"或打开了公式识别时才调用，避免白占 1GB 内存 */
  async warmup(): Promise<void> {
    const s = readFormulaModelSettings();
    if (!s.enabled) throw new Error('本地公式模型未启用（academicReader.formulaModel.enabled）');
    await this.ensureReady(s);
  }

  /**
   * 批量识别。**永远不抛错**：单条失败只体现在该条的 `error` 上。
   * 调用方（webview）拿到的数组长度与入参一致，按 key 对回去即可。
   */
  async recognizeBatch(items: FormulaRecognizeItem[]): Promise<FormulaRecognizeResult[]> {
    const s = readFormulaModelSettings();
    if (!s.enabled) {
      return items.map(it => ({ key: it.key, latex: '', raw: '', ms: 0, error: '本地公式模型未启用' }));
    }
    if (items.length === 0) return [];
    try {
      await this.ensureReady(s);
    } catch (e: any) {
      const msg = e?.message || String(e);
      return items.map(it => ({ key: it.key, latex: '', raw: '', ms: 0, error: msg }));
    }

    const out: FormulaRecognizeResult[] = [];
    for (const it of items) {
      const r = await this.enqueueRecognize(it, s);
      out.push(r);
    }
    this.touchIdle(s);
    return out;
  }

  // ---------------------------------------------------------------------------

  private enqueueRecognize(it: FormulaRecognizeItem, s: FormulaModelSettings): Promise<FormulaRecognizeResult> {
    const run = () => this.doRecognize(it, s);
    // 串成一条链：前一条不论成败都继续下一条
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async doRecognize(it: FormulaRecognizeItem, s: FormulaModelSettings): Promise<FormulaRecognizeResult> {
    const t0 = Date.now();
    try {
      const msg = await this.send({ cmd: 'recognize', key: it.key, image_b64: it.imageBase64, mime: it.mime || 'image/png' }, s.timeoutMs);
      if (!msg || msg.ok === false) {
        return { key: it.key, latex: '', raw: '', ms: Date.now() - t0, error: msg?.error || '识别失败' };
      }
      return {
        key: it.key,
        latex: String(msg.latex || ''),
        raw: String(msg.raw || ''),
        ms: Number(msg.ms) || Date.now() - t0
      };
    } catch (e: any) {
      return { key: it.key, latex: '', raw: '', ms: Date.now() - t0, error: e?.message || String(e) };
    }
  }

  private ensureReady(s: FormulaModelSettings): Promise<void> {
    if (this.state === 'ready' && this.proc) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    if (this.failedAt && Date.now() - this.failedAt < FormulaModelClient.RETRY_COOLDOWN_MS) {
      return Promise.reject(new Error(this.status.lastError || '本地公式模型不可用'));
    }

    this.state = 'starting';
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.spawnWithCandidates(s);
    return this.readyPromise;
  }

  /**
   * 逐个候选解释器尝试。
   *
   * 【为什么不是"启动失败就报错"】Windows 上 `python` 很可能是 Microsoft Store 的占位符
   * （跑起来直接打开应用商店、退出码 9009），而 `py` 才是真解释器。
   * 这种情况下静默换下一个候选对用户最友好，只有全部失败才把最后一个错误抛出去。
   */
  private spawnWithCandidates(s: FormulaModelSettings): void {
    const candidates = pythonCandidates(s.pythonPath);
    const tryAt = (i: number) => {
      if (i >= candidates.length) {
        this.fail(new Error(`找不到可用的 Python（试过：${candidates.join(', ')}）。请在设置里填写 academicReader.formulaModel.pythonPath`));
        return;
      }
      this.start(candidates[i], s, () => {
        this.log(`候选解释器不可用，换下一个：${candidates[i]}`);
        tryAt(i + 1);
      });
    };
    tryAt(0);
  }

  private start(pythonCmd: string, s: FormulaModelSettings, onMissing: () => void): void {
    this.kill();
    this.stderrTail = [];
    const script = path.join(this.extensionRoot(), 'py', 'formula_sidecar.py');
    this.log(`启动公式旁路进程: ${pythonCmd} ${script} --model ${s.modelName}`);

    /*
     * 【为什么要序号】候选链里前一个解释器 ENOENT 之后会紧接着起下一个，
     * 而前一个进程的 `exit` 事件可能在新进程起来之后才到。没有序号的话，
     * 那个迟到的 exit 会把刚起的新进程判成"崩了"，直接把状态打成 failed。
     */
    const seq = ++this.spawnSeq;

    const proc = spawn(pythonCmd, [script, '--model', s.modelName, '--parent-pid', String(process.pid)], {
      cwd: this.extensionRoot(),
      windowsHide: true,
      env: {
        ...process.env,
        // 模型已在本机缓存时别再让 paddlex 去远端校验（离线环境会卡住十几秒）
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
    });
    this.proc = proc;

    proc.on('error', (e: any) => {
      if (seq !== this.spawnSeq) return;
      // ENOENT 就是"这个解释器不存在"，交给候选链处理；
      // 其它错误（权限、DLL 缺失）换解释器也没用，直接失败并保留原因。
      if (e && e.code === 'ENOENT') {
        onMissing();
        return;
      }
      this.fail(new Error(`启动 Python 失败（${pythonCmd}）：${e?.message || e}`));
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });

    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on('line', (line: string) => this.onLine(line));

    proc.on('exit', (code, signal) => {
      // 迟到的 exit：新候选已经起来了，这个事件属于上一个尝试，忽略
      if (seq !== this.spawnSeq) return;
      const wasReady = this.state === 'ready';
      this.proc = undefined;
      this.rl?.close();
      this.rl = undefined;
      // 所有在飞的请求立刻失败，别让前端等满 45 秒
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`公式旁路进程已退出（code=${code}, signal=${signal}）`));
      }
      this.pending.clear();
      this.readyPromise = undefined;
      if (!this.disposed && !wasReady) {
        /*
         * 【必须在这里 reject】python 在 import 阶段就崩（没装 paddleocr、PADDLE 与 numpy 版本打架）
         * 时它连 `alive` 都发不出来，宿主收不到任何事件；不在这里把 readyReject 调掉，
         * `ensureReady()` 返回的 Promise 就永远挂着，调用方（warmup / recognizeBatch）会一直等。
         * 同时把 stderr 尾巴带上——`ModuleNotFoundError: No module named 'paddleocr'`
         * 比"进程退出 code=1"有用得多。
         */
        const tail = this.stderrTail.slice(-6).join('\n');
        this.fail(new Error(`公式旁路进程退出（code=${code}, signal=${signal}）${tail ? `\n${tail}` : ''}`));
        return;
      }
      this.state = 'stopped';
      if (!this.disposed) {
        this.log(`公式旁路进程退出 code=${code} signal=${signal}`);
      }
    });
  }

  private onLine(line: string): void {
    let msg: SidecarMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      // sidecar 承诺 stdout 只有协议行；出现杂质说明某个库又往 stdout 打了东西，记下来便于排查
      this.log(`[公式旁路] 非协议输出: ${line.slice(0, 200)}`);
      return;
    }
    const ev = (msg as any).event;
    if (ev === 'alive') {
      this.log(`公式旁路进程已启动 pid=${(msg as any).pid}`);
      return;
    }
    if (ev === 'ready') {
      const m = msg as any;
      this.state = 'ready';
      this.failedAt = 0;
      this.status = {
        state: 'ready',
        model: String(m.model || ''),
        loadMs: Number(m.loadMs) || 0,
        avgMs: Number(m.avgMs) || 0,
        count: Number(m.count) || 0,
        lastError: '',
        pid: m.pid
      };
      this.log(`公式模型就绪：${this.status.model}，加载 ${this.status.loadMs}ms`);
      this.readyResolve?.();
      this.readyPromise = undefined;
      return;
    }
    if (ev === 'fatal') {
      this.fail(new Error(`${(msg as any).error || '旁路进程初始化失败'}${(msg as any).trace ? `\n${(msg as any).trace}` : ''}`));
      return;
    }
    const id = (msg as any).id;
    if (typeof id === 'number' && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve(msg);
    }
  }

  private send(payload: Record<string, unknown>, timeoutMs: number): Promise<SidecarMessage> {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) return Promise.reject(new Error('公式旁路进程不可用'));
    const id = this.nextId++;
    return new Promise<SidecarMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`识别超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`写入旁路进程失败：${e?.message || e}`));
      }
    });
  }

  private fail(err: Error): void {
    this.state = 'failed';
    this.failedAt = Date.now();
    this.status.lastError = err.message;
    this.log(`公式模型不可用：${err.message}`);
    this.readyReject?.(err);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.readyPromise = undefined;
    this.kill();
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.rl?.close();
    this.rl = undefined;
    if (!proc) return;
    try {
      if (proc.stdin.writable) proc.stdin.write(JSON.stringify({ id: 0, cmd: 'shutdown' }) + '\n');
    } catch {
      /* 进程可能已经没了 */
    }
    // 给 sidecar 200ms 优雅退出（它要在 shutdown 后释放 paddle 的显存/内存），超时强杀
    const t = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 200);
    proc.once('exit', () => clearTimeout(t));
  }

  private closeIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * 空闲释放。
   *
   * plus-S 常驻约 900MB，plus-L 更多。用户可能只是打开论文看一眼公式就去打字了，
   * 让它一直挂着并不合适。下一次要用时重新加载（12 秒）比常驻更划算。
   */
  private touchIdle(s: FormulaModelSettings): void {
    this.closeIdleTimer();
    if (!s.idleTimeoutMs) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0) return;
      this.log(`公式旁路进程空闲 ${Math.round(s.idleTimeoutMs / 1000)}s，释放`);
      this.kill();
      this.state = 'stopped';
      this.readyPromise = undefined;
      this.status = { ...this.status, state: 'stopped' };
    }, s.idleTimeoutMs);
  }

  private extensionRoot(): string {
    // dist/extension.js 的上一级就是扩展根目录；开发态（tsc 输出到 out/）同样成立
    return path.resolve(__dirname, '..');
  }
}
