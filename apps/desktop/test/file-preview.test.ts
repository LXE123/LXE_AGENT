import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePreviewService } from "../src/main/file-preview/service";
import { OfficePreviewCache } from "../src/main/file-preview/office-cache";
import { workspacePath } from "../src/main/file-preview/paths";
import type { SessionFileRef } from "@lxe/desktop-protocol";
const roots: string[] = [], services: FilePreviewService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lxe-preview-中文 ")); roots.push(root);
  const workspace = join(root, "workspace"), outside = join(root, "outside"); await mkdir(workspace); await mkdir(outside);
  await writeFile(join(workspace, "中文 file.md"), "# 标题\n内容"); await writeFile(join(outside, "external.txt"), "external");
  let linked = true;
  const nativeCalls: string[] = [];
  const service = new FilePreviewService(() => ({
    resolveWorkspaceDirectory: async id => { if (id !== "s") throw new Error("Session not found"); return workspace; },
    resolveArtifact: async (s, id) => linked && s === "s" && id === "a" ? join(outside, "external.txt") : undefined,
    resolveAttachment: async (s, id) => s === "s" && id === "i" ? join(outside, "missing.png") : undefined,
    resolveImagePreview: async () => ({ source: "history", image: { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("historical").toString("base64") } } }),
  }), new OfficePreviewCache(join(root, "cache"), "cli"), { openPath: async path => { nativeCalls.push(path); return ""; }, revealPath: path => nativeCalls.push(path) }, {
    list: async () => [{ id: "installed", name: "Editor", default: true, icon: null }],
    open: async (_path, id) => { if (id !== "installed") throw new Error("Application is not registered for this file"); nativeCalls.push(id); },
  }); services.push(service);
  return { root, workspace, outside, service, nativeCalls, unlink: () => { linked = false; } };
}
const ref: SessionFileRef = { session_id: "s", kind: "workspace", path: "中文 file.md" };
test("workspace boundary rejects parent, absolute paths and symlink escape", async () => {
  const f = await fixture();
  for (const path of ["../outside/external.txt", f.outside, "C:\\Windows\\file", "a/../../file"]) await expect(workspacePath(f.workspace, path)).rejects.toThrow();
  await symlink(f.outside, join(f.workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(workspacePath(f.workspace, "escape/external.txt")).rejects.toThrow("outside");
});
test("pages directories first, includes hidden files, and does not treat symlinks as navigable directories", async () => {
  const f = await fixture(); await mkdir(join(f.workspace, "folder")); await writeFile(join(f.workspace, ".hidden"), "x");
  await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(join(f.workspace, `${i}.txt`), "x")));
  const first = await f.service.call({ operation: "list", input: { session_id: "s", path: "" } });
  expect(first.entries[0]?.kind).toBe("directory"); expect(first.entries.some(e => e.name === ".hidden")).toBe(true); expect(first.entries).toHaveLength(200);
  const second = await f.service.call({ operation: "list", input: { session_id: "s", path: "", offset: first.next! } }); expect(second.entries).toHaveLength(8); expect(second.next).toBeNull();
});
test("preview uses opaque handles, preserves bytes and invalidates changed/deleted sources", async () => {
  const f = await fixture(), input = join(f.workspace, ref.kind === "workspace" ? ref.path : "");
  const before = await readFile(input);
  const p = await f.service.call({ operation: "prepare", input: { ref, request_id: "p" } });
  expect(p.metadata.kind).toBe("markdown"); expect(Buffer.from(await f.service.read(p.handle))).toEqual(before);
  expect(await readFile(input)).toEqual(before);
  await writeFile(input, "changed"); await expect(f.service.read(p.handle)).rejects.toThrow("changed");
  await rm(input); await expect(f.service.call({ operation: "stat", input: { ref } })).rejects.toThrow("ENOENT");
  await f.service.call({ operation: "release", input: { request_id: "p" } }); await expect(f.service.read(p.handle)).rejects.toThrow("closed");
});
test("artifact references may be outside workspace but cannot cross sessions or outlive their record", async () => {
  const f = await fixture(), artifact: SessionFileRef = { session_id: "s", kind: "artifact", id: "a" };
  const p = await f.service.call({ operation: "prepare", input: { ref: artifact, request_id: "a" } });
  expect(Buffer.from(await f.service.read(p.handle)).toString()).toBe("external");
  await expect(f.service.call({ operation: "stat", input: { ref: { ...artifact, session_id: "other" } } })).rejects.toThrow("not part");
  f.unlink(); await expect(f.service.read(p.handle)).rejects.toThrow("not part");
});
test("historical attachment preview survives original deletion while native opening still fails", async () => {
  const f = await fixture(), image: SessionFileRef = { session_id: "s", kind: "attachment", id: "i" };
  const p = await f.service.call({ operation: "prepare", input: { ref: image, request_id: "image" } });
  expect(p.metadata.source).toBe("history"); expect(Buffer.from(await f.service.read(p.handle)).toString()).toBe("historical");
  await expect(f.service.call({ operation: "open", input: { ref: image } })).rejects.toThrow("ENOENT");
});
test("Markdown resources are bound to their document directory and image types", async () => {
  const f = await fixture(); await writeFile(join(f.workspace, "图.png"), "image");
  const p = await f.service.call({ operation: "prepare", input: { ref, request_id: "md" } });
  expect(Buffer.from(await f.service.read(p.handle, "图.png")).toString()).toBe("image");
  await expect(f.service.read(p.handle, "../outside/external.txt")).rejects.toThrow("outside");
  await expect(f.service.read(p.handle, "中文 file.md")).rejects.toThrow("not an image");
});
test("native operations retain actual failures and reject an arbitrary application", async () => {
  const f = await fixture();
  expect(await f.service.call({ operation: "applications", input: { ref } })).toHaveLength(1);
  await expect(f.service.call({ operation: "open", input: { ref, application: "malicious" } })).rejects.toThrow("not registered");
  await f.service.call({ operation: "open", input: { ref, application: "installed" } }); expect(f.nativeCalls).toEqual(["installed"]);
});
test("text limits and unsupported files are explicit without reading arbitrary binaries", async () => {
  const f = await fixture(); await writeFile(join(f.workspace, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1)); await writeFile(join(f.workspace, "archive.zip"), "<script>bad()</script>");
  await expect(f.service.call({ operation: "prepare", input: { ref: { ...ref, kind: "workspace", path: "large.txt" }, request_id: "large" } })).rejects.toThrow("limit");
  const p = await f.service.call({ operation: "prepare", input: { ref: { ...ref, kind: "workspace", path: "archive.zip" }, request_id: "html" } }); expect(p.metadata.kind).toBe("unsupported"); expect(await f.service.read(p.handle)).toHaveLength(0);
});
test("conversion is coalesced, serial, cached, and cancelled only after the last consumer releases", async () => {
  const f = await fixture(); let calls = 0, active = 0, maxActive = 0, created = 0, disposed = 0;
  const cache = new OfficePreviewCache(join(f.root, "test-cache"), "cli", async () => { created++; return { dispose: async () => { disposed++; }, render: async ({ outputPath: output }, signal) => {
    signal!.throwIfAborted();
    calls++; active++; maxActive = Math.max(maxActive, active);
    try { await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 40); signal!.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true }); }); await writeFile(output, "%PDF-fixture"); return { missingFonts: ["Test font"] }; } finally { active--; }
  } }; });
  const a = new AbortController(), b = new AbortController();
  const first = cache.get(new Uint8Array([1]), ".docx", a.signal).catch(error => error.message), second = cache.get(new Uint8Array([1]), ".docx", b.signal);
  a.abort(); expect(await first).toContain("abort"); expect((await second).missingFonts).toEqual(["Test font"]); expect(calls).toBe(1);
  await cache.get(new Uint8Array([1]), ".docx", new AbortController().signal); expect(calls).toBe(1);
  await Promise.all([cache.get(new Uint8Array([2]), ".docx", new AbortController().signal), cache.get(new Uint8Array([3]), ".pptx", new AbortController().signal)]); expect(maxActive).toBe(1);
  const c = new AbortController(), pending = cache.get(new Uint8Array([4]), ".docx", c.signal); c.abort(); await expect(pending).rejects.toThrow(); await cache.dispose();
  expect(created).toBe(1); expect(disposed).toBe(1);
});

test("failed Kit load can retry, actual errors survive, and disposal waits for cancellation", async () => {
  const f = await fixture(); let attempts = 0, disposed = false;
  let started!: () => void, exited = false;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const cache = new OfficePreviewCache(join(f.root, "retry-cache"), "cli", async () => {
    if (++attempts === 1) throw new Error("actual missing Kit package");
    return { dispose: async () => { expect(exited).toBe(true); disposed = true; }, render: async (_options, signal) => {
      started();
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
      exited = true; throw new Error("actual Kit cancellation");
    } };
  });
  await expect(cache.get(new Uint8Array([1]), ".docx", new AbortController().signal)).rejects.toThrow("actual missing Kit package");
  const pending = cache.get(new Uint8Array([2]), ".docx", new AbortController().signal).catch(error => error.message);
  await ready; await cache.dispose();
  expect(await pending).toBe("actual Kit cancellation"); expect(disposed).toBe(true); expect(attempts).toBe(2);
  await expect(cache.get(new Uint8Array([3]), ".docx", new AbortController().signal)).rejects.toThrow("disposed");
  await cache.dispose();
});

test("paged text reads beyond 32 MiB, preserves CRLF and rejects stale/released handles", async () => {
  const f = await fixture(), path = join(f.workspace, "大日志 file.log");
  const line = "内容".repeat(40) + "\r\n";
  await writeFile(path, line.repeat(150000));
  const p = await f.service.call({ operation: "prepare", input: { ref: { ...ref, kind: "workspace", path: "大日志 file.log" }, request_id: "paged", mode: "text" } });
  expect(p.metadata.size).toBeGreaterThan(32 * 1024 * 1024); expect(p.metadata.displayPath).toBe(await realpath(path));
  const first = await f.service.readText(p.handle);
  expect(first.text).toBe(line.repeat(5000)); expect(first.lines).toBe(5000); expect(first.next).toBe(5001); expect(first.eof).toBe(false);
  const last = await f.service.readText(p.handle, { offset: 149999 }); expect(last.text).toBe(line.repeat(2)); expect(last.eof).toBe(true);
  await expect(f.service.read(p.handle)).rejects.toThrow("paged");
  await writeFile(path, "changed"); await expect(f.service.readText(p.handle)).rejects.toThrow("changed");
  f.service.release("paged"); await expect(f.service.readText(p.handle)).rejects.toThrow("closed");
}, 30_000);

test("text page byte/line boundaries, BOM encodings, invalid data and cancellation", async () => {
  const { readTextPage, TEXT_PAGE_BYTES } = await import("../src/main/file-preview/text-pages");
  const f = await fixture(), path = join(f.workspace, "pages.txt");
  await writeFile(path, "a\n".repeat(5000)); expect((await readTextPage(path)).eof).toBe(true);
  await writeFile(path, "a\n".repeat(5001)); expect((await readTextPage(path)).eof).toBe(false);
  await writeFile(path, "x".repeat(TEXT_PAGE_BYTES)); expect((await readTextPage(path)).text.length).toBe(TEXT_PAGE_BYTES);
  await writeFile(path, "x".repeat(TEXT_PAGE_BYTES + 1)); await expect(readTextPage(path)).rejects.toThrow("exceeds 2 MiB");
  const content = "标题😀\r\n第二行\n末尾", little = Buffer.from("\ufeff" + content, "utf16le");
  await writeFile(path, little); expect((await readTextPage(path)).text).toBe(content);
  await writeFile(path, little.swap16()); expect((await readTextPage(path, { offset: 2 })).text).toBe("第二行\n末尾");
  await writeFile(path, Buffer.from([255, 0, 255])); await expect(readTextPage(path)).rejects.toThrow();
  await writeFile(path, "a\0b"); await expect(readTextPage(path)).rejects.toThrow("NUL");
  await expect(readTextPage(path, { offset: -1 })).rejects.toThrow("range");
  const abort = new AbortController(); abort.abort(); await expect(readTextPage(path, {}, abort.signal)).rejects.toThrow();
});

test("directory subscriptions detect changes, enforce roots, release, and open only the session workspace", async () => {
  const f = await fixture();
  const first = await f.service.call({ operation: "watch-directory", input: { session_id: "s", path: "", request_id: "tree" } });
  const list = await f.service.call({ operation: "list", input: { session_id: "s", path: "" } }); expect(list.rootPath).toBe(f.workspace); expect(list.version).toBeTruthy();
  await writeFile(join(f.workspace, "new.txt"), "new");
  const next = await f.service.call({ operation: "directory-version", input: { request_id: "tree" } }); expect(next.version).not.toBe(first.version);
  await expect(f.service.call({ operation: "watch-directory", input: { session_id: "s", path: "../outside", request_id: "escape" } })).rejects.toThrow("outside");
  await expect(f.service.call({ operation: "open-workspace", input: { session_id: "other" } })).rejects.toThrow("Session");
  await f.service.call({ operation: "open-workspace", input: { session_id: "s" } }); expect(f.nativeCalls).toEqual([await realpath(f.workspace)]);
  f.service.release("tree"); await expect(f.service.call({ operation: "directory-version", input: { request_id: "tree" } })).rejects.toThrow("closed");
  const pending = f.service.call({ operation: "watch-directory", input: { session_id: "s", path: "", request_id: "cancel" } }); f.service.release("cancel"); await expect(pending).rejects.toThrow();
});

test("file errors cross IPC as data and distinguish deleted source, invalid references and missing helpers", async () => {
  const { fileResult } = await import("../src/main/file-preview/errors");
  const f = await fixture();
  const call = (operation: "stat" | "applications" | "open", file = ref) => fileResult(operation, () => f.service.call({ operation, input: { ref: file } }));
  await rm(join(f.workspace, "中文 file.md"));
  for (const operation of ["stat", "applications", "open"] as const) {
    const value = structuredClone(await call(operation));
    expect(value.ok).toBe(false);
    if (!value.ok) { expect(value.error.kind).toBe("not_found"); expect(value.error.operation).toBe(operation); expect(value.error.diagnostic).toContain("ENOENT"); }
  }
  const invalid = await call("stat", { ...ref, kind: "workspace", path: "../outside/external.txt" });
  expect(invalid.ok ? "success" : invalid.error.kind).toBe("invalid_reference");
  await writeFile(join(f.workspace, "中文 file.md"), "restored");
  expect((await call("stat")).ok).toBe(true);
  const { createOfficeConverter } = await import("../src/main/file-preview/office-kit");
  const helper = await fileResult("prepare", () => createOfficeConverter(join(f.root, "absent-kit", "cli.js")));
  expect(helper.ok).toBe(false);
  if (!helper.ok) { expect(helper.error.kind).toBe("unknown"); expect(helper.error.diagnostic).toMatch(/Cannot find|Cannot resolve/); }
  const history = { session_id: "s", kind: "attachment" as const, id: "i" };
  expect((await f.service.call({ operation: "stat", input: { ref: history } })).source).toBe("history");
  const original = await fileResult("stat", () => f.service.call({ operation: "stat", input: { ref: history, original: true } }));
  expect(original.ok ? "success" : original.error.kind).toBe("not_found");
});

test("permissions are recognized only at target access; diagnostics retain real exceptions with bounded redaction", async () => {
  const { chmod } = await import("node:fs/promises");
  const { sourceAccess, fileResult, fileFailure } = await import("../src/main/file-preview/errors");
  const f = await fixture(), path = join(f.workspace, "中文 file.md");
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await chmod(path, 0);
    try {
      const value = await fileResult("read", () => sourceAccess(() => readFile(path)));
      expect(value.ok).toBe(false);
      if (!value.ok) { expect(value.error.kind).toBe("permission_denied"); expect(value.error.diagnostic).toContain("EACCES"); }
    } finally { await chmod(path, 0o600); }
  }
  const diagnostic = fileFailure(new Error("actual failure\nBearer private-token\nhttps://host?token=private-token&key=secret-value\n" + "x".repeat(20000)), "applications");
  expect(diagnostic.kind).toBe("unknown"); expect(diagnostic.diagnostic).toStartWith("actual failure\n");
  expect(diagnostic.diagnostic).not.toContain("private-token"); expect(diagnostic.diagnostic).not.toContain("secret-value"); expect(diagnostic.diagnostic).toEndWith("[truncated]");
});

test("skill previews resolve only session-authorized names and revalidate each content read", async () => {
  const root = await mkdtemp(join(tmpdir(), "lxe-skill-preview-")); roots.push(root);
  const workspace = join(root, "workspace"), skill = join(root, "skills", "中文 skill");
  await mkdir(workspace); await mkdir(skill, { recursive: true });
  const source = join(skill, "SKILL.md"); await writeFile(source, "# Current skill\n正文");
  let allowed = true;
  const service = new FilePreviewService(() => ({
    resolveWorkspaceDirectory: async id => { if (id !== "s") throw new Error("Session not found"); return workspace; },
    resolveSkill: async (id, name) => allowed && id === "s" && name === "demo" ? source : undefined,
    resolveArtifact: async () => undefined, resolveAttachment: async () => undefined,
    resolveImagePreview: async () => { throw new Error("Not an image attachment"); },
  }), new OfficePreviewCache(join(root, "cache"), "cli"), { openPath: async () => "", revealPath: () => {} });
  services.push(service);
  const file = { session_id: "s", kind: "skill" as const, id: "demo" };
  const prepared = await service.call({ operation: "prepare", input: { ref: file, request_id: "skill", mode: "text" } });
  expect(prepared.metadata.kind).toBe("markdown"); expect((await service.readText(prepared.handle)).text).toContain("正文");
  for (const invalid of [{ ...file, session_id: "other" }, { ...file, id: source }, { ...file, id: "../demo" }]) {
    await expect(service.call({ operation: "stat", input: { ref: invalid } })).rejects.toThrow();
  }
  allowed = false; await expect(service.readText(prepared.handle)).rejects.toThrow("not part");
  allowed = true; await rm(source); await expect(service.call({ operation: "stat", input: { ref: file } })).rejects.toThrow("ENOENT");
  await writeFile(source, "# Restored");
  const restored = await service.call({ operation: "prepare", input: { ref: file, request_id: "restored", mode: "text" } });
  expect((await service.readText(restored.handle)).text).toBe("# Restored");
});
