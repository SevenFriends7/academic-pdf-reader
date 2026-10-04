/**
 * Zotero 只读客户端（第一版：认领论文 + 元数据 + 逐页全文 + 批注读取）。
 *
 * 【为什么单独一个文件、且不 import vscode】
 * 这里全是纯逻辑（HTTP + 数据整形），放进 Node 单测就能真跑；一旦 import vscode 就只能靠 IDE 手测。
 *
 * 【为什么走本地 HTTP API 而不是直接读 zotero.sqlite / .zotero-ft-cache】
 * 1. 直接读库有官方明确警告：「Zotero 运行时修改数据库极易损坏库」，且 schema 随版本变；
 *    而 `/api/` 是 Zotero 自己实现的官方只读接口，不碰文件锁。
 * 2. 本机实测（Zotero 9.0.6）：`/api/` 默认关闭（pref `httpServer.localAPI.enabled=false`→403），
 *    打开后**本地读无需鉴权**；9.0.6 的本地 API 只有 GET（写接口是 Zotero 10+ 才有），
 *    所以我们这一版只读，不做回写。
 * 3. 附件的 fulltext 接口返回的 content 与 `.zotero-ft-cache` 逐字节一致，
 *    并附带 indexedPages/totalPages —— 页数对不上就能立刻判废，不会错位使用。
 *
 * 【与几何层的关系（重要，别重复踩坑）】
 * 本机实测 pdf.js 3.11 / 4.10 / 5.4 抽出的文本**逐字节相同**（换 pdf.js 版本救不了识别率），
 * 且坏字形（CambriaMath 把 W/C 解成 $/%）在 Zotero 全文里**同样是 $/%** ——
 * 所以 Zotero 全文**不能**当作"坏字形的解药"。它能给的是：
 *   ① 论文身份（标题/作者/年份/DOI/期刊）——比从 PDF 首页猜准得多；
 *   ② 按页边界的干净文本（可作 AI/翻译的参考上下文）；
 *   ③ 带**精确坐标**的批注（用户在 Zotero 里划过的高亮/笔记），可以搬进阅读器。
 * 公式的上下标/基线仍然只有本机几何层有 —— 永远不要把几何层换成 Zotero 全文。
 */

// fs 只用来读 prefs.js（判断开关状态）与列 profile 目录，不碰 Zotero 数据库。
// 静态 import 而不是 await import：本扩展是 cjs 打包（esbuild platform=node），
// 静态 import 在单测与产物里都能直接工作，动态 import 反而会引入一层没必要的异步包装。
import * as fs from 'fs';
import * as http from 'http';

export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType?: string;
}

export interface ZoteroItemData {
  key: string;
  version?: number;
  itemType?: string;
  title?: string;
  filename?: string;
  contentType?: string;
  parentItem?: string;
  url?: string;
  DOI?: string;
  date?: string;
  publicationTitle?: string;
  proceedingsTitle?: string;
  bookTitle?: string;
  journalAbbreviation?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  creators?: ZoteroCreator[];
  tags?: { tag: string }[];
  collections?: string[];
  /** 附件才有：`data.path` 形如 `storage:xxx.pdf` */
  path?: string;
}

export interface ZoteroItem {
  key: string;
  version?: number;
  links?: {
    self?: { href?: string };
    up?: { href?: string };
    enclosure?: { href?: string; type?: string; title?: string; length?: number };
  };
  meta?: { numChildren?: number; creatorSummary?: string; parsedDate?: string };
  data: ZoteroItemData;
}

export interface ZoteroAnnotation {
  key: string;
  data: {
    itemType?: string;
    key?: string;
    parentItem?: string;
    annotationType?: string; // highlight | underline | note | image | ink | text
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationPageLabel?: string;
    annotationSortIndex?: string;
    annotationPosition?: string; // JSON 字符串
    tags?: { tag: string }[];
  };
}

/** `annotationPosition` 解析后的形状（字段名来自 reader 源码：positionsEqual 读 pageIndex/rects/paths） */
export interface ZoteroAnnotationPosition {
  pageIndex?: number;
  rects?: number[][];
  paths?: unknown[];
  fontSize?: number;
  rotation?: number;
  [k: string]: unknown;
}

export interface ZoteroFullText {
  /** 逐页文本（按 \f 切开；Zotero 的页分隔符就是换页符，本机实测 10 页 PDF = 10 段） */
  pages: string[];
  indexedPages: number;
  totalPages: number;
  chars: number;
  /** 索引页数与 PDF 实际页数不一致 —— 对齐会漂，调用方必须判废 */
  pageCountMismatch: boolean;
}

export interface ZoteroMeta {
  title: string;
  creators: string;
  year: string;
  venue: string;
  doi: string;
  url: string;
  itemType: string;
  /** 人类可读的一行引用式，例如 `Yang et al. · 2021 · ICCV` */
  summary: string;
}

export interface ZoteroLink {
  attachmentKey: string;
  parentKey?: string;
  /** 命中的依据，便于排查"为什么认成了这一条" */
  matchedBy: 'path' | 'basename' | 'title' | 'size';
  fileName: string;
  meta: ZoteroMeta;
  fullText?: ZoteroFullText;
  annotations: ZoteroAnnotation[];
  /** localStorage 目录（拿不到就是 null，不影响只走 API 的功能） */
  storageDir: string | null;
}

export interface ZoteroDetectResult {
  /** 本地 API 可用（开了 pref 且 /api/ 返回 200） */
  available: boolean;
  /** 探测失败原因（给用户看的一句话） */
  reason?: 'not-running' | 'api-disabled' | 'error';
  message: string;
  /** 探测到的偏好设置文件（Windows 上多半是 %APPDATA%\Zotero\Zotero\Profiles\<随机>.default\prefs.js） */
  prefsPath: string | null;
  baseUrl: string;
  version?: string;
}

export interface ZoteroClientOptions {
  /** 默认 http://127.0.0.1:23119 */
  baseUrl?: string;
  /**
   * 注入的 fetch。默认用全局 fetch；单测里换成桩，就能在不起服务的前提下测全套逻辑。
   * 之所以要能注入：本仓库的纪律是"测试桩必须贴近真实语义"，
   * 而真起一个 Zotero 才能测的话，CI 上永远跑不了。
   */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 覆盖偏好设置文件路径（单测用） */
  prefsPath?: string;
}

export const DEFAULT_ZOTERO_BASE_URL = 'http://127.0.0.1:23119';

/** Zotero 打开本地 API 的偏好项（源码 defaults/preferences/zotero.js: `httpServer.localAPI.enabled`, 默认 false） */
export const ZOTERO_LOCAL_API_PREF = 'extensions.zotero.httpServer.localAPI.enabled';

// ---------------------------------------------------------------------------
// prefs.js 解析
// ---------------------------------------------------------------------------

/**
 * 从 prefs.js 文本里读一个布尔 pref。
 *
 * 为什么不用 `require` 或读 firefox 的 prefs 二进制：prefs.js 就是纯文本 `user_pref("a", true);`，
 * 一行正则足够；真正的坑在于**值可能不存在**（用户从没改过这个开关，prefs.js 里就没有这一行，
 * 此时必须回退到 Zotero 的默认值 false）——把"没写"当成"开了"会直接误导用户。
 */
export function readBoolPref(prefsText: string, pref: string): boolean | null {
  // 刻意不用模板字符串/正则字面量拼装：这个函数要同时在 tsc、esbuild 和 node 单测里被解析，
  // 纯字符串拼接没有任何解析器歧义（此前用 String.raw 模板把 tsc 直接卡成 TS1160）。
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    'user_pref\\(\\s*["\']' + escapeRe(pref) + '["\']\\s*,\\s*(true|false)\\s*\\)'
  );
  const m = re.exec(prefsText || '');
  if (!m) return null;
  return m[1] === 'true';
}

/**
 * 候选的 Zotero 偏好设置文件位置（按命中概率排序）。
 * Windows 实测：`%APPDATA%\Zotero\Zotero\Profiles\<随机>.default\prefs.js`。
 */
export function zoteroPrefsCandidates(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const appData = env.APPDATA;
  const home = env.USERPROFILE || env.HOME;
  const join = (...p: string[]) => p.filter(Boolean).join('\\');
  if (appData) {
    out.push(join(appData, 'Zotero', 'Zotero', 'Profiles'));
  }
  if (home) {
    // Linux / macOS 布局与便携版
    out.push(join(home, '.zotero', 'zotero'));
    out.push(join(home, 'Library', 'Application Support', 'Zotero', 'Profiles'));
    out.push(join(home, 'Zotero'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

/** 把路径/文件名归一化到可比较的形式：去掉 URL 编码、统一斜杠、转小写、压空白 */
export function normalizePathText(s: string | undefined | null): string {
  if (!s) return '';
  let t = String(s).trim();
  try {
    t = decodeURIComponent(t);
  } catch {
    /* 不是合法百分号编码（真实文件名里确实有裸 % ）——保持原样 */
  }
  return t.replace(/\\/g, '/').replace(/\s+/g, ' ').toLowerCase();
}

/** 从 `file:///C:/Users/x/Zotero/storage/KEY/Name.pdf` 取文件名与 storage key */
export function parseFileUrl(href: string | undefined): { fileName: string; storageKey: string; filePath: string } {
  const t = normalizePathText(href).replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
  const parts = t.split('/').filter(Boolean);
  const fileName = parts.length ? parts[parts.length - 1] : '';
  const at = parts.lastIndexOf('storage');
  // storage key 必须取**原始大小写**：它是 Zotero 的目录名，`nqi6n4ap` 与 `NQI6N4AP`
  // 在大小写敏感的文件系统上不是同一个目录。normalizePathText 为了比对把整串转了小写，
  // 所以这里从原始 href 里再取一次。（此坑由单测抓出：首个版本返回了小写的 key）
  const raw = String(href || '');
  const rawParts = raw.split(/[\\/]/).filter(Boolean);
  const rawAt = rawParts.lastIndexOf('storage');
  const storageKey = rawAt >= 0 && rawParts.length > rawAt + 1 ? rawParts[rawAt + 1] : (at >= 0 && parts.length > at + 1 ? parts[at + 1] : '');
  return { fileName, storageKey, filePath: t };
}

/**
 * 判定一个 Zotero 条目是不是我们正在读的那个 PDF。
 *
 * 优先级（实测过的可靠度从高到低）：
 *   ① 完整路径相同（Zotero 库里指向同一个文件，比如用户直接从 Zotero 同步目录打开的）
 *   ② 文件名相同（跨机器/换目录后仍然成立；学术 PDF 文件名带作者年份，碰撞概率低但**不是零**）
 *   ③ 文件大小相同（兜底，必须配合文件名相似度，否则任何同大小文件都会命中）
 * 返回 null = 不确定，调用方必须**什么都不做**而不是猜一个：
 * 认错论文会把别人的元数据与批注搬到这篇上，比不认更糟。
 */
export function matchZoteroItem(
  pdfPathOrName: string,
  fileSize: number | undefined,
  items: ZoteroItem[]
): { item: ZoteroItem; matchedBy: ZoteroLink['matchedBy'] } | null {
  const want = normalizePathText(pdfPathOrName);
  const wantName = want.split('/').filter(Boolean).pop() || '';
  const candidates = items.filter(it => (it.data?.contentType || '').toLowerCase() === 'application/pdf');

  // ① 完整路径
  for (const it of candidates) {
    const { filePath } = parseFileUrl(it.links?.enclosure?.href);
    if (filePath && want && filePath === want) return { item: it, matchedBy: 'path' };
  }
  // ② 文件名
  const byName = candidates.filter(it => {
    const { fileName } = parseFileUrl(it.links?.enclosure?.href);
    return fileName && wantName && fileName === wantName;
  });
  if (byName.length === 1) return { item: byName[0], matchedBy: 'basename' };
  if (byName.length > 1 && fileSize) {
    // 同名多个（同一篇论文存了两遍）：用大小消歧，仍不唯一就放弃
    const sized = byName.filter(it => it.links?.enclosure?.length === fileSize);
    if (sized.length === 1) return { item: sized[0], matchedBy: 'size' };
  }
  // ③ 大小完全相同 ← 兜底，也是**真实高频场景**：
  //    用户从浏览器下载的 "2103.10088.pdf" 拖进 Zotero 被改名成 "Yang 等 - Associating….pdf"，
  //    两边文件名毫无关系，但字节数一模一样。文件大小相同 + 库里唯一 → 认。
  //    单测抓出的坑：早期版本还要求"文件名主干相似"，结果这种改名场景永远认不出来。
  if (fileSize) {
    const sized = candidates.filter(it => it.links?.enclosure?.length === fileSize);
    if (sized.length === 1) return { item: sized[0], matchedBy: 'size' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 元数据整形
// ---------------------------------------------------------------------------

function creatorName(c: ZoteroCreator): string {
  if (c?.name) return c.name;
  const last = (c?.lastName || '').trim();
  const first = (c?.firstName || '').trim();
  if (last && first) return `${last} ${first}`;
  return last || first || '';
}

/** 从 `2021-10-01 2021` 这类 Zotero 日期里取四位年份 */
export function yearFromZoteroDate(date: string | undefined): string {
  const m = /(1[6-9]\d{2}|20\d{2})/.exec(date || '');
  return m ? m[1] : '';
}

/**
 * 附件的 title 是不是"没有信息量的占位标题"。
 *
 * 为什么非要判这个：Zotero 导入 PDF 时附件 title 默认就是 `PDF` / `Full Text PDF` / `Snapshot`，
 * 用户手动改过就可能是单个字符（如 `T`）。把这种串当论文标题显示，比显示文件名还糟。
 */
export function isPlaceholderTitle(title: string | undefined): boolean {
  const t = (title || '').trim();
  if (!t) return true;
  if (/^(pdf|full ?text( pdf)?|snapshot|attachment|document|untitled|全文|附件|文档|未知)$/i.test(t)) return true;
  // 单字符或纯符号：`T`、`-`、`1`
  if (t.length <= 1) return true;
  return false;
}

export function formatZoteroMeta(parent: ZoteroItem | undefined, attachment: ZoteroItem): ZoteroMeta {
  const d = parent?.data || attachment.data || ({} as ZoteroItemData);
  const creators = (d.creators || []).map(creatorName).filter(Boolean);
  const first = creators[0] || '';
  // 只取姓氏：BBT / Zotero 的 creatorSummary 也是这个口径
  const firstFamily = first.split(' ')[0] || first;
  const authors =
    creators.length === 0
      ? ''
      : creators.length === 1
        ? first
        : creators.length === 2
          ? `${creators[0]} & ${creators[1]}`
          : `${firstFamily} et al.`;
  const year = yearFromZoteroDate(d.date);
  const venue = d.publicationTitle || d.proceedingsTitle || d.bookTitle || d.journalAbbreviation || d.publisher || '';
  // 标题优先级：父条目 title → 附件自身 title（非占位）→ 附件文件名（去扩展名）。
  const attachmentTitle = (attachment.data?.title || '').trim();
  const fromFileName = (attachment.links?.enclosure?.title || '').replace(/\.pdf$/i, '').trim();
  const title =
    (d.title || '').trim() ||
    (isPlaceholderTitle(attachmentTitle) ? '' : attachmentTitle) ||
    fromFileName;
  const doi = (d.DOI || '').trim();
  const url = (d.url || '').trim();
  const summary = [authors, year, venue].filter(Boolean).join(' · ');
  return {
    title,
    creators: authors,
    year,
    venue,
    doi,
    url,
    itemType: d.itemType || '',
    summary
  };
}

// ---------------------------------------------------------------------------
// 批注
// ---------------------------------------------------------------------------

/** Zotero 的 annotationType → 阅读器自己的批注类型（阅读器只有 highlight/note 两种语义） */
export function mapAnnotationKind(annotationType: string | undefined): 'highlight' | 'note' | 'image' | 'ink' {
  switch ((annotationType || '').toLowerCase()) {
    case 'note':
    case 'text':
      return 'note';
    case 'image':
      return 'image';
    case 'ink':
      return 'ink';
    default:
      // highlight / underline 都是"划在文字上的"，阅读器侧统一按高亮画
      return 'highlight';
  }
}

/**
 * 解析 Zotero 的 `annotationPosition`（JSON 字符串）。
 *
 * 坐标口径（从 Zotero reader 源码实测确认，别凭印象）：
 *   `rects: [[x1,y1,x2,y2], ...]` 是 **PDF 用户空间点**（原点左下、y 向上，与 page.view 同单位），
 *   reader 里 `viewport.convertToViewportPoint(rect[0], rect[1])` 之后才变成屏幕坐标。
 * 所以搬进阅读器时必须翻 y：top = pageHeightPdf - y2, bottom = pageHeightPdf - y1。
 * 解析失败一律返回 null —— 宁可不画，也不要在错误的位置画一条"看起来对"的高亮。
 */
export function parseAnnotationPosition(raw: string | undefined | null): ZoteroAnnotationPosition | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj as ZoteroAnnotationPosition;
  } catch {
    return null;
  }
}

export interface RectTopDown {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把 Zotero 的 PDF 坐标矩形（左下原点）翻成"左上原点"的矩形，可直接乘缩放画到画布上 */
export function rectToTopDown(rect: number[], pageHeightPdf: number): RectTopDown | null {
  if (!Array.isArray(rect) || rect.length < 4) return null;
  const nums = rect.slice(0, 4).map(Number);
  if (nums.some(n => !Number.isFinite(n))) return null;
  const x1 = Math.min(nums[0], nums[2]);
  const x2 = Math.max(nums[0], nums[2]);
  const y1 = Math.min(nums[1], nums[3]);
  const y2 = Math.max(nums[1], nums[3]);
  return { x: x1, y: pageHeightPdf - y2, w: x2 - x1, h: y2 - y1 };
}

/**
 * 阅读器自己的批注记录（与 media/viewer.js 里 paperData.annotations 的元素同形）。
 *
 * 【为什么必须逐字段对齐】`renderPageAnnotations` 直接读 `a.page` / `a.rects[].left` 等，
 * 少一个字段就是"批注在数据里、界面上看不到"。这些字段名是从 viewer.js 的实现里抄出来的，
 * 不是猜的。
 * - `rects`：**未缩放**的 PDF 点坐标（渲染时各自乘 currentScale），与 Zotero 的 rects 同单位
 * - `id`：用 `zotero-<附件key>-<批注key>`，下次打开时用它判重，避免同一批注被反复追加
 */
export interface ViewerAnnotation {
  id: string;
  zoteroKey: string;
  page: number;
  text: string;
  color: string;
  note: string;
  rects: RectTopDown[];
  source: 'zotero';
  annotationType: string;
  tags: string[];
}

/**
 * Zotero 的批注色是 `#ffd400` 这种十六进制；阅读器的 `.highlight-mark` 只认自己那套色名。
 *
 * 【为什么先查表再算色相】Zotero 的颜色是**固定的九色盘**，而"按 RGB 大小关系猜色名"的启发式
 * 会把它的默认黄 `#ffd400` 判成橙（实测：R−G=0 但 G−B=212，早期的 `g-b>40` 分支直接命中）。
 * 所以先精确匹配调色盘；用户自定义色才退回 HSV 色相判断。
 */
const ZOTERO_PALETTE: Record<string, string> = {
  'ffd400': 'yellow',
  'ff6666': 'red',
  '5fb236': 'green',
  '2ea8e5': 'blue',
  'a28ae5': 'magenta',
  'e56eee': 'magenta',
  'f19837': 'orange',
  'aaaaaa': 'gray',
  'cccccc': 'gray'
};

export function mapAnnotationColor(hex: string | undefined): string {
  const h = (hex || '').toLowerCase().replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/.test(h)) return 'yellow';
  if (ZOTERO_PALETTE[h]) return ZOTERO_PALETTE[h];

  // 自定义颜色：走 HSV 色相（比"比较 RGB 大小"稳，尤其是黄/橙这类相邻色）
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 0.08) return 'gray'; // 近灰
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 345) return 'red';
  if (hue < 45) return 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 165) return 'green';
  if (hue < 255) return 'blue';
  if (hue < 290) return 'magenta';
  return 'red';
}

/**
 * 把 Zotero 批注批量转换成阅读器批注。
 *
 * 【为什么要传整页高度表而不是逐条算】`rects` 是 PDF 用户空间坐标（原点在**左下**），
 * 而阅读器的 `rects` 是左上原点 —— 转换需要该页的 PDF 高度。高度只能由 webview 侧的
 * pdf.js 给出（`page.getViewport({scale:1}).height`），所以这里按页索引查表。
 *
 * 【页高拿不到就整条丢弃】宁可少一条高亮，也不要把 y 翻错 —— 翻错的高亮会画在
 * 完全无关的段落上，用户会以为那是自己标错的。
 */
export function toViewerAnnotations(
  annotations: ZoteroAnnotation[],
  pageHeights: Record<number, number>,
  attachmentKey: string,
  pageLabelToIndex?: Record<string, number>
): ViewerAnnotation[] {
  const out: ViewerAnnotation[] = [];
  for (const a of annotations) {
    const d = a?.data || ({} as ZoteroAnnotation['data']);
    const pos = parseAnnotationPosition(d.annotationPosition);
    if (!pos) continue;

    // 页码：优先 pageIndex（0 基，与 Zotero reader 的语义一致），
    // 没有就退回页面标签表（`annotationPageLabel` 存在时形如 "1"、"iv"）。
    let pageIndex: number | undefined = typeof pos.pageIndex === 'number' ? pos.pageIndex : undefined;
    if (pageIndex === undefined && d.annotationPageLabel && pageLabelToIndex) {
      const hit = pageLabelToIndex[String(d.annotationPageLabel).trim()];
      if (typeof hit === 'number') pageIndex = hit;
    }
    if (pageIndex === undefined || pageIndex < 0) continue;

    const page = pageIndex + 1; // 阅读器是 1 基
    const pageHeight = pageHeights[page];
    if (!Number.isFinite(pageHeight) || pageHeight <= 0) continue;

    const rects: RectTopDown[] = [];
    for (const r of pos.rects || []) {
      const box = rectToTopDown(r, pageHeight);
      // 丢掉零面积矩形：Zotero 会给某些批注塞退化矩形（宽或高为 0），画出来看不见还占点击区
      if (box && box.w > 0.5 && box.h > 0.5) rects.push(box);
    }
    if (rects.length === 0) continue;

    const text = String(d.annotationText || '').trim();
    const comment = String(d.annotationComment || '').trim();
    const kind = mapAnnotationKind(d.annotationType);
    out.push({
      id: `zotero-${attachmentKey}-${a.key}`,
      zoteroKey: a.key,
      page,
      // 没有选中文字的批注（方框/墨迹/纯笔记）用注释或类型当标题，否则列表里是一条空白
      text: text || comment || (kind === 'image' ? '（图片批注）' : kind === 'ink' ? '（手写批注）' : '（无文字批注）'),
      color: mapAnnotationColor(d.annotationColor),
      note: comment,
      rects,
      source: 'zotero',
      annotationType: String(d.annotationType || ''),
      tags: (d.tags || []).map(t => t?.tag).filter(Boolean) as string[]
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 全文
// ---------------------------------------------------------------------------

/**
 * 切页 + 校验页数。
 *
 * 【为什么必须校验】Zotero 全文是**按页存**的，但我们只拿得到一整块字符串；
 * 一旦索引的页数与本地 PDF 页数不一致（换过文件、只索引了前 N 页），
 * 按页码取文本就会**整体错位**，而且是静默的。所以这里把不一致显式标出来交调用方判废。
 */
export function splitFullTextPages(content: string, indexedPages: number, totalPages: number, expectedPages?: number): ZoteroFullText {
  const text = content || '';
  const pages = text.split('\f');
  // split 会在结尾多出一个空段的情况：丢掉纯空白尾巴（Zotero 实测 10 页 = 10 段，无尾空段）
  while (pages.length > 1 && pages[pages.length - 1].trim() === '') pages.pop();
  const expected = typeof expectedPages === 'number' && expectedPages > 0 ? expectedPages : totalPages;
  return {
    pages,
    indexedPages,
    totalPages,
    chars: text.length,
    pageCountMismatch: pages.length !== expected
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface RequestResult {
  ok: boolean;
  status: number;
  text: string;
  headers?: Headers;
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/**
 * 不依赖全局 fetch 的兜底 GET（Node 原生 http）。
 *
 * 【为什么需要它】扩展声明支持 VS Code 1.80，对应的 Electron 里 Node 可能没有全局 fetch。
 *
 * 【为什么这里刻意不用 AbortSignal】实测（Windows / Node 24）：这条路径上挂 AbortController
 * 之后，进程退出时会撞 libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，
 * 退出码变成 0xC0000409 —— 测试全绿却判失败。原生 http 自带 `timeout` 选项就能超时，
 * 不需要信号量，等价且干净。
 */
function httpGet(url: string, accept: string, timeoutMs: number): Promise<RequestResult> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (r: RequestResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const req = http.request(
        url,
        { method: 'GET', headers: { Accept: accept }, timeout: timeoutMs },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            finish({
              ok: !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode || 0,
              text: Buffer.concat(chunks).toString('utf8'),
              // 只需要 X-Zotero-Version 这一个头，用最小实现代替 Headers 对象
              headers: { get: (k: string) => (res.headers[k.toLowerCase()] as string) || null } as unknown as Headers
            })
          );
        }
      );
      req.on('timeout', () => {
        req.destroy();
        finish({ ok: false, status: 0, text: `timeout after ${timeoutMs}ms` });
      });
      req.on('error', (err: Error) => finish({ ok: false, status: 0, text: String(err && err.message) }));
      req.end();
    } catch (err: any) {
      finish({ ok: false, status: 0, text: String((err && err.message) || err) });
    }
  });
}

export class ZoteroClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly prefsPath: string | undefined;
  /** 条目列表缓存：一次会话里反复建联不该反复拉全库 */
  private itemsCache: ZoteroItem[] | null = null;
  private detectCache: ZoteroDetectResult | null = null;

  constructor(opts: ZoteroClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_ZOTERO_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.prefsPath = opts.prefsPath;
  }

  private async request(pathname: string, init?: { accept?: string }): Promise<RequestResult> {
    const f = this.fetchImpl || (typeof fetch === 'function' ? fetch : undefined);
    if (!f) return httpGet(this.baseUrl + pathname, init?.accept || 'application/json', this.timeoutMs);
    const t = withTimeout(this.timeoutMs);
    try {
      const res = await f(this.baseUrl + pathname, {
        method: 'GET',
        signal: t.signal,
        headers: { Accept: init?.accept || 'application/json' }
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, headers: res.headers };
    } catch (err: any) {
      return { ok: false, status: 0, text: String((err && err.message) || err) };
    } finally {
      t.done();
    }
  }

  private async getJson<T>(pathname: string): Promise<T | null> {
    const r = await this.request(pathname);
    if (!r.ok) return null;
    try {
      return JSON.parse(r.text) as T;
    } catch {
      return null;
    }
  }

  /**
   * 探测 Zotero 本地 API 是否可用。
   *
   * 三种失败要分清（用户的下一步动作完全不同）：
   *   - 连不上 → Zotero 没开，去打开它；
   *   - 403 `Local API is not enabled` → 去设置里勾选"允许本机其它程序与 Zotero 通信"；
   *   - 其它 → 记下来，别猜。
   */
  public async detect(force = false): Promise<ZoteroDetectResult> {
    if (this.detectCache && !force) return this.detectCache;
    const prefs = await this.findPrefsPath();
    const probe = await this.request('/api/', { accept: 'text/plain' });
    let result: ZoteroDetectResult;
    if (probe.ok) {
      result = {
        available: true,
        message: '已连接 Zotero 本地接口',
        prefsPath: prefs.path,
        baseUrl: this.baseUrl,
        version: probe.headers?.get('X-Zotero-Version') || undefined
      };
    } else if (probe.status === 403 && /not enabled/i.test(probe.text)) {
      result = {
        available: false,
        reason: 'api-disabled',
        message:
          'Zotero 在运行，但本地接口没打开：Zotero 设置 → 高级 → 勾选「允许本机其它程序与 Zotero 通信」，然后重启 Zotero。',
        prefsPath: prefs.path,
        baseUrl: this.baseUrl
      };
    } else if (probe.status === 0) {
      result = {
        available: false,
        reason: 'not-running',
        message: '没检测到 Zotero（本地接口无响应）。打开 Zotero 即可自动认领当前论文。',
        prefsPath: prefs.path,
        baseUrl: this.baseUrl
      };
    } else {
      result = {
        available: false,
        reason: 'error',
        message: `Zotero 本地接口返回 ${probe.status}：${probe.text.slice(0, 120)}`,
        prefsPath: prefs.path,
        baseUrl: this.baseUrl
      };
    }
    this.detectCache = result;
    return result;
  }

  /**
   * 读 prefs.js 判断"开关是否打开"。
   * 拿不到文件时返回 unknown —— 不把"读不到"当成"没开"，
   * 因为真正的判据是 HTTP 探测（HTTP 通了就是通了，跟能不能读到文件无关）。
   */
  public async readLocalApiPref(): Promise<{ value: boolean | null; state: 'on' | 'off' | 'unknown'; path: string | null }> {
    const found = await this.findPrefsPath();
    if (!found.text) return { value: null, state: 'unknown', path: found.path };
    const v = readBoolPref(found.text, ZOTERO_LOCAL_API_PREF);
    if (v === null) return { value: null, state: 'unknown', path: found.path };
    return { value: v, state: v ? 'on' : 'off', path: found.path };
  }

  private async findPrefsPath(): Promise<{ path: string | null; text: string | null }> {
    const candidates: string[] = [];
    if (this.prefsPath) {
      candidates.push(this.prefsPath);
    } else {
      for (const root of zoteroPrefsCandidates(process.env as Record<string, string | undefined>)) {
        for (const p of expandProfileCandidates(root)) candidates.push(p);
      }
    }
    for (const p of candidates) {
      const text = safeRead(p);
      if (text) return { path: p, text };
    }
    return { path: null, text: null };
  }

  /** 拉取整个 PDF 附件列表（带缓存）。Zotero 库再大也只有附件这一层，limit=100 足够日常使用 */
  public async listPdfAttachments(force = false): Promise<ZoteroItem[]> {
    if (this.itemsCache && !force) return this.itemsCache;
    const items = await this.getJson<ZoteroItem[]>('/api/users/0/items?itemType=attachment&limit=100');
    if (!Array.isArray(items)) return [];
    this.itemsCache = items;
    return items;
  }

  public async getItem(key: string): Promise<ZoteroItem | null> {
    return this.getJson<ZoteroItem>(`/api/users/0/items/${encodeURIComponent(key)}`);
  }

  /** 附件的直接父条目（论文本体，元数据在它身上） */
  public async getParentItem(attachment: ZoteroItem): Promise<ZoteroItem | null> {
    const up = attachment.links?.up?.href;
    const m = up ? /\/items\/([^/?#]+)/.exec(up) : null;
    if (m) return this.getItem(decodeURIComponent(m[1]));
    const parentKey = attachment.data?.parentItem;
    if (parentKey) return this.getItem(parentKey);
    return null;
  }

  public async getFullText(attachmentKey: string, expectedPages?: number): Promise<ZoteroFullText | null> {
    const r = await this.request(`/api/users/0/items/${encodeURIComponent(attachmentKey)}/fulltext`);
    if (!r.ok) return null;
    try {
      const obj = JSON.parse(r.text) as {
        content?: string;
        indexedPages?: number;
        totalPages?: number;
      };
      if (typeof obj.content !== 'string') return null;
      return splitFullTextPages(obj.content, obj.indexedPages || 0, obj.totalPages || 0, expectedPages);
    } catch {
      return null;
    }
  }

  /** 批注是子条目：`/items/<附件key>/children`。实测空库返回空数组（不是 404） */
  public async getAnnotations(attachmentKey: string): Promise<ZoteroAnnotation[]> {
    const children = await this.getJson<ZoteroAnnotation[]>(
      `/api/users/0/items/${encodeURIComponent(attachmentKey)}/children`
    );
    if (!Array.isArray(children)) return [];
    return children.filter(c => (c?.data?.itemType || '') === 'annotation');
  }

  /**
   * 一站式：把本地 PDF 对应到 Zotero 条目，取元数据、全文、批注。
   * 任何一步失败都只让那一步为空，不抛异常 —— 阅读器不能因为 Zotero 出问题就打不开论文。
   */
  public async linkPdf(
    pdfPath: string,
    opts: { fileSize?: number; expectedPages?: number; withFullText?: boolean } = {}
  ): Promise<{ link: ZoteroLink | null; detect: ZoteroDetectResult }> {
    const detect = await this.detect();
    if (!detect.available) return { link: null, detect };

    const items = await this.listPdfAttachments();
    const hit = matchZoteroItem(pdfPath, opts.fileSize, items);
    if (!hit) return { link: null, detect };

    const attachment = hit.item;
    const [parent, fullText, annotations] = await Promise.all([
      this.getParentItem(attachment),
      opts.withFullText === false ? Promise.resolve(null) : this.getFullText(attachment.key, opts.expectedPages),
      this.getAnnotations(attachment.key)
    ]);
    const storage = parseFileUrl(attachment.links?.enclosure?.href);
    return {
      detect,
      link: {
        attachmentKey: attachment.key,
        parentKey: parent?.key,
        matchedBy: hit.matchedBy,
        fileName: storage.fileName || attachment.data?.filename || '',
        meta: formatZoteroMeta(parent || undefined, attachment),
        fullText: fullText || undefined,
        annotations,
        storageDir: storage.storageKey ? `storage/${storage.storageKey}` : null
      }
    };
  }
}

// ---------------------------------------------------------------------------
// 文件系统小工具（只读 prefs.js 与列 profile 目录，不碰 Zotero 数据库）
// ---------------------------------------------------------------------------

function safeRead(p: string): string | null {
  try {
    if (!p) return null;
    if (!fs.existsSync(p)) return null;
    if (fs.statSync(p).isDirectory()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Zotero 的 profile 目录名带随机前缀（本机实测 `iw79jc85.default`），无法硬编码，
 * 所以枚举 `<root>/任意子目录/prefs.js` 与 `<root>/prefs.js` 两种布局。
 */
function expandProfileCandidates(root: string): string[] {
  const sep = root.includes('\\') ? '\\' : '/';
  const out: string[] = [root + sep + 'prefs.js'];
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return out;
    for (const entry of fs.readdirSync(root)) {
      if (!entry) continue;
      const dir = root + sep + entry;
      try {
        if (fs.statSync(dir).isDirectory()) out.push(dir + sep + 'prefs.js');
      } catch {
        /* 权限/竞态，跳过 */
      }
    }
  } catch {
    /* 目录读不了就当没有 */
  }
  return out;
}
