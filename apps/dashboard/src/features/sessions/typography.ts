/** Display-only paragraph boundaries; preserve indentation and single line breaks. */
export function thinkingParagraphs(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split(/\n[ \t]*\n(?:[ \t]*\n)*/).filter(paragraph => paragraph.trim().length > 0);
}

/** Compact elapsed time for conversation status, independent of statistics formatting. */
export function formatConversationDuration(value: number): string {
  const ms = Number.isFinite(value) ? Math.max(0, value) : 0;
  const total = Math.floor(ms / 1000);
  if (total === 0) return "0s";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  return `${hours ? `${hours}h` : ""}${minutes ? `${minutes}m` : ""}${seconds ? `${seconds}s` : ""}`;
}
