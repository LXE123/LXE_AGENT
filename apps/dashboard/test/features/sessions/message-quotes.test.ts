import { expect, test } from "bun:test";
import { composeQuotedMessage, parseQuotedMessage } from "../../../src/features/sessions/message-quotes";

test("two ordinary selections remain separate clickable excerpts in the saved message", () => {
  const quotes = [{ text: "first\n\nline", comment: "" }, { text: "second", comment: "" }];
  const wire = "<!-- attach -->\n> first\n> \n> line\n\n<!-- attach -->\n> second\n\n不错";
  expect(composeQuotedMessage(quotes, "不错")).toBe(wire);
  expect(parseQuotedMessage(wire)).toEqual({ quotes, text: "不错" });
});

test("counted replies precede ordinary attachments and preserve the comment/body boundary", () => {
  const plain = { text: "snippet", comment: "" };
  const first = { text: "line A\nline B", comment: "note\n\nnext paragraph" };
  const second = { text: "another", comment: "why?" };
  const wire = "<!-- reply 2 -->\n> line A\n> line B\n\nnote\n\nnext paragraph\n\n<!-- reply -->\n> another\n\nwhy?\n\n\n<!-- attach -->\n> snippet\n\n@file";
  expect(composeQuotedMessage([plain, first, second], "@file")).toBe(wire);
  expect(parseQuotedMessage(wire)).toEqual({ quotes: [first, second, plain], text: "@file" });
  for (const quote of [plain, first]) {
    expect(parseQuotedMessage(composeQuotedMessage([quote], ""))).toEqual({ quotes: [quote], text: "" });
  }
});

test("marker examples inside a quote, comment or draft survive the round trip", () => {
  const quotes = [{ text: "<!-- attach -->\n> quoted example", comment: "example\n\n<!-- reply -->\n> nested\n\nend" }];
  const text = "<!-- attach -->\n> literal example\n\n&amp;lt;!-- reply -->";
  expect(parseQuotedMessage(composeQuotedMessage(quotes, text))).toEqual({ quotes, text });
});

test("unmarked history, Markdown examples and incomplete headers remain readable as entered", () => {
  for (const text of ["> old quote\n\nreply", "example:\n<!-- attach -->\n> a", "<!-- attach -->\nnot an excerpt",
    "<!-- reply 2 -->\n> a\n\ncomment", "<!-- reply 1 -->\n> a\n\n", "<!-- attach -->\n> one\nmissing separator"]) {
    expect(parseQuotedMessage(text)).toEqual({ quotes: [], text });
    expect(composeQuotedMessage([], text)).toBe(text);
  }
});
