/**
 * 每页段落快照（导出用）的共享工具。
 *
 * 为什么单独成模块：宿主与 webview 两边都要用同一套「段落 → 译文」的解析规则，
 * 而 pdfExport 与 pdfEditorProvider 都不能把这份规则各写一遍（0.5.13 就是这么漏掉译文的）。
 * 这里不 import vscode，所以可以直接在 Node 测试里跑。
 */

/** 导出用的轻量段落快照（不含任何 DOM 引用） */
export interface ArchivedParagraph {
  id: number;
  type: string;
  cleanText: string;
  sentencesEn?: Array<{ text: string }>;
  translation?: string;
  sentenceTranslations?: string[];
  /**
   * 该段落译文的缓存键（`${page}_${引擎标识}_${内容指纹}`）。
   * 由 webview 在归档时写入：宿主据此能**精确**回查译文，
   * 不必自己重算指纹、也不必猜引擎标识。
   */
  cacheKey?: string;
}

/**
 * 段落内容指纹：FNV-1a 32 位 + 字符数。
 * **必须与 media/viewer.js 的 getParaSig() 逐字节一致**——译文缓存键就是它，
 * 两边算法一旦漂移，宿主就再也查不到 webview 存下的译文（这正是"译文没同步"的成因之一）。
 */
export function hashParagraphText(text: string): string {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${s.length}`;
}

/**
 * 回查一段的译文。
 *
 * 依次尝试（顺序即优先级）：
 *   1. 快照自带的 translation（webview 归档时已解析好的）；
 *   2. 快照记下的 cacheKey（最精确）；
 *   3. `${page}_${引擎标识}_${内容指纹}`（当前引擎的缓存键）；
 *   4. `${page}_${内容指纹}`（更早版本留下的无标识键）。
 *
 * 只查第 1 种是不够的：段落对象上的 translation 只有在"本次会话刚翻好"时才有值，
 * 命中缓存（重开插件再导出）时它是空的，而译文其实好好躺在 translations 里。
 */
export function resolveArchivedTranslation(
  page: number,
  para: ArchivedParagraph,
  translations: Record<string, string> | undefined,
  engineTag?: string
): string {
  if (para && para.translation && String(para.translation).trim()) return String(para.translation);
  const table = translations || {};
  if (para && para.cacheKey && table[para.cacheKey]) return table[para.cacheKey];
  const sig = hashParagraphText((para && para.cleanText) || '');
  if (!sig) return '';
  if (engineTag && table[`${page}_${engineTag}_${sig}`]) return table[`${page}_${engineTag}_${sig}`];
  if (table[`${page}_${sig}`]) return table[`${page}_${sig}`];
  return '';
}

/** 同上，取句级对齐译文；只有句数严格相等且无空项才算数（与界面判据一致） */
export function resolveArchivedSentences(
  page: number,
  para: ArchivedParagraph,
  sentenceTranslations: Record<string, string[]> | undefined,
  engineTag?: string
): string[] | null {
  const en = (para && para.sentencesEn) || [];
  if (en.length === 0) return null;
  const table = sentenceTranslations || {};
  const candidates: Array<string[] | undefined> = [];
  if (para.sentenceTranslations && para.sentenceTranslations.length) candidates.push(para.sentenceTranslations);
  if (para.cacheKey) candidates.push(table[para.cacheKey]);
  const sig = hashParagraphText((para && para.cleanText) || '');
  if (sig) {
    if (engineTag) candidates.push(table[`${page}_${engineTag}_${sig}`]);
    candidates.push(table[`${page}_${sig}`]);
  }
  for (const list of candidates) {
    if (Array.isArray(list) && list.length === en.length && !list.some(s => !s || !String(s).trim())) {
      return list;
    }
  }
  return null;
}

/**
 * 合并新归档的段落：**绝不用空的译文覆盖已有的非空译文**。
 *
 * 场景：重开插件后重读同一页，快照是在译文从缓存回填之前生成的，
 * 若直接整体替换，之前存好的译文就被抹掉了。
 */
export function mergeArchivedParagraphs(
  existing: ArchivedParagraph[] | undefined,
  incoming: ArchivedParagraph[]
): ArchivedParagraph[] {
  if (!Array.isArray(existing) || existing.length === 0) return incoming;
  const byId = new Map(existing.map(p => [p.id, p]));
  return incoming.map(p => {
    const old = byId.get(p.id);
    if (!old) return p;
    const merged: ArchivedParagraph = { ...p };
    if ((!merged.translation || !merged.translation.trim()) && old.translation && old.translation.trim()) {
      merged.translation = old.translation;
    }
    if (
      (!merged.sentenceTranslations || merged.sentenceTranslations.length === 0) &&
      old.sentenceTranslations &&
      old.sentenceTranslations.length > 0
    ) {
      merged.sentenceTranslations = old.sentenceTranslations;
    }
    if (!merged.cacheKey && old.cacheKey) merged.cacheKey = old.cacheKey;
    return merged;
  });
}
