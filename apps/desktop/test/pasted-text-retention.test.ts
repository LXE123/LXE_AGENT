import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ProcessAgentRuntime } from "@lxe/gateway/desktop";
import { SqliteRuntimeStore } from "../../../packages/agent/runtime/src/state/storage";
import { DesktopConversationAttachmentService } from "../src/main/conversation-attachments";
import { PastedTextRetention } from "../src/main/pasted-text-retention";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lxe-paste-retention-"));
  const directory = join(root, "attachments", "pasted-text");
  const drafts = new DesktopConversationAttachmentService(undefined, directory);
  const database = new Database(join(root, "gateway.db"));
  const retention = new PastedTextRetention(database as unknown as DatabaseSync, directory);
  const agent = new SqliteRuntimeStore(join(root, "agent.db"));
  cleanups.push(async () => {
    database.close(true); // Release the Bun SQLite file handle before removing the directory on Windows.
    await agent.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await agent.start();
  const session = (id: string) => agent.ensureSession({ session_id: id, source: {}, workspace: { directory: root, worktree: root } });
  await session("parent");
  const paste = async (name = "Pasted text.txt") => {
    const { attachment_id } = await drafts.registerTextPaste("saved text", name);
    const [file] = drafts.beginSend([attachment_id]);
    drafts.consume([attachment_id]);
    return file!;
  };
  const collect = (id?: string) => retention.collect(async candidates => agent.unusedAttachmentPaths(candidates), path => drafts.isStaged(path), id);
  const removeSession = async (id: string) => {
    retention.prepareDeletion(id, await agent.attachmentPaths(id));
    expect(await agent.deleteSession(id)).toBe(true);
    await collect(id);
  };
  const append = async (id: string, turn: string, file: Awaited<ReturnType<typeof paste>>) => {
    await agent.appendMessage(id, { role: "user", content: [{ ...file, type: "local_file", turn_id: turn, ts: 1 }] }, "turn_input", turn);
    await agent.appendTurnEnd(id, turn, "completed");
  };
  return { root, directory, drafts, database, retention, agent, session, paste, collect, removeSession, append };
}

for (const first of ["parent", "fork"]) {
  test(`shared pastes survive deleting the ${first} first, including pre-upgrade history`, async () => {
    const f = await fixture();
    const shared = await f.paste("粘贴的文本 2.txt");
    const later = await f.paste();
    const manual = join(f.root, "Pasted text.txt");
    writeFileSync(manual, "my own file");
    await f.append("parent", "one", shared);
    await f.append("parent", "two", later);
    const [selected] = f.drafts.register([manual]);
    await f.append("parent", "three", f.drafts.resolve([selected!.attachment_id])[0]!);
    const fork = String((await f.agent.forkSession("parent", "one")).session_id);
    await f.agent.replaceMessages("parent", [{ role: "user", content: "summary" }], "compaction");
    await f.agent.stop(); await f.agent.start();
    await f.removeSession(first === "parent" ? "parent" : fork);
    expect(readFileSync(shared.path, "utf8")).toBe("saved text");
    expect(existsSync(later.path)).toBe(first === "fork");
    await f.removeSession(first === "parent" ? fork : "parent");
    expect(existsSync(dirname(shared.path))).toBe(false);
    expect(existsSync(dirname(later.path))).toBe(false);
    expect(readFileSync(manual, "utf8")).toBe("my own file");
  });
}

test("a queued attachment and a second draft protect the file until the last reference is released", async () => {
  const f = await fixture();
  const file = await f.paste();
  await f.append("parent", "one", file);
  await f.session("other");
  const [alias] = f.drafts.register([file.path]);
  expect(alias!.attachment_id).not.toBe(file.attachment_id);
  f.retention.admit("other", [file.path]);
  f.retention.admit("other", [file.path])(); // A rejected retry must preserve the accepted send.
  f.drafts.consume([alias!.attachment_id]);
  await f.removeSession("parent");
  expect(readFileSync(file.path, "utf8")).toBe("saved text");
  const [inDraft] = f.drafts.register([file.path]);
  await f.removeSession("other");
  expect(existsSync(file.path)).toBe(true);
  expect(f.retention.takeDeferred()).toBe(true);
  f.drafts.discard([inDraft!.attachment_id]);
  await f.collect();
  expect(existsSync(dirname(file.path))).toBe(false);
});

test("independent conversations referencing the same file with different IDs retain it across agent RPC", async () => {
  const f = await fixture();
  const file = await f.paste();
  await f.append("parent", "one", file);
  await f.session("other");
  const [alias] = f.drafts.register([file.path]);
  await f.append("other", "two", f.drafts.resolve([alias!.attachment_id])[0]!);
  f.drafts.consume([alias!.attachment_id]);
  await f.agent.stop();
  const runtime = new ProcessAgentRuntime({
    command: process.execPath, arguments: [resolve("apps/agent-cli/src/main.ts")], cwd: process.cwd(),
    environment: { PATH: process.env.PATH, LOCAL_LOGS_ENABLED: "0", LXE_DATA_SERVER_ENABLED: "0",
      LXE_AGENT_SQLITE_DB_PATH: join(f.root, "agent.db") },
    dataRoot: f.root, skillsRoot: resolve("skills"), userSkillsRoot: join(f.root, "skills"), llmConfigRoot: resolve("config/llm"),
    legacyWorkspace: { directory: f.root, worktree: f.root },
  });
  try {
    await runtime.start();
    for (const id of ["parent", "other"]) {
      const paths = await runtime.sessionAttachmentPaths(id);
      expect(paths).toEqual([file.path]);
      f.retention.prepareDeletion(id, paths);
      await runtime.dashboardCall({ operation: "sessions.delete", input: { session_id: id } });
      await f.retention.collect(candidates => runtime.unusedAttachmentPaths(candidates), path => f.drafts.isStaged(path), id);
      expect(existsSync(file.path)).toBe(id === "parent");
    }
  } finally { await runtime.stop(); }
});

test("a failed reference check keeps the file and the next startup completes cleanup", async () => {
  const f = await fixture();
  const file = await f.paste();
  f.retention.prepareDeletion("parent", [file.path]);
  expect(await f.agent.deleteSession("parent")).toBe(true);
  await expect(f.retention.collect(async () => { throw new Error("agent offline"); }, () => false)).rejects.toThrow("agent offline");
  expect(existsSync(file.path)).toBe(true);
  const reopened = new Database(join(f.root, "gateway.db"));
  try {
    const retention = new PastedTextRetention(reopened as unknown as DatabaseSync, f.directory);
    await retention.collect(async candidates => f.agent.unusedAttachmentPaths(candidates), () => false);
    expect(existsSync(file.path)).toBe(false);
  } finally { reopened.close(true); }
});

test("startup only retries explicit deletion and a failed session deletion keeps its files", async () => {
  const f = await fixture();
  const file = await f.paste();
  f.retention.admit("parent", [file.path]);
  await f.retention.collect(async () => { throw new Error("no deletion is pending"); }, () => false);
  f.retention.prepareDeletion("parent", []);
  await f.collect();
  expect(readFileSync(file.path, "utf8")).toBe("saved text");
  await f.removeSession("parent");
  expect(existsSync(file.path)).toBe(false);
});

test("a send admitted during the asynchronous reference check invalidates its result", async () => {
  const f = await fixture();
  const file = await f.paste();
  f.retention.prepareDeletion("parent", [file.path]);
  await f.agent.deleteSession("parent");
  await f.session("new");
  let checks = 0;
  await f.retention.collect(async candidates => {
    const unused = f.agent.unusedAttachmentPaths(candidates);
    if (++checks === 1) f.retention.admit("new", [file.path]);
    return unused;
  }, () => false, "parent");
  expect(checks).toBe(2);
  expect(existsSync(file.path)).toBe(true);
  await f.removeSession("new");
  expect(existsSync(file.path)).toBe(false);
});

test("cleanup cannot follow a replacement paste-directory symlink", async () => {
  const f = await fixture();
  const file = await f.paste();
  f.retention.prepareDeletion("parent", [file.path]);
  const external = join(f.root, "unrelated");
  renameSync(dirname(file.path), external);
  symlinkSync(external, dirname(file.path), "junction");
  await f.removeSession("parent");
  expect(readFileSync(join(external, file.name), "utf8")).toBe("saved text");
});

test("startup removes unsent pastes a crash left behind, but keeps referenced, staged and unrelated files", async () => {
  const f = await fixture();
  // Sent before owner rows existed: only the transcript refers to it.
  const sent = await f.paste();
  await f.append("parent", "one", sent);
  // A crash skips clear(), so these drafts never get an owner row.
  const crashed = await f.drafts.registerTextPaste("unsent draft", "Pasted text.txt");
  const [crashedFile] = f.drafts.resolve([crashed.attachment_id]);
  const unrelated = join(f.directory, crypto.randomUUID(), "notes.txt");
  mkdirSync(dirname(unrelated)); writeFileSync(unrelated, "not a paste");

  // After restart, a fresh draft service holds a new unsent paste of its own.
  const restarted = new DesktopConversationAttachmentService(undefined, f.directory);
  const current = await restarted.registerTextPaste("current draft", "粘贴的文本.txt");
  const [currentFile] = restarted.resolve([current.attachment_id]);
  const sweep = (orphans: boolean) => f.retention.collect(async candidates => f.agent.unusedAttachmentPaths(candidates),
    path => restarted.isStaged(path), undefined, { orphans });

  await sweep(false);
  expect(existsSync(crashedFile!.path)).toBe(true);
  await sweep(true);
  expect(existsSync(dirname(crashedFile!.path))).toBe(false);
  expect(readFileSync(sent.path, "utf8")).toBe("saved text");
  expect(readFileSync(currentFile!.path, "utf8")).toBe("current draft");
  expect(readFileSync(unrelated, "utf8")).toBe("not a paste");
  expect(f.retention.takeDeferred()).toBe(true);
});
