import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBindingStore, SessionSource } from "./session-bindings";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionSource", () => {
  const keyCases: Array<[string, Record<string, string>, string]> = [
    ["p2p", {}, "agent:main:feishu:dm:chat-1"],
    ["private", {}, "agent:main:feishu:dm:chat-1"],
    ["", {}, "agent:main:feishu:dm:chat-1"],
    ["chat", { user_id: "open", user_id_alt: "union" }, "agent:main:feishu:group:chat-1:union"],
    ["group", { user_id: "open" }, "agent:main:feishu:group:chat-1:open"],
    ["group", { thread_id: "thread-1" }, "agent:main:feishu:group:chat-1:thread-1"],
    ["channel", {}, "agent:main:feishu:channel:chat-1"],
    ["thread", {}, "agent:main:feishu:thread:chat-1"],
  ];
  test.each(keyCases)("normalizes %s and constructs its key", (
    chatType: string,
    fields: Record<string, string>,
    expected: string,
  ) => {
    const source = SessionSource.from({
      platform: " feishu ",
      chat_id: " chat-1 ",
      chat_type: chatType,
      extra: { bot_app_id: "bot" },
      ...fields,
    });
    expect(source.sessionKey).toBe(expected);
    expect(source.toJSON().extra).toEqual({ bot_app_id: "bot" });
  });

  test("rejects incomplete sources at the same key boundaries as Python", () => {
    expect(() => SessionSource.from({ chat_id: "chat" }).sessionKey).toThrow(
      "session source platform required",
    );
    expect(() => SessionSource.from({ platform: "feishu" }).sessionKey).toThrow(
      "session source chat_id required",
    );
    expect(
      () =>
        SessionSource.from({ platform: "feishu", chat_id: "chat", chat_type: "group" })
          .sessionKey,
    ).toThrow("group session source user_id or user_id_alt required");
  });
});

describe("SessionBindingStore", () => {
  test("probes a Unicode/space state path without creating sessions.json", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-bindings-probe-"));
    roots.push(root);
    const path = join(root, "状态 with spaces", "sessions.json");
    const store = new SessionBindingStore(path);
    store.ensureUsable();
    expect(readdirSync(join(root, "状态 with spaces"))).toEqual([]);

    writeFileSync(path, "[]", "utf8");
    expect(() => store.ensureUsable()).toThrow("must be a JSON object");
  });

  test("writes deterministic UTF-8 JSON atomically and preserves entry flags", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-bindings-"));
    roots.push(root);
    const path = join(root, "nested", "sessions.json");
    let index = 0;
    const store = new SessionBindingStore(path, {
      now: () => (index++ === 0 ? "2026-01-01T00:00:00+00:00" : "2026-01-02T00:00:00+00:00"),
      id: () => "session-a",
    });
    const source = SessionSource.from({
      platform: "feishu",
      chat_id: "群聊",
      chat_type: "dm",
      user_id: "user",
      extra: { label: "中文" },
    });

    const first = store.getOrCreate(source);
    expect(first.session_id).toBe("session-a");
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("群聊");
    expect(raw.endsWith("\n")).toBe(true);
    expect(readdirSync(join(root, "nested"))).toEqual(["sessions.json"]);

    const payload = JSON.parse(raw);
    payload[first.session_key].resume_pending = true;
    payload[first.session_key].suspended = true;
    writeFileSync(path, `${JSON.stringify(payload)}\n`, "utf8");
    const rebound = store.bind(source, "session-b");
    expect(rebound.created_at).toBe(first.created_at);
    expect(rebound.resume_pending).toBe(true);
    expect(rebound.suspended).toBe(true);
    expect(Object.keys(store.loadAll())).toEqual([first.session_key]);
  });

  test("rejects invalid sessions roots and ignores invalid entries", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-bindings-invalid-"));
    roots.push(root);
    const path = join(root, "sessions.json");
    writeFileSync(path, "[]", "utf8");
    expect(() => new SessionBindingStore(path).loadAll()).toThrow("must be a JSON object");
    writeFileSync(path, '{"bad": 1, "empty": {"session_id": ""}}', "utf8");
    expect(new SessionBindingStore(path).loadAll()).toEqual({});
  });
});
