// Verify syntax of new viewer core functions
function splitEnglishSentencesSmart(text) {
  if (!text) return [];
  const rawSentences = [];
  let start = 0;
  const endRegex = /([.?!]["'”)]?)\s+(?=[A-Z0-9“"'(])/g;
  let match;

  while ((match = endRegex.exec(text)) !== null) {
    const endPos = match.index + match[1].length;
    const candidate = text.slice(start, endPos).trim();
    const cleanCandidate = candidate.trim();

    if (/\b(et al|e\.g|i\.e|fig|figs|ref|refs|vol|no|pp|dr|mr|mrs|ms|vs|approx|min|sec|ca)\.$/i.test(cleanCandidate) || /\b[A-Z]\.$/.test(cleanCandidate)) {
      continue;
    }

    if (candidate) {
      rawSentences.push({
        text: candidate,
        startIdx: start,
        endIdx: endPos
      });
    }
    start = match.index + match[0].length;
  }

  const remaining = text.slice(start).trim();
  if (remaining) {
    rawSentences.push({
      text: remaining,
      startIdx: start,
      endIdx: text.length
    });
  }

  return rawSentences;
}

function splitChineseSentences(text) {
  if (!text) return [];
  const parts = text.match(/[^。！？；\n]+[。！？；\n]?/g);
  if (!parts) return [text];
  return parts.map(s => s.trim()).filter(Boolean);
}

function renderSentencePairsHtml(para, cachedTrans, cachedSentences, escapeHtml) {
  if (!cachedTrans) {
    return `<div class="trans-loading-box"><span class="mini-spinner"></span> 正在请求智能学术翻译...</div>`;
  }

  const sentences = para.sentencesEn || [];
  if (sentences.length === 0) {
    return `<div class="sentence-pair-row" data-sent-idx="0">
      <div class="sent-num">1</div>
      <div class="sent-content">
        <div class="sent-zh">${escapeHtml(cachedTrans)}</div>
        <div class="sent-en">${escapeHtml(para.cleanText)}</div>
      </div>
    </div>`;
  }

  let zhSentences = [];
  if (cachedSentences && Array.isArray(cachedSentences) && cachedSentences.length > 0) {
    zhSentences = cachedSentences;
  } else {
    const rawZh = (cachedTrans.match(/[^。！？；\n]+[。！？；\n]?/g) || [cachedTrans])
      .map(s => s.trim())
      .filter(Boolean);

    if (rawZh.length === sentences.length) {
      zhSentences = rawZh;
    } else {
      const totalEnLen = sentences.reduce((sum, s) => sum + Math.max(1, s.text.length), 0);
      let curZhIdx = 0;
      for (let i = 0; i < sentences.length; i++) {
        if (i === sentences.length - 1) {
          zhSentences.push(rawZh.slice(curZhIdx).join('') || cachedTrans);
        } else {
          const ratio = sentences[i].text.length / totalEnLen;
          const take = Math.max(1, Math.round(ratio * rawZh.length));
          zhSentences.push(rawZh.slice(curZhIdx, curZhIdx + take).join('') || rawZh[curZhIdx] || '');
          curZhIdx = Math.min(rawZh.length, curZhIdx + take);
        }
      }
    }
  }

  return sentences.map((sent, idx) => {
    const zh = zhSentences[idx] || (idx === 0 ? cachedTrans : '');
    return `
      <div class="sentence-pair-row" data-sent-idx="${idx}" title="点击可使左侧 PDF 原件 100% 精确高亮对应本句">
        <div class="sent-num">${idx + 1}</div>
        <div class="sent-content">
          <div class="sent-zh">${escapeHtml(zh || '（译文生成中）')}</div>
          <div class="sent-en">${escapeHtml(sent.text)}</div>
        </div>
        <div class="sent-locate-icon">🎯</div>
      </div>
    `;
  }).join('');
}

console.log('new viewer core syntax OK');
