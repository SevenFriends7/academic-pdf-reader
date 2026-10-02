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
          sentenceTranslations: sentenceTranslations
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
      translations: {}
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

  public async exportToMarkdown(pdfUri: vscode.Uri, data: PaperMetadata): Promise<vscode.Uri | undefined> {
    const baseName = path.basename(pdfUri.fsPath, path.extname(pdfUri.fsPath));
    const now = new Date().toLocaleString();

    let md = `# 📖 文献研读笔记: ${baseName}\n\n`;
    md += `> - 📄 **源文件**: \`${path.basename(pdfUri.fsPath)}\`\n`;
    md += `> - 🕒 **生成时间**: ${now}\n`;
    md += `> - 🔖 **批注数量**: ${data.annotations.length} 条\n\n`;
    md += `---\n\n`;

    if (data.annotations.length === 0) {
      md += `*暂无高亮或批注记录。*\n`;
    } else {
      const sorted = [...data.annotations].sort((a, b) => a.page - b.page || a.timestamp - b.timestamp);
      let currentPage = -1;

      for (const item of sorted) {
        if (item.page !== currentPage) {
          currentPage = item.page;
          md += `## 📄 第 ${currentPage} 页\n\n`;
        }

        const colorMap: Record<string, string> = {
          yellow: '🟨 [核心要点]',
          green: '🟩 [论据/数据]',
          blue: '🟦 [方法/公式]',
          pink: '🟥 [疑难/待查]'
        };
        const tag = colorMap[item.color] || '📌 [高亮]';

        md += `### ${tag} (记录于 ${new Date(item.timestamp).toLocaleTimeString()})\n\n`;
        md += `> **原文摘录**:\n`;
        md += `> ${item.text.replace(/\n/g, '\n> ')}\n\n`;

        let translation = '';
        if (item.paraIndex !== undefined) {
          const transKey = `${item.page}_${item.paraIndex}`;
          if (data.translations[transKey]) {
            translation = data.translations[transKey];
          }
        }
        if (!translation) {
          const sig = item.text.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
          if (sig.length >= 8) {
            for (const [k, v] of Object.entries(data.translations || {})) {
              if (k.startsWith(`${item.page}_`) && k.includes(sig)) {
                translation = v;
                break;
              }
            }
          }
        }
        if (translation) {
          md += `> **对照翻译**:\n`;
          md += `> ${translation.replace(/\n/g, '\n> ')}\n\n`;
        }

        if (item.note && item.note.trim()) {
          md += `✍️ **我的批注 / 思考**:\n\n`;
          md += `${item.note}\n\n`;
        }

        md += `---\n\n`;
      }
    }

    const dir = path.dirname(pdfUri.fsPath);
    const targetMdPath = path.join(dir, `${baseName}-文献阅读笔记.md`);

    try {
      fs.writeFileSync(targetMdPath, md, 'utf-8');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetMdPath));
      await vscode.window.showTextDocument(doc);
      return doc.uri;
    } catch (e: any) {
      vscode.window.showErrorMessage(`导出 Markdown 失败: ${e.message}`);
      return undefined;
    }
  }
}
