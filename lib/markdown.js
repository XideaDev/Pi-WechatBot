"use strict";

const MAX_CHARS_PER_CHUNK = 1200; // 微信安全单条字符上限，防止服务端静默截断

/**
 * 将长 Markdown 回复拆分成适合微信接收的安全文本切片
 * 1. 严格控制单条字符数在 1200 字符内，防止微信服务端静默截断
 * 2. 严格保护代码块：跨片时自动在上一片末尾闭合代码块，在下一片开头恢复开启代码块与语言标注
 * 3. 分片数大于 1 时，在每片顶部自动添加 [1/N] 进度标识
 */
function splitAndFilterMarkdown(text, maxChars = MAX_CHARS_PER_CHUNK) {
  if (!text || typeof text !== "string") return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 如果总字符数未超标，直接单片返回
  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  const rawChunks = [];
  const lines = trimmed.split("\n");
  let currentLines = [];
  let currentLen = 0;
  let inCodeBlock = false;
  let codeFence = "```";
  let codeLang = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(\w*)/);
    const lineLen = line.length + 1; // 算上换行符

    // 检查加入当前行是否会超限
    if (currentLen + lineLen > maxChars && currentLines.length > 0) {
      if (inCodeBlock) {
        // 在代码块内部切断，当前片闭合代码块
        currentLines.push(codeFence);
        rawChunks.push(currentLines.join("\n"));
        // 下一片开头恢复代码块并携带语言标注
        currentLines = [codeLang ? `${codeFence}${codeLang}` : codeFence, line];
        currentLen = (codeLang ? `${codeFence}${codeLang}\n`.length : codeFence.length + 1) + lineLen;
      } else {
        rawChunks.push(currentLines.join("\n"));
        currentLines = [line];
        currentLen = lineLen;
      }
    } else {
      currentLines.push(line);
      currentLen += lineLen;
    }

    // 维护代码块状态
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = fenceMatch[2];
        codeLang = fenceMatch[3] || "";
      } else if (line.trim().startsWith(codeFence)) {
        inCodeBlock = false;
        codeLang = "";
      }
    }
  }

  if (currentLines.length > 0 && currentLines.join("\n").trim()) {
    if (inCodeBlock) {
      currentLines.push(codeFence);
    }
    rawChunks.push(currentLines.join("\n"));
  }

  if (rawChunks.length <= 1) {
    return rawChunks;
  }

  // 多片时，为每片顶部附带 [1/N] 明确序号
  const total = rawChunks.length;
  return rawChunks.map((chunk, idx) => {
    return `[${idx + 1}/${total}]\n${chunk}`;
  });
}

module.exports = {
  splitAndFilterMarkdown,
  MAX_CHARS_PER_CHUNK,
};
