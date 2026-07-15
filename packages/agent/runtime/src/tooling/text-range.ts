export interface NumberedTextRangeOptions {
  startLine: number;
  maxLines: number;
  charBudget: number;
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
 * the output budget. The iterator is closed as soon as the range is complete.
 */
export async function scanNumberedTextChunks(
  chunks: AsyncIterable<Uint8Array>,
  options: NumberedTextRangeOptions,
): Promise<NumberedTextRangeResult> {
  const startLine = Math.max(1, Math.trunc(options.startLine));
  const maxLines = Math.max(1, Math.trunc(options.maxLines));
  const charBudget = Math.max(1, Math.trunc(options.charBudget));
  const decoder = new TextDecoder();
  let body = "";
  let lineNumber = 1;
  let collectedLines = 0;
  let currentLineHasContent = false;
  let currentLineStarted = false;
  let currentLineBodyStart = 0;

  const selected = (): boolean => lineNumber >= startLine;

  const appendBounded = (value: string): boolean => {
    const remaining = charBudget - body.length;
    if (remaining <= 0) return value.length === 0;
    if (value.length <= remaining) {
      body += value;
      return true;
    }
    body += value.slice(0, remaining);
    return false;
  };

  const startSelectedLine = (): boolean => {
    if (currentLineStarted) return true;
    currentLineStarted = true;
    currentLineBodyStart = body.length;
    if (collectedLines > 0 && !appendBounded("\n")) return false;
    return appendBounded(numberedLinePrefix(lineNumber));
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
      if (body.endsWith("\r")) body = body.slice(0, -1);
      collectedLines += 1;
    }
    lineNumber += 1;
    currentLineHasContent = false;
    currentLineStarted = false;
    if (collectedLines >= maxLines || body.length >= charBudget) {
      return { body, hasMore: true, nextOffset: lineNumber };
    }
    return undefined;
  };

  const consume = (text: string): NumberedTextRangeResult | undefined => {
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf("\n", cursor);
      const end = newline === -1 ? text.length : newline;
      const segment = text.slice(cursor, end);
      if (segment.length > 0) currentLineHasContent = true;
      if (selected()) {
        if (!startSelectedLine() || !appendBounded(segment)) return budgetStopResult();
        if (newline === -1 && body.length >= charBudget) return budgetStopResult();
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
  if (currentLineHasContent) {
    const completed = completeLine();
    if (completed) return { body: completed.body, hasMore: false };
  }
  return { body, hasMore: false };
}
