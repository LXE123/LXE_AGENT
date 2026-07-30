import { describe, expect, test } from "bun:test";

import { displayText, splitContentBlocks } from "../../src/shared/content";
import { splitCallArguments } from "../../src/features/sessions/conversation";
import { languageForPath } from "../../src/shared/ui/code-block";

describe("splitContentBlocks", () => {
  test("keeps a tool result's newlines real instead of escaping them", () => {
    const content = [{ type: "text", text: "status: completed\nexit_code: 0" }];

    // The regression this guards: JSON.stringify turns the block's newlines
    // into literal backslash-n and the output arrives as one unreadable wall.
    expect(displayText(content)).toContain("\\n");
    expect(splitContentBlocks(content).text).toBe("status: completed\nexit_code: 0");
    expect(splitContentBlocks(content).text).not.toContain("\\n");
  });

  test("hands back non-text blocks rather than dropping them", () => {
    const image = { type: "image", source: { data: "…" } };
    const { text, residual } = splitContentBlocks([{ type: "text", text: "ok" }, image]);

    expect(text).toBe("ok");
    expect(residual).toEqual([image]);
  });

  test("passes a plain string straight through", () => {
    expect(splitContentBlocks("plain output")).toEqual({ text: "plain output", residual: [] });
  });

  test("treats a bare object as residue so nothing is silently lost", () => {
    expect(splitContentBlocks({ unexpected: true })).toEqual({
      text: "",
      residual: [{ unexpected: true }],
    });
  });
});

describe("splitCallArguments", () => {
  test("leads with the value that describes the call and keeps the rest", () => {
    const call = { input: { command: "ls -la", timeout: 120 } };

    expect(splitCallArguments(call)).toEqual({ primary: "ls -la", rest: { timeout: 120 } });
  });

  test("prefers the descriptive key over declaration order", () => {
    const call = { input: { limit: 12, path: "src/app.ts" } };

    expect(splitCallArguments(call).primary).toBe("src/app.ts");
    expect(splitCallArguments(call).rest).toEqual({ limit: 12 });
  });

  test("falls back to any scalar when no known key is present", () => {
    expect(splitCallArguments({ input: { unknown_key: "value" } })).toEqual({
      primary: "value",
      rest: {},
    });
  });

  test("survives a call with no input at all", () => {
    expect(splitCallArguments(undefined)).toEqual({ primary: "", rest: {} });
    expect(splitCallArguments({ input: {} })).toEqual({ primary: "", rest: {} });
  });
});

describe("languageForPath", () => {
  test("maps registered extensions and stays quiet about the rest", () => {
    expect(languageForPath("apps/dashboard/src/view.tsx")).toBe("typescript");
    expect(languageForPath("python/lxeskill/catalog.json")).toBe("json");
    expect(languageForPath("scripts/wt-claim.sh")).toBe("bash");
    // An unknown extension must resolve to "", which renders as plain text —
    // guessing a grammar would only mis-colour the file.
    expect(languageForPath("db/agent.sqlite3")).toBe("");
    expect(languageForPath("LICENSE")).toBe("");
    expect(languageForPath("")).toBe("");
  });
});
