import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopLocalAuthStore } from "../src/main/config-store/auth-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-local-auth-"));
  roots.push(root);
  return root;
};

describe("DesktopLocalAuthStore", () => {
  test("stores provider keys as mergeable plaintext JSON with POSIX-only user permissions", () => {
    const root = createRoot();
    const store = new DesktopLocalAuthStore(root, "darwin");

    store.save("deepseek", " deepseek-secret ");
    store.save("glm", "glm-secret");

    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({
      deepseek: { type: "api_key", key: "deepseek-secret" },
      glm: { type: "api_key", key: "glm-secret" },
    });
    expect(store.snapshot()).toEqual({
      configured: { kimi_coding: false, deepseek: true, glm: true },
      keys: { deepseek: "deepseek-secret", glm: "glm-secret" },
      error: "",
    });
    expect(statSync(join(root, "config")).mode & 0o777).toBe(0o700);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, "config", "auth.lock"))).toBeFalse();

    store.delete("deepseek");
    expect(store.snapshot().configured).toEqual({ kimi_coding: false, deepseek: false, glm: true });

    chmodSync(join(root, "config"), 0o755);
    chmodSync(store.path, 0o644);
    store.snapshot();
    expect(statSync(join(root, "config")).mode & 0o777).toBe(0o700);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  test("reports malformed files and refuses to overwrite them", () => {
    const root = createRoot();
    const configRoot = join(root, "config");
    mkdirSync(configRoot);
    const authPath = join(configRoot, "auth.json");
    writeFileSync(authPath, "{ invalid JSON", "utf8");
    const store = new DesktopLocalAuthStore(root, "darwin");

    expect(store.snapshot()).toMatchObject({
      configured: { kimi_coding: false, deepseek: false, glm: false },
      error: expect.stringContaining("无法读取本地模型凭证"),
    });
    expect(() => store.save("deepseek", "new-secret")).toThrow();
    expect(readFileSync(authPath, "utf8")).toBe("{ invalid JSON");
  });

  test("refuses a concurrent writer without changing the credential file", () => {
    const root = createRoot();
    const store = new DesktopLocalAuthStore(root, "linux");
    store.save("deepseek", "first-secret");
    const before = readFileSync(store.path, "utf8");
    const lockPath = join(root, "config", "auth.lock");
    writeFileSync(lockPath, "active", { mode: 0o600 });
    chmodSync(lockPath, 0o600);

    expect(() => store.save("deepseek", "second-secret"))
      .toThrow("auth.json is being updated by another process");
    expect(readFileSync(store.path, "utf8")).toBe(before);
  });
});
