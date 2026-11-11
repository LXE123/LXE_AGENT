export const READ_MAX_LINES = 2_000;
export const READ_MAX_BYTES = 50 * 1024;

export interface NumberedTextRangeOptions {
  startLine: number;
  maxLines?: number;
  /** Scripts consume the text itself, including its original line endings. */
  plainText?: boolean;
  signal?: AbortSignal;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Count to EOF for the continuation notice, retaining only complete lines that fit one page. */
export async function scanNumberedTextChunks(
  chunks: AsyncIterable<Uint8Array>,
  { startLine, maxLines, plainText, signal }: NumberedTextRangeOptions,
): Promise<string> {
  const lastLine = maxLines === undefined ? Infinity : startLine + maxLines - 1;
  const lines: string[] = [];
  const buffer = Buffer.allocUnsafe(READ_MAX_BYTES);
  let lineNumber = 1;
  let lineBytes = 0;
  let firstLineBytes = 0;
  let pageBytes = 0;
  let truncated = false;
  let lastSelectedEmpty = false;

  function finishLine(): void {
    if (lineNumber < startLine || lineNumber > lastLine) return;
    if (lineNumber === startLine) firstLineBytes = lineBytes;
    lastSelectedEmpty = lineBytes === 0;
    if (truncated) return;
    const size = pageBytes + (lines.length ? 1 : 0) + lineBytes;
    // A trailing LF belongs to the preceding line, including at the 2,000-line boundary.
    if (size > READ_MAX_BYTES || lines.length > READ_MAX_LINES
      || (lines.length === READ_MAX_LINES && lineBytes !== 0)) {
      truncated = true;
      return;
    }
    lines.push(buffer.toString("utf8", 0, lineBytes));
    pageBytes = size;
  }

  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    let from = 0;
    while (from < chunk.length) {
      const lf = chunk.indexOf(10, from);
      const end = lf < 0 ? chunk.length : lf;
      const length = end - from;
      if (!truncated && lineNumber >= startLine && lineNumber <= lastLine && lineBytes + length <= READ_MAX_BYTES) {
        buffer.set(chunk.subarray(from, end), lineBytes);
      }
      lineBytes += length;
      if (lf < 0) break;
      finishLine();
      lineNumber++;
      lineBytes = 0;
      from = lf + 1;
    }
  }
  signal?.throwIfAborted();
  finishLine();
  const totalLines = lineNumber;
  if (startLine > totalLines) throw new Error(`Offset ${startLine} is beyond end of file (${totalLines} lines total)`);
  if (firstLineBytes > READ_MAX_BYTES) {
    return `[Line ${startLine} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(READ_MAX_BYTES)} limit. Use exec to read this line in byte ranges.]`;
  }
  if (truncated && lines.length > READ_MAX_LINES) lines.length = READ_MAX_LINES;
  const nextOffset = startLine + lines.length;
  let notice = "";
  if (truncated) {
    const selectedCount = Math.min(totalLines, lastLine) - startLine + 1;
    const contentLines = selectedCount - Number(lastSelectedEmpty);
    const byteLimit = lines.length < Math.min(READ_MAX_LINES, contentLines) ? ` (${formatSize(READ_MAX_BYTES)} limit)` : "";
    notice = `[Showing lines ${startLine}-${nextOffset - 1} of ${totalLines}${byteLimit}. Use offset=${nextOffset} to continue.]`;
  } else if (nextOffset <= totalLines) {
    notice = `[${totalLines - nextOffset + 1} more lines in file. Use offset=${nextOffset} to continue.]`;
  }

  if (!plainText) {
    // A terminal LF creates an addressable empty entry in Pi's line count, but has no text to number.
    if (nextOffset === totalLines + 1 && lines.at(-1) === "") lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const number = startLine + i;
      let text = lines[i]!;
      if (number < totalLines && text.endsWith("\r")) text = text.slice(0, -1);
      if (number === 1 && text.startsWith("\uFEFF")) text = text.slice(1);
      lines[i] = `${String(number).padStart(6, " ")}\t${text}`;
    }
  }
  const body = lines.join("\n");
  return notice ? `${body}\n\n${notice}` : body;
}
