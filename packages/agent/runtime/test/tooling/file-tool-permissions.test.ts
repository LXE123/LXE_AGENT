import { ExecutionPaths } from "../../src/permissions/execution-paths";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonObject, PermissionMode } from "@lxe/protocol";
import { PermissionPolicyService } from "../../src/permissions/policy";
import { ModelImageProcessor } from "../../src/providers/model-image";
import { createFileTools } from "../../src/tooling/coding/file-tools";
import { FileVersionLedger } from "../../src/tooling/coding/file-version-ledger";
import { CodingPathPolicy } from "../../src/tooling/coding/path-policy";
import { ToolExecutionError, ToolRegistry, type ToolDefinition } from "../../src/tooling/registry";
import { workspaceFor } from "../workspace";

const roots: string[] = [];
const directoryLink = (target: string, path: string) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
type Context = Parameters<ToolDefinition["execute"]>[1];
const edit = (path: string): JsonObject => ({ path, edits: [{ oldText: "before", newText: "after" }] });
const write = (path: string): JsonObject => ({ file_path: path, content: "after" });

function fixture() {
  // Match the native path spelling used by filesystem permission diagnostics.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "lxe-file-permissions-")));
  roots.push(root);
  const workspace = join(root, "repo", "work 中文 space"), dataRoot = join(root, "var");
  mkdirSync(workspace, { recursive: true });
  const service = new PermissionPolicyService();
  const temporaryRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "lxe-file-temp-"))); roots.push(temporaryRoot);
  const executionPaths = new ExecutionPaths(dataRoot, { platform: "win32", temporaryRoot });
  const ledger = new FileVersionLedger();
  const registry = new ToolRegistry();
  for (const tool of createFileTools({ paths: new CodingPathPolicy({ homeDirectory: root }), ledger, executionPaths,
    imageProcessor: new ModelImageProcessor(), toolOutputLimit: 10_000 })) registry.register(tool);
  const context = (mode: PermissionMode = "workspace-write", sessionId = "first", controller = new AbortController()): Context => ({
    session_id: sessionId,
    workspace: workspaceFor(workspace, dirname(workspace)),
    executionPolicy: service.resolve({ session_id: sessionId, workspace: workspaceFor(workspace, dirname(workspace)), permission_mode: mode }),
    handle: { signal: controller.signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => undefined },
  });
  // Restricted policies are tested only via internal definitions, never a product bypass.
  const execute = (name: string, input: JsonObject, ctx = context()) => registry.definition(name)!.execute(input, ctx);
  const read = (path: string, ctx = context()) => execute("read", { path }, ctx);
  return { root, workspace, dataRoot, executionPaths, ledger, registry, context, execute, read };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

async function denied(operation: Promise<unknown>, mode: PermissionMode, target: string, reason?: string) {
  const cause = await operation.then(() => undefined, error => error);
  expect(cause).toBeInstanceOf(ToolExecutionError);
  expect(cause.code).toBe("permission_denied");
  expect(cause.message).toContain(mode);
  expect(cause.message).toContain(target);
  if (reason) expect(cause.message).toContain(reason);
}

test.each(["read-only", "workspace-write", "danger-full-access"] as const)("%s create, overwrite and edit follow policy", async mode => {
  const f = fixture(), ctx = f.context(mode), target = join(f.workspace, "new", "file.txt");
  if (mode === "read-only") {
    await denied(f.execute("write", write(target), ctx), mode, target);
    await denied(f.execute("edit", edit(target), ctx), mode, target);
    expect(existsSync(dirname(target))).toBe(false);
    writeFileSync(join(f.workspace, "existing"), "before");
    await f.read("existing", ctx);
    for (const [tool, input] of [["write", write("existing")], ["edit", edit("existing")]] as const) {
      await denied(f.execute(tool, input, ctx), mode, join(f.workspace, "existing"));
      expect(readFileSync(join(f.workspace, "existing"), "utf8")).toBe("before");
    }
  } else {
    await f.execute("write", { file_path: target, content: "before" }, ctx);
    await f.execute("edit", edit(target), ctx); // Successful write records this session's version.
    expect(readFileSync(target, "utf8")).toBe("after");
    await f.execute("write", { file_path: target, content: "overwritten" }, ctx);
    expect(readFileSync(target, "utf8")).toBe("overwritten");
  }
});

test("workspace and own temporary roots allow writes; sibling, traversal, home, private and host output do not", async () => {
  const f = fixture(), ctx = f.context(), other = f.context("workspace-write", "other");
  for (const target of [join(f.workspace, "nested", "..", "allowed"), join(f.executionPaths.temporaryDirectory(ctx.executionPolicy), "nested", "allowed")]) {
    await f.execute("write", write(target), ctx);
    expect(readFileSync(target, "utf8")).toBe("after");
  }
  for (const target of [join(f.workspace + "-sibling", "new", "file"), "../new/file", "~/new/file",
    join(f.executionPaths.temporaryDirectory(other.executionPolicy), "new", "file"), join(f.executionPaths.outputDirectory(ctx.executionPolicy), "new", "file"),
    join(f.dataRoot, "db", "new", "file")]) {
    await denied(f.execute("write", write(target), ctx), "workspace-write", "target=", "outside");
  }
  for (const parent of [f.workspace + "-sibling", join(dirname(f.workspace), "new"), join(f.root, "new"),
    f.executionPaths.temporaryDirectory(other.executionPolicy), f.executionPaths.outputDirectory(ctx.executionPolicy), join(f.dataRoot, "db")]) {
    expect(existsSync(parent)).toBe(false);
  }
  const outside = join(f.root, "outside");
  writeFileSync(outside, "before");
  await f.read(outside, ctx);
  for (const [tool, input] of [["write", write(outside)], ["edit", edit(outside)]] as const) {
    await denied(f.execute(tool, input, ctx), "workspace-write", outside);
    expect(readFileSync(outside, "utf8")).toBe("before");
  }
});

test.each(["write", "edit"] as const)("%s preserves full access outside the workspace, including tilde paths", async tool => {
  const f = fixture(), ctx = f.context("danger-full-access"), path = join(f.root, "outside");
  writeFileSync(path, "before");
  await f.read("~/outside", ctx);
  await f.execute(tool, tool === "write" ? write("~/outside") : edit("~/outside"), ctx);
  expect(readFileSync(path, "utf8")).toBe("after");
});

test("allowed directory symlinks/junctions support new files and the original read spelling", async () => {
  const f = fixture(), actual = join(f.workspace, "actual"), alias = join(f.workspace, "alias");
  mkdirSync(actual);
  directoryLink(actual, alias);
  await f.execute("write", { file_path: join(alias, "new", "file"), content: "before" });
  await f.execute("edit", edit(join(alias, "new", "file")));
  const path = join(actual, "existing");
  writeFileSync(path, "before");
  await f.read(join(alias, "existing"));
  await f.execute("edit", edit(join(alias, "existing")));
  await f.execute("write", write(join(alias, "existing")));
  expect(readFileSync(path, "utf8")).toBe("after");
  expect(readFileSync(join(actual, "new", "file"), "utf8")).toBe("after");
});

test.each(["write", "edit"] as const)("%s rejects outside directory symlinks/junctions and leaves existing files unchanged", async tool => {
  const f = fixture(), outside = join(f.root, "outside"), alias = join(f.workspace, "alias");
  mkdirSync(outside);
  writeFileSync(join(outside, "file"), "before");
  directoryLink(outside, alias);
  await f.read(join(alias, "file"));
  const target = join(alias, "file");
  await denied(f.execute(tool, tool === "write" ? write(target) : edit(target)), "workspace-write", target);
  expect(readFileSync(join(outside, "file"), "utf8")).toBe("before");
  await denied(f.execute("write", write(join(alias, "new", "file"))), "workspace-write", "target=");
  expect(existsSync(join(outside, "new"))).toBe(false);
});

test("file symlinks and dangling targets are resolved before mutation", async () => {
  const f = fixture(), target = join(f.workspace, "missing", "target"), alias = join(f.workspace, "file-link");
  symlinkSync(target, alias, "file");
  await f.execute("write", { file_path: alias, content: "before" });
  await f.read(alias);
  await f.execute("edit", edit(alias));
  expect(readFileSync(target, "utf8")).toBe("after");
  const outside = join(f.root, "missing", "outside"), escape = join(f.workspace, "escape");
  symlinkSync(outside, escape, "file");
  await denied(f.execute("write", write(escape)), "workspace-write", escape);
  expect(existsSync(dirname(outside))).toBe(false);
});

test.each(["write", "edit"] as const)("%s rejects actual hard links in restricted mode and retains full access behavior", async tool => {
  const f = fixture(), target = join(f.workspace, "file"), outside = join(f.root, "linked");
  writeFileSync(target, "before");
  linkSync(target, outside);
  expect(statSync(target).nlink).toBe(2);
  await f.read(target);
  const input = tool === "write" ? write(target) : edit(target);
  await denied(f.execute(tool, input), "workspace-write", target, "hard links");
  expect(readFileSync(target, "utf8")).toBe("before");
  expect(readFileSync(outside, "utf8")).toBe("before");
  await f.execute(tool, input, f.context("danger-full-access"));
  expect(readFileSync(target, "utf8")).toBe("after");
  expect(readFileSync(outside, "utf8")).toBe("after");
});

test("hard links entirely inside the workspace are also refused", async () => {
  const f = fixture(), target = join(f.workspace, "one"), other = join(f.workspace, "two");
  writeFileSync(target, "before"); linkSync(target, other);
  await f.read(target);
  await denied(f.execute("write", write(target)), "workspace-write", target, "hard links");
  expect(readFileSync(other, "utf8")).toBe("before");
});

test.each(["write", "edit"] as const)("%s requires a session read, and rejects changed versions and symlink targets", async tool => {
  const f = fixture(), a = join(f.workspace, "a"), b = join(f.workspace, "b"), alias = join(f.workspace, "link");
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, "file"), "before"); writeFileSync(join(b, "file"), "before");
  directoryLink(a, alias);
  const path = join(alias, "file"), input = tool === "write" ? write(path) : edit(path);
  await expect(f.execute(tool, input)).rejects.toThrow("先用 read");
  await f.read(path);
  await expect(f.execute(tool, input, f.context("workspace-write", "other"))).rejects.toThrow("先用 read");
  writeFileSync(join(a, "file"), "external changed");
  await expect(f.execute(tool, input)).rejects.toThrow("重新 read");
  writeFileSync(join(a, "file"), "before");
  await f.read(path);
  unlinkSync(alias); directoryLink(b, alias);
  await expect(f.execute(tool, input)).rejects.toThrow("重新 read");
  expect(readFileSync(join(a, "file"), "utf8")).toBe("before");
  expect(readFileSync(join(b, "file"), "utf8")).toBe("before");
});

test.each(["write", "edit"] as const)("%s rechecks links, versions and cancellation immediately before mutation", async tool => {
  // Simulate external changes after the first ledger check, without adding an async gap to production code.
  for (const change of ["hardlink", "version", "target", "cancel"] as const) {
    const f = fixture(), controller = new AbortController(), ctx = f.context("workspace-write", "first", controller);
    const a = join(f.workspace, "a"), b = join(f.workspace, "b"), alias = join(f.workspace, "alias");
    mkdirSync(a); mkdirSync(b);
    writeFileSync(join(a, "file"), "before"); writeFileSync(join(b, "file"), "before");
    directoryLink(a, alias);
    const path = join(alias, "file");
    await f.read(path, ctx);
    const original = f.ledger.assertVersion.bind(f.ledger);
    const hook = spyOn(f.ledger, "assertVersion").mockImplementationOnce((...args) => {
      original(...args);
      if (change === "hardlink") linkSync(join(a, "file"), join(f.root, "linked"));
      if (change === "version") writeFileSync(join(a, "file"), "before external change");
      if (change === "target") { unlinkSync(alias); directoryLink(b, alias); }
      if (change === "cancel") controller.abort(new Error("cancel fixture"));
    });
    try {
      const operation = f.execute(tool, tool === "write" ? write(path) : edit(path), ctx);
      if (change === "hardlink" || change === "target") await denied(operation, "workspace-write", path, change === "hardlink" ? "hard links" : "target changed");
      else await expect(operation).rejects.toThrow(change === "cancel" ? "cancel fixture" : "重新 read");
      expect(readFileSync(join(a, "file"), "utf8")).toBe(change === "version" ? "before external change" : "before");
      expect(readFileSync(join(b, "file"), "utf8")).toBe("before");
    } finally { hook.mockRestore(); }
  }
});

test("already cancelled calls create no directories or edits", async () => {
  const f = fixture(), controller = new AbortController(), ctx = f.context("workspace-write", "first", controller);
  writeFileSync(join(f.workspace, "file"), "before");
  await f.read("file", ctx);
  controller.abort(new Error("cancel fixture"));
  await expect(f.execute("write", write("missing/file"), ctx)).rejects.toThrow("cancel fixture");
  await expect(f.execute("edit", edit("file"), ctx)).rejects.toThrow("cancel fixture");
  expect(existsSync(join(f.workspace, "missing"))).toBe(false);
  expect(readFileSync(join(f.workspace, "file"), "utf8")).toBe("before");
});

test("a project-root workspace includes application-private files and ignores unrelated artifact links", async () => {
  const f = fixture(), ctx = f.context();
  directoryLink(f.root, join(f.workspace, ".lxeagent"));
  await f.execute("write", write("ordinary/file"), ctx);
  const policy = new PermissionPolicyService().resolve({ session_id: "first", workspace: workspaceFor(f.root), permission_mode: "workspace-write" });
  await f.execute("write", write(join(f.dataRoot, "db", "new")), { ...ctx, executionPolicy: policy });
  expect(readFileSync(join(f.dataRoot, "db", "new"), "utf8")).toBe("after");
});

test("missing edit and invalid parent preserve filesystem and path resolution errors", async () => {
  const f = fixture();
  await expect(f.execute("edit", edit("missing"))).rejects.toMatchObject({ code: "ENOENT" });
  writeFileSync(join(f.workspace, "parent"), "before");
  await expect(f.execute("write", write("parent/child"))).rejects.toThrow(`Path parent is not a directory: ${join(f.workspace, "parent")}`);
  expect(readFileSync(join(f.workspace, "parent"), "utf8")).toBe("before");
});

test("write refuses a file that appears after the initial missing-file check", async () => {
  const f = fixture(), target = join(f.workspace, "file");
  const original = fs.statSync;
  const hook = spyOn(fs, "statSync").mockImplementationOnce(((...args: Parameters<typeof fs.statSync>) => {
    try { return original(...args); } finally { writeFileSync(target, "external"); }
  }) as typeof fs.statSync);
  try { await expect(f.execute("write", write(target))).rejects.toThrow("重新 read"); } finally { hook.mockRestore(); }
  expect(readFileSync(target, "utf8")).toBe("external");
});

test("write refuses to recreate a file removed after the first observation", async () => {
  const f = fixture(), target = join(f.workspace, "file");
  writeFileSync(target, "before");
  await f.read(target);
  const original = fs.statSync;
  const hook = spyOn(fs, "statSync").mockImplementationOnce(((...args: Parameters<typeof fs.statSync>) => {
    const info = original(...args); unlinkSync(target); return info;
  }) as typeof fs.statSync);
  try { await expect(f.execute("write", write(target))).rejects.toThrow("重新 read"); } finally { hook.mockRestore(); }
  expect(existsSync(target)).toBe(false);
});

test("edit refuses to recreate a file removed after reading its edit source", async () => {
  const f = fixture(), target = join(f.workspace, "file");
  writeFileSync(target, "before");
  await f.read(target);
  const readSource = fs.readFileSync;
  const readThenRemove = ((...args: Parameters<typeof fs.readFileSync>) => {
    const content = readSource(...args);
    unlinkSync(target);
    return content;
  }) as typeof fs.readFileSync;
  const hook = spyOn(fs, "readFileSync").mockImplementationOnce(readThenRemove);
  try {
    await expect(f.execute("edit", edit(target))).rejects.toThrow("重新 read");
    expect(existsSync(target)).toBe(false);
  } finally { hook.mockRestore(); }
});

test("simultaneous sessions use their own workspace, temp and version ledger", async () => {
  const a = fixture(), b = fixture();
  // Share the tool instances, as the runtime does.
  await Promise.all([a.execute("write", write("own"), a.context()), a.execute("write", write("own"), b.context("workspace-write", "second"))]);
  expect(readFileSync(join(a.workspace, "own"), "utf8")).toBe("after");
  expect(readFileSync(join(b.workspace, "own"), "utf8")).toBe("after");
  await denied(a.execute("write", write(join(a.workspace, "escape")), b.context()), "workspace-write", "target=");
  expect(existsSync(join(a.workspace, "escape"))).toBe(false);
});

test.each(["read-only", "workspace-write"] as const)("registry lets %s tools enforce their own file permissions", async mode => {
  const f = fixture(), ctx = f.context(mode);
  writeFileSync(join(f.workspace, "file"), "before");
  await f.registry.execute("read", { path: "file" }, ctx);
  if (mode === "read-only") await denied(f.registry.execute("edit", edit("file"), ctx), mode, "file");
  else await f.registry.execute("edit", edit("file"), ctx);
  expect(readFileSync(join(f.workspace, "file"), "utf8")).toBe(mode === "read-only" ? "before" : "after");
});
