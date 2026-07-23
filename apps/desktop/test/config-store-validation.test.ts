import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneConfig, cloneSecrets } from "../src/main/config-store/model";
import { DesktopConfigValidation } from "../src/main/config-store/validation";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-config-validation-"));
  roots.push(root);
  return root;
};

describe("DesktopConfigValidation", () => {
  test("preserves Windows and macOS Ziniao path rules", () => {
    const root = createRoot();
    const windows = new DesktopConfigValidation({ platform: "win32" });
    expect(() => windows.validateZiniaoPaths(join(root, "missing.exe"), join(root, "drivers")))
      .toThrow("紫鸟 APP 文件不存在");

    const wrongExtension = join(root, "ziniao.bin");
    writeFileSync(wrongExtension, "binary");
    expect(() => windows.validateZiniaoPaths(wrongExtension, join(root, "drivers")))
      .toThrow("Windows 紫鸟 APP 必须是 .exe 文件");

    const appDirectory = join(root, "ziniao.exe");
    mkdirSync(appDirectory);
    expect(() => windows.validateZiniaoPaths(appDirectory, join(root, "drivers")))
      .toThrow("Windows 紫鸟 APP 必须是 .exe 文件");

    rmSync(appDirectory, { recursive: true });
    writeFileSync(appDirectory, "binary");
    const invalidDriver = join(root, "chromedriver.exe");
    writeFileSync(invalidDriver, "binary");
    expect(() => windows.validateZiniaoPaths(appDirectory, invalidDriver))
      .toThrow("紫鸟浏览器驱动安装地址必须是目录");

    const appBundle = join(root, "Ziniao.app");
    mkdirSync(appBundle);
    const mac = new DesktopConfigValidation({ platform: "darwin" });
    expect(() => mac.validateZiniaoPaths(appBundle, join(root, "missing-drivers"))).not.toThrow();

    const executable = join(root, "ziniao-client");
    writeFileSync(executable, "binary");
    const injectedMac = new DesktopConfigValidation({
      platform: "darwin",
      pathIsExecutable: (path) => path === executable,
    });
    expect(() => injectedMac.validateZiniaoPaths(executable, join(root, "missing-drivers"))).not.toThrow();
  });

  test("reports integration issues and validates workspace availability", () => {
    const root = createRoot();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const validation = new DesktopConfigValidation({ platform: "darwin" });
    const config = cloneConfig();
    const secrets = cloneSecrets();

    expect(validation.ziniaoIssues(config.integrations.ziniao, secrets)).toEqual([
      "缺少公司名",
      "缺少账号",
      "缺少密码",
      "缺少紫鸟 APP 文件地址",
      "缺少浏览器驱动安装目录",
    ]);
    expect(validation.mabangIssues(config.integrations.mabang, secrets)).toEqual(["缺少账号", "缺少密码"]);
    expect(validation.feishuIssues(config.integrations.feishu, secrets)).toEqual(["缺少 App ID", "缺少 App Secret"]);
    expect(validation.validateWorkspaceRoot(workspace)).toBe(realpathSync.native(workspace));
    expect(validation.workspaceAvailable(workspace)).toBeTrue();
    expect(validation.workspaceAvailable(join(root, "missing"))).toBeFalse();
    expect(() => validation.validateWorkspaceRoot(join(root, "missing"))).toThrow();
    expect(() => validation.validateWorkspaceRoot("relative-workspace")).toThrow("absolute path");
  });
});
