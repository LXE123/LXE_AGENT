import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { canonicalPathCandidate, pathContains } from "@lxe/core";
import { PermissionPolicyService } from "../../src/permissions/policy";
import { ExecutionPaths } from "../../src/permissions/execution-paths";
import { executionBoundary, recheckExecutionBoundary } from "../../src/permissions/boundaries";
import { workspaceFor } from "../workspace";
const roots: string[] = [];
const fixture = () => {
  // The native resolver expands Windows 8.3 aliases, as the path policy does.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "lxe-permission-"))); roots.push(root);
  const dataRoot = join(root, "var"), directory = join(dataRoot, "workspace");
  const service = new PermissionPolicyService();
  const session = { session_id: "../session", workspace: workspaceFor(directory, root), permission_mode: "workspace-write" as const };
  return { root, dataRoot, directory, service, session };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("policy resolution is immutable, filesystem-free and independent of artifact or private paths", () => {
  const { dataRoot, directory, service, session } = fixture();
  for (const permission_mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
    const policy = service.resolve({ ...session, permission_mode });
    expect(policy).toEqual({ mode: permission_mode, workspaceRoot: directory, sessionId: session.session_id });
    expect(Object.isFrozen(policy)).toBe(true);
  }
  expect(existsSync(dataRoot)).toBe(false);
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, ".lxeagent"), "not a directory");
  expect(() => service.resolve(session)).not.toThrow();
  expect(() => service.resolve({ ...session, permission_mode: "bogus" as never })).toThrow("Invalid permission mode");
});
test("paths are pure; selected subdirectory owns artifacts, Windows temp is isolated and new after restart", () => {
  const { root, dataRoot, service, session } = fixture();
  const paths = new ExecutionPaths(dataRoot, { platform: "win32", temporaryRoot: join(root, "temp") });
  const first = service.resolve(session), second = service.resolve({ ...session, session_id: "second" });
  expect(paths.artifactRoot(first)).toBe(paths.artifactRoot(second));
  expect(paths.temporaryDirectory(first)).not.toBe(paths.temporaryDirectory(second));
  expect(paths.temporaryDirectory(first)).toBe(paths.temporaryDirectory(service.resolve(session)));
  expect(new ExecutionPaths(dataRoot, { platform: "win32" }).temporaryDirectory(first)).not.toBe(paths.temporaryDirectory(first));
  expect(pathContains(join(dataRoot, "tmp", "exec"), paths.outputDirectory(first))).toBe(true);
  expect(existsSync(dataRoot)).toBe(false);
  const repo = service.resolve({ ...session, workspace: workspaceFor(root) });
  const mac = new ExecutionPaths(dataRoot, { platform: "darwin" });
  expect(() => executionBoundary(repo, mac)).not.toThrow();
  expect(executionBoundary(first, mac).roots).toContain(canonicalPathCandidate("/tmp"));
  expect(executionBoundary({ ...first, mode: "read-only" }, mac).roots).toEqual([]);
});
test("operation checks detect changed workspace links; real target errors and traversal remain truthful", () => {
  const { root, dataRoot, directory, service, session } = fixture();
  mkdirSync(directory, { recursive: true });
  const outside = join(root, "outside"); mkdirSync(outside);
  const link = join(directory, "link"); symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  expect(canonicalPathCandidate(`${link}${sep}..${sep}missing`)).toBe(join(root, "missing"));
  const p = service.resolve({ ...session, workspace: workspaceFor(link) });
  const paths = new ExecutionPaths(dataRoot), initial = executionBoundary(p, paths);
  rmSync(link, { recursive: true }); symlinkSync(dataRoot, link, process.platform === "win32" ? "junction" : "dir");
  expect(() => recheckExecutionBoundary(p, paths, initial)).toThrow("changed");
  writeFileSync(join(root, "file"), "x");
  expect(() => canonicalPathCandidate(join(root, "file", "child"))).toThrow();
});
test("path comparisons respect components, traversal, separators, Windows drives and casing", () => {
  expect(pathContains("/work/project", "/work/project-child", "linux")).toBe(false);
  expect(pathContains("/work/project/", "/work/project/a/../b", "linux")).toBe(true);
  expect(pathContains("/work/project", "/work/project/../secret", "linux")).toBe(false);
  expect(pathContains("C:\\Work\\Project", "c:/work/project/a", "win32")).toBe(true);
  expect(pathContains("C:\\Work\\Project", "C:\\Work\\Project-other", "win32")).toBe(false);
  expect(pathContains("C:\\Work", "D:\\Work", "win32")).toBe(false);
  expect(pathContains("\\\\server\\share\\work", "\\\\SERVER\\share\\work\\file", "win32")).toBe(true);
  expect(pathContains("/Work", "/work/file", "linux")).toBe(false);
});
