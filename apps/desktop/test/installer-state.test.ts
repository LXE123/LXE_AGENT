import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const installer = readFileSync(resolve(import.meta.dirname, "../resources/installer.nsh"), "utf8");

describe("Windows installer runtime state", () => {
  test("defines uninstall code only while electron-builder compiles the uninstaller", () => {
    expect(installer.trimStart()).toStartWith("!ifdef BUILD_UNINSTALLER");
    expect(installer.trimEnd()).toEndWith("!endif");
  });

  test("keeps local data by default and exposes an explicit deletion choice", () => {
    expect(installer).toContain("同时删除 LXE Agent 本地运行数据");
    expect(installer).toContain("默认工作区内的全部文件");
    expect(installer).toContain("此操作不可恢复");
    expect(installer).toContain("MB_DEFBUTTON2");
    expect(installer).toContain("IDYES confirm_delete_data");
    expect(installer).toContain('StrCpy $LxeDeleteDataRequested "0"');
    expect(installer).toContain('"/DELETE_LXE_DATA="');
    expect(installer).toContain('${If} $LxeDeleteDataRequested == "1"');
  });

  test("always preserves var during updates and recovers interrupted preservation", () => {
    expect(installer).toContain('${if} ${isUpdated}');
    expect(installer).toContain('StrCpy $LxeAtomicRemoval "1"');
    expect(installer).toContain('$INSTDIR.__lxe_var_preserved');
    expect(installer).toContain("Call un.atomicRMDir");
    expect(installer).toContain("Call un.restoreFiles");
    expect(installer).toContain("Call un.LxeRestorePreservedVar");
    expect(installer).toContain('Rename "$INSTDIR\\var" "$LxePreservedVarPath"');
  });

  test("retains var when managed tunnel cleanup cannot complete", () => {
    expect(installer).toContain("Call un.LxeRemoveManagedTunnel");
    expect(installer).toContain('StrCpy $LxeDeleteDataRequested "0"');
    expect(installer).toContain("本地运行数据已保留");
  });
});
