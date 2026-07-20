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

  test("preserves var in place during updates and default uninstall", () => {
    expect(installer).toContain('${if} ${isUpdated}');
    expect(installer).toContain("Call un.LxeRemoveProgramFilesPreservingVar");
    expect(installer).toContain('StrCmp $R1 "var" lxe_remove_next');
    expect(installer).toContain('StrCmp $R1 "var" lxe_cleanup_next');
    expect(installer).toContain("Call un.atomicRMDir");
    expect(installer).toContain("Call un.restoreFiles");
    expect(installer).not.toContain("LxePreservedVarPath");
    expect(installer).not.toContain(".__lxe_var_preserved");
    expect(installer).not.toContain('Rename "$INSTDIR\\var"');
    expect(installer).not.toContain("${UNINSTALL_FILENAME}");
  });

  test("deletes var only after an explicit request and reports locked data", () => {
    expect(installer).toContain("Function un.LxeDeleteInstallDirectory");
    expect(installer).toContain('Call un.LxeDeleteInstallDirectory');
    expect(installer).toContain('SetOutPath "$PLUGINSDIR"');
    expect(installer).toContain('RMDir /r "$INSTDIR\\var"');
    expect(installer).toContain('IfFileExists "$INSTDIR\\var\\*.*" lxe_delete_data_failed 0');
    expect(installer).toContain('IfFileExists "$INSTDIR\\*.*" lxe_delete_root_failed lxe_delete_complete');
    expect(installer).toContain("IfSilent lxe_delete_failed_silent lxe_delete_data_failed_interactive");
    expect(installer).toContain("IfSilent lxe_delete_failed_silent lxe_delete_root_failed_interactive");
    expect(installer).toContain("SetErrorLevel 5");
    expect(installer).toContain("请关闭正在使用以下目录中文件的程序后重试");
    expect(installer.indexOf('RMDir /r "$INSTDIR\\var"')).toBeLessThan(
      installer.indexOf("Call un.LxeRemoveProgramFilesPreservingVar", installer.indexOf("Function un.LxeDeleteInstallDirectory")),
    );
  });

  test("retains var when managed tunnel cleanup cannot complete", () => {
    expect(installer).toContain("Call un.LxeRemoveManagedTunnel");
    expect(installer).toContain('StrCpy $LxeDeleteDataRequested "0"');
    expect(installer).toContain("本地运行数据已保留");
  });
});
