/** Text carried by both the user message and the conversation transcript. */
export interface MessageQuote {
  text: string;
  comment: string;
}

const attach = "<!-- attach -->";
const nextReply = "<!-- reply -->";
const replyHeader = /^<!-- reply ([1-9]\d*) -->$/;
const reservedLine = /^(<|&(?:amp;)*lt;)(!-- (?:attach|reply(?: [1-9]\d*)?) -->)$/gm;

// A literal marker in a comment or at the start of the remaining draft is content.
function escapeMarkers(text: string): string {
  return text.replace(reservedLine, (_, prefix: string, rest: string) =>
    (prefix === "<" ? "&lt;" : "&amp;" + prefix.slice(1)) + rest);
}

function unescapeMarkers(text: string): string {
  return text.replace(reservedLine, (_, prefix: string, rest: string) =>
    (prefix === "&lt;" ? "<" : prefix.replace(/^&amp;/, "&")) + rest);
}

export function composeQuotedMessage(quotes: readonly MessageQuote[], text: string): string {
  if (!quotes.length) return text;
  const replies: string[] = [];
  const attachments: string[] = [];
  for (const quote of quotes) {
    const excerpt = quote.text.split("\n").map(line => "> " + line).join("\n");
    if (quote.comment) {
      // Three newlines separate all replies from the rest of the user message.
      const comment = escapeMarkers(quote.comment.trim()).replace(/\n{3,}/g, "\n\n");
      replies.push(excerpt + "\n\n" + comment);
    } else {
      attachments.push(attach + "\n" + excerpt);
    }
  }
  const replyGroup = replies.map((body, i) =>
    (i === 0 ? `<!-- reply ${replies.length} -->` : nextReply) + "\n" + body).join("\n\n");
  if (text) attachments.push(escapeMarkers(text));
  return [replyGroup, attachments.join("\n\n")].filter(Boolean).join("\n\n\n");
}

/** Only consume a well-formed prefix. Handwritten Markdown and old unmarked quotes stay readable. */
export function parseQuotedMessage(source: string): { quotes: MessageQuote[]; text: string } {
  const original = { quotes: [], text: source };
  if (!source.startsWith("<!-- ")) return original;
  const lines = source.split("\n");
  const count = Number(replyHeader.exec(lines[0]!)?.[1] ?? 0);
  if (!count && lines[0] !== attach) return original;
  const quotes: MessageQuote[] = [];
  let cursor = 0;
  function readExcerpt(): string {
    ++cursor; // consume the header
    const quoted: string[] = [];
    while (lines[cursor] === ">" || lines[cursor]?.startsWith("> ")) {
      quoted.push(lines[cursor++]!.slice(2));
    }
    return quoted.join("\n");
  }
  for (let index = 0; index < count; index++) {
    if (index > 0 && lines[cursor] !== nextReply) return original;
    const text = readExcerpt();
    if (!text.trim() || lines[cursor++] !== "") return original;
    const start = cursor;
    while (cursor < lines.length && !(lines[cursor] === "" &&
      (lines[cursor + 1] === "" || lines[cursor + 1] === nextReply))) cursor++;
    const comment = lines.slice(start, cursor).join("\n");
    if (!comment.trim()) return original;
    quotes.push({ text, comment: unescapeMarkers(comment) });
    if (index + 1 < count) cursor++; // blank line before the next reply header
    else if (cursor < lines.length) {
      if (lines[cursor + 1] !== "") return original;
      cursor += 2; // two blank lines before the attachments or message
    }
  }
  while (lines[cursor] === attach) {
    const text = readExcerpt();
    if (!text.trim() || (cursor < lines.length && lines[cursor++] !== "")) return original;
    quotes.push({ text, comment: "" });
  }
  return { quotes, text: unescapeMarkers(lines.slice(cursor).join("\n")) };
}
