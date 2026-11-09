export interface NumberedTextRangeOptions {
  startLine: number;
  maxLines: number;
  charBudget: number;
  /** Scripts consume the text itself, including its original line endings. */
  plainText?: boolean;
  signal?: AbortSignal;
}

export interface NumberedTextRangeResult {
  body: string;
  hasMore: boolean;
  nextOffset?: number;
  truncatedLine?: number;
}

const abortReason = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ?? new DOMException("Aborted", "AbortError");

const assertActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortReason(signal);
};

const numberedLinePrefix = (lineNumber: number): string =>
  `${String(lineNumber).padStart(6, " ")}\t`;

/**
 * Selects a numbered line range from bounded source chunks. Text before the
 * requested range is discarded, and a selected line is retained only up to
 * the output budget. After a complete range, look ahead only far enough to
 * distinguish another line from EOF before offering a continuation offset.
 */
export async function scanNumberedTextChunks(
  chunks: AsyncIterable<Uint8Array>,
  options: NumberedTextRangeOptions,
): Promise<NumberedTextRangeResult> {
  const startLine = Math.max(1, Math.trunc(options.startLine));
  const maxLines = Math.max(1, Math.trunc(options.maxLines));
  const charBudget = Math.max(1, Math.trunc(options.charBudget));
  const decoder = new TextDecoder("utf-8", { ignoreBOM: options.plainText ?? false });
  let body = "";
  let lineNumber = 1;
  let collectedLines = 0;
  let currentLineHasContent = false;
  let currentLineStarted = false;
  let currentLineBodyStart = 0;
  let pendingCarriageReturn = false;
  let rangeComplete = false;

  const selected = (): boolean => lineNumber >= startLine;

  const appendBounded = (value: string): boolean => {
    const remaining = charBudget - body.length;
    if (remaining <= 0) return value.length === 0;
    if (value.length <= remaining) {
      body += value;
      return true;
    }
    // Do not split a UTF-16 surrogate pair in an oversized first-line preview.
    const end = remaining > 0
      && /[\uD800-\uDBFF]/u.test(value[remaining - 1]!)
      && /[\uDC00-\uDFFF]/u.test(value[remaining]!) ? remaining - 1 : remaining;
    body += value.slice(0, end);
    return false;
  };

  const startSelectedLine = (): boolean => {
    if (currentLineStarted) return true;
    currentLineStarted = true;
    currentLineBodyStart = body.length;
    if (collectedLines > 0 && !appendBounded("\n")) return false;
    return options.plainText || appendBounded(numberedLinePrefix(lineNumber));
  };

  const budgetStopResult = (): NumberedTextRangeResult => {
    if (collectedLines > 0) {
      body = body.slice(0, currentLineBodyStart);
      return { body, hasMore: true, nextOffset: lineNumber };
    }
    return { body, hasMore: true, truncatedLine: lineNumber };
  };

  const completeLine = (): NumberedTextRangeResult | undefined => {
    if (selected()) {
      if (!startSelectedLine()) return budgetStopResult();
      collectedLines += 1;
    }
    lineNumber += 1;
    currentLineHasContent = false;
    currentLineStarted = false;
    rangeComplete = collectedLines >= maxLines || body.length >= charBudget;
    return undefined;
  };

  const consume = (text: string): NumberedTextRangeResult | undefined => {
    let cursor = 0;
    while (cursor < text.length) {
      if (rangeComplete) return { body, hasMore: true, nextOffset: lineNumber };
      const newline = text.indexOf("\n", cursor);
      const end = newline === -1 ? text.length : newline;
      let segment = (pendingCarriageReturn ? "\r" : "") + text.slice(cursor, end);
      pendingCarriageReturn = false;
      if (segment.length > 0) currentLineHasContent = true;
      // Delay a final CR so CRLF split across chunks does not consume budget.
      if (!options.plainText && segment.endsWith("\r")) {
        pendingCarriageReturn = newline === -1;
        segment = segment.slice(0, -1);
      }
      if (selected()) {
        if (!startSelectedLine() || !appendBounded(segment)) return budgetStopResult();
      }
      if (newline === -1) return undefined;
      const completed = completeLine();
      if (completed) return completed;
      cursor = newline + 1;
    }
    return undefined;
  };

  for await (const chunk of chunks) {
    assertActive(options.signal);
    const stopped = consume(decoder.decode(chunk, { stream: true }));
    if (stopped) return stopped;
    assertActive(options.signal);
  }
  assertActive(options.signal);
  const decoderTail = decoder.decode();
  if (decoderTail) {
    const stopped = consume(decoderTail);
    if (stopped) return stopped;
  }
  if (pendingCarriageReturn && selected() && !appendBounded("\r")) return budgetStopResult();
  // In plain text, a terminal LF separates a final empty line, as in text.split("\n").
  if (currentLineHasContent || (options.plainText && lineNumber > 1)) {
    if (rangeComplete) return { body, hasMore: true, nextOffset: lineNumber };
    const completed = completeLine();
    if (completed) return completed;
  }
  const totalLines = lineNumber - 1;
  // Reading an empty file from its default offset is valid.
  if (startLine > totalLines && !(totalLines === 0 && startLine === 1)) {
    throw new Error(`Offset ${startLine} is beyond end of file (${totalLines} lines total)`);
  }
  return { body, hasMore: false };
}
