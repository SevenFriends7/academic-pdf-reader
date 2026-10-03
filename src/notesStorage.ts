import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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
}

/** 导出用的轻量段落快照（不含任何 DOM 引用） */
export interface ArchivedParagraph {
  id: number;
  type: string;
  cleanText: string;
  sentencesEn?: Array<{ text: string }>;
  translation?: string;
  sentenceTranslations?: string[];
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

export class NotesStorageManager {
  private storageDir: string;

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
   * 使用文件绝对路径的 MD5 哈希作为文件名，存储在扩展专有私有目录下
   */
  private getStorageFilePath(pdfUri: vscode.Uri): string {
    const hash = crypto.createHash('md5').update(pdfUri.fsPath).digest('hex');
    return path.join(this.storageDir, `paper_${hash}.json`);
  }

  public async loadPaperData(pdfUri: vscode.Uri): Promise<PaperMetadata> {
    const filePath = this.getStorageFilePath(pdfUri);
    try {
      if (fs.existsSync(filePath)) {
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
              : {}
        };
      }
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

  public async savePaperData(pdfUri: vscode.Uri, data: PaperMetadata): Promise<void> {
    const filePath = this.getStorageFilePath(pdfUri);
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
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
