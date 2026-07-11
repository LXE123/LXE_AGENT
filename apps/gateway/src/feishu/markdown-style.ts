/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Adapted from openclaw-lark commit 18c4416.
 */

export function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    const marker = "___LXE_CODE_BLOCK_";
    const blocks: string[] = [];
    let result = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (match, prefix = "") => {
      const block = match.slice(String(prefix).length);
      return `${prefix}${marker}${blocks.push(block) - 1}___`;
    });
    if (/^#{1,3} /m.test(text)) {
      result = result.replace(/^#{2,6} (.+)$/gm, "##### $1");
      result = result.replace(/^# (.+)$/gm, "#### $1");
    }
    if (cardVersion >= 2) {
      result = result.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, "$1\n<br>\n$2");
      result = result.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
      result = result.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");
      result = result.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (match, _table, offset) => {
        const after = result.slice(Number(offset) + match.length).replace(/^\n+/, "");
        if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return match;
        return `${match}\n<br>\n`;
      });
      result = result.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n$3");
      result = result.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n\n$3");
      result = result.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, "$1$2$3");
      blocks.forEach((block, index) => {
        result = result.replace(`${marker}${index}___`, `\n<br>\n${block}\n<br>\n`);
      });
    } else {
      blocks.forEach((block, index) => { result = result.replace(`${marker}${index}___`, block); });
    }
    result = result.replace(/\n{3,}/g, "\n\n");
    return result.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (full, _alt, value) =>
      String(value).startsWith("img_") ? full : "");
  } catch {
    return text;
  }
}
