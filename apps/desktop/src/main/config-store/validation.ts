import { accessSync, constants, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { resolveWorkspaceContext } from "@lxe/core";
import type { DesktopPlatform } from "@lxe/desktop-protocol";
import type { DesktopConfig, DesktopSecrets } from "./model";
import { text } from "./model";
import type { DesktopConfigStoreOptions } from "./public-types";

export class DesktopConfigValidation {
  readonly platform: DesktopPlatform;
  private readonly pathExists: (path: string) => boolean;
  private readonly pathIsDirectory: (path: string) => boolean;
  private readonly pathIsExecutable: (path: string) => boolean;

  constructor(options: DesktopConfigStoreOptions = {}) {
    this.platform = options.platform ?? "win32";
    this.pathExists = options.pathExists ?? existsSync;
    this.pathIsDirectory = options.pathIsDirectory ?? ((path) => statSync(path).isDirectory());
    this.pathIsExecutable = options.pathIsExecutable ?? ((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  }

  ziniaoIssues(
    ziniao: DesktopConfig["integrations"]["ziniao"],
    secrets: DesktopSecrets,
  ): string[] {
    const issues = [
      !ziniao.company && "缺少公司名",
      !ziniao.username && "缺少账号",
      !secrets.ziniao_password && "缺少密码",
      !ziniao.app_path && "缺少紫鸟 APP 文件地址",
      !ziniao.webdriver_path && "缺少浏览器驱动安装目录",
    ].filter((value): value is string => Boolean(value));
    if (ziniao.app_path) {
      try {
        this.validateZiniaoPaths(ziniao.app_path, ziniao.webdriver_path);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    } else if (ziniao.webdriver_path
      && this.pathExists(ziniao.webdriver_path)
      && !this.pathIsDirectory(ziniao.webdriver_path)) {
      issues.push("紫鸟浏览器驱动安装地址必须是目录");
    }
    return issues;
  }

  mabangIssues(
    mabang: DesktopConfig["integrations"]["mabang"],
    secrets: DesktopSecrets,
  ): string[] {
    return [
      !mabang.account && "缺少账号",
      !secrets.mabang_password && "缺少密码",
    ].filter((value): value is string => Boolean(value));
  }

  feishuIssues(
    feishu: DesktopConfig["integrations"]["feishu"],
    secrets: DesktopSecrets,
  ): string[] {
    return [
      !feishu.app_id && "缺少 App ID",
      !secrets.feishu_app_secret && "缺少 App Secret",
    ].filter((value): value is string => Boolean(value));
  }

  validateZiniaoPaths(appPath: string, webdriverPath: string): void {
    if (!this.pathExists(appPath)) throw new Error("紫鸟 APP 文件不存在");
    if (this.platform === "win32" && extname(appPath).toLowerCase() !== ".exe") {
      throw new Error("Windows 紫鸟 APP 必须是 .exe 文件");
    }
    if (this.platform === "win32" && this.pathIsDirectory(appPath)) {
      throw new Error("Windows 紫鸟 APP 必须是 .exe 文件");
    }
    if (this.platform === "darwin") {
      const appBundle = extname(appPath).toLowerCase() === ".app";
      if ((appBundle && !this.pathIsDirectory(appPath))
        || (!appBundle && (this.pathIsDirectory(appPath) || !this.pathIsExecutable(appPath)))) {
        throw new Error("macOS 紫鸟 APP 必须是 .app 或可执行文件");
      }
    }
    if (this.pathExists(webdriverPath) && !this.pathIsDirectory(webdriverPath)) {
      throw new Error("紫鸟浏览器驱动安装地址必须是目录");
    }
  }

  validateWorkspaceRoot(value: string): string {
    const requestedWorkspace = text(value);
    if (!requestedWorkspace) throw new Error("Workspace is required");
    const workspace = resolveWorkspaceContext(requestedWorkspace);
    accessSync(workspace.directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return workspace.directory;
  }

  workspaceAvailable(value: string): boolean {
    const workspaceRoot = text(value);
    if (!workspaceRoot) return false;
    try {
      if (!this.pathExists(workspaceRoot) || !this.pathIsDirectory(workspaceRoot)) return false;
      accessSync(workspaceRoot, constants.R_OK | constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}
