import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readResourceScope, approvedConstructiveResourcePath } from "./desktop-resource-scope";
import { AclSandbox } from "../packages/agent/runtime/native/windows-sandbox/acl/index";
import { managedPythonStateRoots } from "../packages/agent/runtime/src/permissions/managed-python-state";
import { managedStateWriteSid } from "../packages/agent/runtime/native/windows-sandbox/acl/workspace-sid";

test("native ACL options preserve read-only and ordinary workspace construction without loading Win32", () => {
  expect(() => new AclSandbox({ mode: "read-only", writableDirs: [] })).not.toThrow();
  expect(() => new AclSandbox({ mode: "workspace-write", writableDirs: [], writeSid: "workspace", tempDir: null })).not.toThrow();
  const root = mkdtempSync(join(tmpdir(), "lxe-acl-options-"));
  try {
    const directories = managedPythonStateRoots(root);
    for (const path of directories) mkdirSync(path, { recursive: true });
    expect(directories).toEqual([join(root, "lxeskill"), join(root, "db/lxeskill"), join(root, "logs")]);
    const options = { mode: "workspace-write" as const, writableDirs: [], writeSid: "workspace", tempDir: null,
      managedStateDirs: directories, managedStateWriteSid: managedStateWriteSid(root) };
    expect(() => new AclSandbox(options)).not.toThrow();
    expect(() => new AclSandbox({ ...options, managedStateWriteSid: "workspace" })).toThrow("must be distinct");
    const { managedStateWriteSid: _, ...withoutStateSid } = options;
    expect(() => new AclSandbox(withoutStateSid)).toThrow("both a dedicated SID");
    expect(() => new AclSandbox({ ...options, mode: "read-only" })).toThrow("does not accept write SIDs");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows helper bundles as standalone JavaScript and rejects malformed input before native APIs", async () => {
  const root = resolve(import.meta.dirname, "..");
  const out = mkdtempSync(join(tmpdir(), "lxe-sandbox-bundle-"));
  try {
    const result = await Bun.build({ entrypoints: [join(root, "packages/agent/runtime/native/windows-sandbox/runner.ts")],
      target: "node", format: "esm", external: ["koffi"], outdir: out, naming: "runner.mjs" });
    expect(result.success).toBe(true);
    const source = readFileSync(join(out, "runner.mjs"), "utf8");
    expect(source).not.toMatch(/from ["']@deepseek-ai\//u);
    const node = process.env.LXE_EXEC_SANDBOX_NODE || Bun.which("node") || process.execPath;
    const child = Bun.spawnSync([node!, join(out, "runner.mjs"), "--workspace", out, "--temp", out, "--data-root", out, "--mode", "invalid"], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(127);
    expect(child.stderr.toString()).toContain("lxe-windows-acl-run: unknown mode: invalid");
    const entry = readResourceScope(root).resources.find(item => item.id === "runtime-exec-sandbox");
    expect(entry).toMatchObject({ target: "runtime/exec-sandbox", platforms: ["win32-x64"] });
    expect(approvedConstructiveResourcePath("runtime/exec-sandbox/node_modules/@koromix/koffi-win32-x64/koffi.node")).toBe(true);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
