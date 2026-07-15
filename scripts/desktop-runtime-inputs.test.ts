import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  desktopRuntimeLockSha256,
  resolveDesktopRuntimeInputs,
} from "./desktop-runtime-inputs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-desktop-runtime-inputs-"));
  temporaryRoots.push(root);
  return root;
};

const createRuntimeInputs = (root: string) => {
  const nodeRoot = join(root, "node");
  const pythonRoot = join(root, "python");
  const playwrightRoot = join(root, "playwright");
  const uvExecutable = join(root, "uv.exe");
  const ripgrepExecutable = join(root, "rg.exe");
  for (const directory of [nodeRoot, pythonRoot, playwrightRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(uvExecutable, "uv", "utf8");
  writeFileSync(ripgrepExecutable, "rg", "utf8");
  return { nodeRoot, pythonRoot, playwrightRoot, uvExecutable, ripgrepExecutable };
};

const writeDescriptor = (
  path: string,
  inputs: ReturnType<typeof createRuntimeInputs>,
  lockSha256 = "locked",
): void => {
  writeFileSync(path, JSON.stringify({
    schema_version: 1,
    platform: "win32-x64",
    lock_sha256: lockSha256,
    inputs: {
      node_root: inputs.nodeRoot,
      python_root: inputs.pythonRoot,
      uv_path: inputs.uvExecutable,
      rg_path: inputs.ripgrepExecutable,
      playwright_root: inputs.playwrightRoot,
    },
  }), "utf8");
};

describe("desktop runtime input resolution", () => {
  test("computes a stable fingerprint from the tracked runtime locks", () => {
    const repositoryRoot = join(import.meta.dir, "..");
    expect(desktopRuntimeLockSha256(repositoryRoot)).toMatch(/^[a-f0-9]{64}$/u);
    expect(desktopRuntimeLockSha256(repositoryRoot)).toBe(
      desktopRuntimeLockSha256(repositoryRoot),
    );
  });

  test("uses complete environment overrides without requiring a descriptor", () => {
    const root = temporaryRoot();
    const inputs = createRuntimeInputs(root);
    const resolved = resolveDesktopRuntimeInputs({
      repositoryRoot: root,
      expectedLockSha256: "locked",
      environment: {
        LXE_DESKTOP_NODE_ROOT: inputs.nodeRoot,
        LXE_DESKTOP_PYTHON_ROOT: inputs.pythonRoot,
        LXE_DESKTOP_UV_PATH: inputs.uvExecutable,
        LXE_DESKTOP_RG_PATH: inputs.ripgrepExecutable,
        LXE_DESKTOP_PLAYWRIGHT_ROOT: inputs.playwrightRoot,
      },
    });

    expect(resolved).toEqual(inputs);
  });

  test("uses environment values as per-field overrides over the descriptor", () => {
    const root = temporaryRoot();
    const descriptorInputs = createRuntimeInputs(join(root, "descriptor"));
    const overrideInputs = createRuntimeInputs(join(root, "override"));
    const descriptorPath = join(root, "runtime-inputs.json");
    writeDescriptor(descriptorPath, descriptorInputs);

    const resolved = resolveDesktopRuntimeInputs({
      repositoryRoot: root,
      expectedLockSha256: "locked",
      environment: {
        LXE_DESKTOP_RUNTIME_DESCRIPTOR: descriptorPath,
        LXE_DESKTOP_NODE_ROOT: overrideInputs.nodeRoot,
        LXE_DESKTOP_UV_PATH: overrideInputs.uvExecutable,
      },
    });

    expect(resolved).toEqual({
      ...descriptorInputs,
      nodeRoot: overrideInputs.nodeRoot,
      uvExecutable: overrideInputs.uvExecutable,
    });
  });

  test("rejects a stale descriptor before accepting its paths", () => {
    const root = temporaryRoot();
    const inputs = createRuntimeInputs(root);
    const descriptorPath = join(root, "runtime-inputs.json");
    writeDescriptor(descriptorPath, inputs, "stale");

    expect(() => resolveDesktopRuntimeInputs({
      repositoryRoot: root,
      expectedLockSha256: "locked",
      environment: { LXE_DESKTOP_RUNTIME_DESCRIPTOR: descriptorPath },
    })).toThrow("stale lock fingerprint");
  });

  test("rejects missing environment override paths", () => {
    const root = temporaryRoot();
    const inputs = createRuntimeInputs(root);
    const descriptorPath = join(root, "runtime-inputs.json");
    writeDescriptor(descriptorPath, inputs);

    expect(() => resolveDesktopRuntimeInputs({
      repositoryRoot: root,
      expectedLockSha256: "locked",
      environment: {
        LXE_DESKTOP_RUNTIME_DESCRIPTOR: descriptorPath,
        LXE_DESKTOP_NODE_ROOT: join(root, "missing-node"),
      },
    })).toThrow("LXE_DESKTOP_NODE_ROOT");
  });
});
