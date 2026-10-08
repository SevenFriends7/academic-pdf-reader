import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ArchivedParagraph } from './pageArchive';

export type { ArchivedParagraph } from './pageArchive';

export interface AnnotationItem {
  id: string;
  page: number;
  text: string;
  color: 'yellow' | 'green' | 'blue' | 'pink';
  note?: string;
  paraIndex?: number;
  timestamp: number;
  rects?: Array<{ left: number; top: number; width: number; height: number }>;
}

export interface PaperMetadata {
  pdfPath: string;
  pdfName: string;
  lastOpened: number;
  annotations: AnnotationItem[];
  translations: Record<string, string>;
  sentenceTranslations?: Record<string, string[]>;
  /**
   * AI 答疑记录。
   *
   * 以前 AI 问答只活在 webview 的内存（`aiConversation`）里，关掉阅读器就没了——
   * 一次读论文最值钱的部分（模型对方法/公式的讲解）随之丢失。
   * 现在每条回答完成时都会同步到这里并落盘，导出双语精读稿时会按页交织进正文。
   */
  aiQa?: AiQaItem[];
  /**
   * 每页段落快照（页码 → 段落数组），供「导出全文双语精读稿」使用。
   *
   * 为什么必须落盘：段落是打开 PDF 时即时解析出来的，只存在 webview 内存里。
   * 不存的话，重开插件后导出只剩"本次翻过的那一页"，精读稿会平白变薄。
   */
  pageArchive?: Record<string, ArchivedParagraph[]>;
  /**
   * 视觉版面判断结果缓存（页码 → 模型给的 segments）。
   * 视觉调用是按页付费的，缓存下来同一页就只花一次钱。
   */
  visionStructure?: Record<string, unknown>;
}

export interface AiQaItem {
  id: string;
  page: number;
  /** 提问时选中的原文（用于把答疑挂回对应段落） */
  selectedText?: string;
  question: string;
  answer: string;
  style?: string;
  model?: string;
  at: number;
}

/** 身份索引里的一条：把"稳定身份"映射到"当前存储键 + 路径" */
interface IdentityEntry {
  /** 存储键后的 md5（也是文件名） */
  key: string;
  pdfPath: string;
  name: string;
  size: number;
  updatedAt: number;
}

/** 论文的稳定身份：文件名 + 字节数（两者都相同基本就是同一篇） */
interface PdfIdentity {
  name: string;
  size: number;
}

export class NotesStorageManager {
  private storageDir: string;

  /**
   * 身份索引（文件名+字节数 → 存储键）。
   *
   * 【为什么必须有它】存储键是**绝对路径的 MD5**（见 getStorageFilePath 的注释），
   * 于是把 PDF 从 `…\梯度校正测验\梯度校正测验\` 挪到 `…\梯度校正测验\文献\` 之后，
   * 键就变了，插件以为是一篇新论文——**用户的批注、译文、AI 答疑全部"消失"**。
   * 实测踩过：STM 36 条、AOT 26 条、cycle 27 条批注全在旧键里躺着，界面上却是空的。
   * 有了索引，移动/重命名文件后仍能自动认领回来。
   */
  private identityIndex: Record<string, IdentityEntry> | null = null;
  /** 本轮已通过"搬家"认领回来的论文，用于只提示一次 */
  private migratedNotices: string[] = [];

  constructor(private context: vscode.ExtensionContext) {
    // 彻底禁止向用户工作区目录写文件！改存至 IDE 扩展私有 globalStorage 目录
    this.storageDir = context.globalStorageUri.fsPath;
    if (!fs.existsSync(this.storageDir)) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
      } catch (e) {}
    }
  }

  /**
   * 使用文件绝对路径的 MD5 哈希作为文件名，存储在扩展专有私有目录下。
   *
   * ⚠️ 这个函数**故意保持原样**（键不变），因为它决定了历史数据能不能被读到：
   * 换个算法只会让所有老数据"再次消失"。要支持"文件搬家"请走下面的身份索引。
   */
  private getStorageFilePath(pdfUri: vscode.Uri): string {
    const hash = crypto.createHash('md5').update(pdfUri.fsPath).digest('hex');
    return path.join(this.storageDir, `paper_${hash}.json`);
  }

  /** 文件名 + 字节数 组成的稳定身份键 */
  private identityKeyOf(identity: PdfIdentity): string {
    return `${String(identity.name || '').toLowerCase()}|${Number(identity.size) || 0}`;
  }

  /** 尽力取到文件的字节数；取不到返回 0（此时不参与身份匹配） */
  private fileSizeOf(pdfUri: vscode.Uri): number {
    try {
      return fs.statSync(pdfUri.fsPath).size;
    } catch {
      return 0;
    }
  }

  private readIdentityIndex(): Record<string, IdentityEntry> {
    if (this.identityIndex) return this.identityIndex;
    this.identityIndex = {};
    try {
      const p = path.join(this.storageDir, '_paper_index.json');
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (parsed && typeof parsed === 'object') this.identityIndex = parsed as Record<string, IdentityEntry>;
      }
    } catch (e) {
      console.warn('[NotesStorage] 身份索引读取失败，将按空索引重建:', e);
    }
    return this.identityIndex;
  }

  private writeIdentityIndex(): void {
    try {
      if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
      const p = path.join(this.storageDir, '_paper_index.json');
      fs.writeFileSync(p, JSON.stringify(this.identityIndex || {}, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[NotesStorage] 身份索引写入失败（不影响批注本身）:', e);
    }
  }

  /** 记下"这篇论文当前的键"，路径变了也没关系 */
  private rememberIdentity(pdfUri: vscode.Uri, key: string): void {
    const identity: PdfIdentity = { name: path.basename(pdfUri.fsPath), size: this.fileSizeOf(pdfUri) };
    const idx = this.readIdentityIndex();
    const idKey = this.identityKeyOf(identity);
    const prev = idx[idKey];
    if (prev && prev.key === key && prev.pdfPath === pdfUri.fsPath) return;
    idx[idKey] = { key, pdfPath: pdfUri.fsPath, name: identity.name, size: identity.size, updatedAt: Date.now() };
    this.writeIdentityIndex();
  }

  /**
   * 索引为空时（老用户第一次升级到本版本、索引文件还没生成）扫一遍历史存档，
   * 把"文件名+字节数 → 存储键"补出来。只做一次，代价是读几个体积不大的 JSON。
   */
  private rebuildIndexIfEmpty(): void {
    const idx = this.readIdentityIndex();
    if (Object.keys(idx).length > 0) return;
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.storageDir).filter(f => f.startsWith('paper_') && f.endsWith('.json'));
    } catch {
      return;
    }
    let filled = 0;
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.storageDir, f), 'utf-8'));
        const p = String(data && data.pdfPath ? data.pdfPath : '');
        const name = String(data && data.pdfName ? data.pdfName : path.basename(p));
        if (!p || !name) continue;
        let size = Number(data && data.pdfSize) || 0;
        if (!size && fs.existsSync(p)) {
          try {
            size = fs.statSync(p).size;
          } catch {
            size = 0;
          }
        }
        const key = f.replace(/^paper_/, '').replace(/\.json$/, '');
        idx[this.identityKeyOf({ name, size })] = { key, pdfPath: p, name, size, updatedAt: Number(data.lastOpened) || 0 };
        filled++;
      } catch {
        /* 单个存档坏了不影响其它 */
      }
    }
    if (filled > 0) {
      console.log(`[NotesStorage] 已为 ${filled} 篇历史论文建立身份索引（用于文件移动后自动认领批注）`);
      this.writeIdentityIndex();
    }
  }

  /** 判断一份存档里有没有"值得认领"的用户数据 */
  private hasUserData(data: any): boolean {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data.annotations) && data.annotations.length > 0) return true;
    if (Array.isArray(data.aiQa) && data.aiQa.length > 0) return true;
    if (data.translations && Object.keys(data.translations).length > 0) return true;
    if (data.sentenceTranslations && Object.keys(data.sentenceTranslations).length > 0) return true;
    if (data.pageArchive && Object.keys(data.pageArchive).length > 0) return true;
    return false;
  }

  /** 按唯一键去重合并两个数组（id 优先，其次 JSON 内容） */
  private mergeUniqueById<T extends Record<string, any>>(a: T[] | undefined, b: T[] | undefined, idField = 'id'): T[] {
    const out: T[] = [];
    const seen = new Set<string>();
    for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item[idField] ?? '') || JSON.stringify(item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
    return out;
  }

  /**
   * 把"按身份找回的旧存档"并进当前论文数据。
   * 合并口径与 webview 侧 syncPageArchive 一致：新数据优先，旧数据补齐缺的部分。
   */
  private mergePaperData(current: PaperMetadata, prev: any): PaperMetadata {
    const mergedTranslations = { ...(prev.translations || {}), ...(current.translations || {}) };
    const sentenceTranslations: Record<string, string[]> = { ...(prev.sentenceTranslations || {}) };
    for (const [k, v] of Object.entries(current.sentenceTranslations || {})) {
      if (Array.isArray(v) && v.length > 0) sentenceTranslations[k] = v;
    }
    let pageArchive = { ...(prev.pageArchive || {}) };
    for (const [k, v] of Object.entries(current.pageArchive || {})) {
      const oldPages = Array.isArray(pageArchive[k]) ? pageArchive[k] : [];
      const newPages = Array.isArray(v) ? (v as ArchivedParagraph[]) : [];
      pageArchive[k] = newPages.length > 0 ? newPages : oldPages;
    }
    return {
      ...current,
      annotations: this.mergeUniqueById<AnnotationItem>(prev.annotations, current.annotations),
      aiQa: this.mergeUniqueById<AiQaItem>(prev.aiQa, current.aiQa),
      translations: mergedTranslations,
      sentenceTranslations,
      pageArchive,
      visionStructure: { ...(prev.visionStructure || {}), ...(current.visionStructure || {}) }
    };
  }

  /** 是否有别的存储键正好对应"同一篇论文"（文件名+字节数都相同） */
  private findIdentityMatch(pdfUri: vscode.Uri): { key: string; pdfPath: string } | null {
    const identity: PdfIdentity = { name: path.basename(pdfUri.fsPath), size: this.fileSizeOf(pdfUri) };
    // 字节数取不到就**不匹配**：宁可让用户手动重开一次，也不能张冠李戴把别人的批注贴上来
    if (!identity.size) return null;
    this.rebuildIndexIfEmpty();
    const idx = this.readIdentityIndex();
    const hit = idx[this.identityKeyOf(identity)];
    if (!hit || !hit.key) return null;
    if (hit.pdfPath === pdfUri.fsPath) return null; // 同一路径就不算"搬家"
    return { key: hit.key, pdfPath: hit.pdfPath };
  }

  public async loadPaperData(pdfUri: vscode.Uri): Promise<PaperMetadata> {
    const filePath = this.getStorageFilePath(pdfUri);
    const currentKey = path.basename(filePath).replace(/^paper_/, '').replace(/\.json$/, '');
    try {
      if (fs.existsSync(filePath)) {
        this.rememberIdentity(pdfUri, currentKey);
        return this.parseStoredData(pdfUri, filePath);
      }

      /*
       * 当前路径没有存档 → 很可能是文件被移动/重命名过（换目录、整理文献夹都会发生）。
       * 按"文件名 + 字节数"找回旧存档，并**自动认领**：读到内存后由下一次 save 落到新键，
       * 同时提示用户一句（批注这种东西悄悄"回来"会让人怀疑是不是又错了）。
       */
      const match = this.findIdentityMatch(pdfUri);
      if (match) {
        const oldPath = path.join(this.storageDir, `paper_${match.key}.json`);
        if (fs.existsSync(oldPath)) {
          const parsed = JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
          this.rememberIdentity(pdfUri, currentKey);
          console.log(
            `[NotesStorage] 论文路径已变化，按"文件名+字节数"认领回旧存档：${match.pdfPath} → ${pdfUri.fsPath}`
          );
          this.migratedNotices.push(path.basename(pdfUri.fsPath));
          return this.parseStoredData(pdfUri, oldPath);
        }
      }

      // 全新论文：也要记下身份，下次搬家才能认得出来
      this.rememberIdentity(pdfUri, currentKey);
    } catch (e) {
      console.warn('[NotesStorage] Failed to read private storage:', e);
    }

    return {
      pdfPath: pdfUri.fsPath,
      pdfName: path.basename(pdfUri.fsPath),
      lastOpened: Date.now(),
      annotations: [],
      translations: {},
      aiQa: []
    };
  }

  /** 取出并提示一次"批注已自动找回" */
  public consumeMigrationNotices(): string[] {
    const out = this.migratedNotices.slice();
    this.migratedNotices = [];
    return out;
  }

  /** 读一份存档并重建 PaperMetadata（字段漏一个就会在下次保存时被静默丢掉，必须显式带全） */
  private parseStoredData(pdfUri: vscode.Uri, filePath: string): PaperMetadata {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    // 自愈过滤：自动剔除包含空串的破损句子翻译缓存
    const sentenceTranslations: Record<string, string[]> = {};
    if (data.sentenceTranslations && typeof data.sentenceTranslations === 'object') {
      for (const [k, arr] of Object.entries(data.sentenceTranslations)) {
        if (Array.isArray(arr) && arr.length > 0 && !arr.some((s: any) => !s || !String(s).trim())) {
          sentenceTranslations[k] = arr;
        }
      }
    }

    return {
      pdfPath: pdfUri.fsPath,
      pdfName: path.basename(pdfUri.fsPath),
      lastOpened: Date.now(),
      annotations: data.annotations || [],
      translations: data.translations || {},
      sentenceTranslations: sentenceTranslations,
      // 必须显式带回来：这个函数是"重建对象"，漏掉的字段会在下次保存时被静默丢掉
      aiQa: Array.isArray(data.aiQa) ? data.aiQa : [],
      pageArchive:
        data.pageArchive && typeof data.pageArchive === 'object' && !Array.isArray(data.pageArchive)
          ? data.pageArchive
          : {},
      // 同理：视觉结构缓存也要显式带回来，否则每次打开都重新花钱问一遍
      visionStructure:
        data.visionStructure && typeof data.visionStructure === 'object' && !Array.isArray(data.visionStructure)
          ? data.visionStructure
          : {}
    };
  }

  public async savePaperData(pdfUri: vscode.Uri, data: PaperMetadata): Promise<void> {
    const filePath = this.getStorageFilePath(pdfUri);
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      /*
       * 顺手把"文件名+字节数"也写进存档。
       * 身份索引万一丢了（用户清理目录、换机器同步），还能靠这个字段把历史论文重建出来，
       * 不用去 stat 一堆可能已经不在原位的文件。
       */
      const size = this.fileSizeOf(pdfUri);
      if (size) (data as any).pdfSize = size;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.rememberIdentity(pdfUri, path.basename(filePath).replace(/^paper_/, '').replace(/\.json$/, ''));
    } catch (e) {
      console.error('[NotesStorage] Failed to save private storage:', e);
    }
  }

  /**
   * 追加一条 AI 答疑记录并落盘。
   *
   * 注意：这里只是"数据不动"，真正的导出文稿由 webview 侧生成
   * （它才有段落切分与句级译文）。旧版那个只罗列高亮的 exportToMarkdown()
   * 已被「全文双语精读稿」取代并删除——留着两套导出实现必然再次跑偏。
   */
  public async appendAiQa(pdfUri: vscode.Uri, data: PaperMetadata, item: AiQaItem): Promise<void> {
    data.aiQa = Array.isArray(data.aiQa) ? data.aiQa : [];
    data.aiQa.push(item);
    // 只留最近 200 条，避免论文 JSON 无限膨胀
    if (data.aiQa.length > 200) data.aiQa = data.aiQa.slice(-200);
    await this.savePaperData(pdfUri, data);
  }
}
