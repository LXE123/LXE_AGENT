!ifdef BUILD_UNINSTALLER

!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var LxeDeleteDataCheckbox
Var LxeDeleteDataRequested

Function un.LxeDeleteDataPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 18u 100% 36u "同时删除 LXE Agent 本地运行数据（包括默认工作区内的全部文件，此操作不可恢复）"
  Pop $LxeDeleteDataCheckbox
  ${If} $LxeDeleteDataRequested == "1"
    ${NSD_Check} $LxeDeleteDataCheckbox
  ${Else}
    ${NSD_Uncheck} $LxeDeleteDataCheckbox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function un.LxeDeleteDataPageLeave
  ${NSD_GetState} $LxeDeleteDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "这将永久删除配置、密钥、数据库、日志、登录会话、缓存，以及默认工作区内的全部文件。此操作不可恢复，是否继续？" IDYES confirm_delete_data
    ${NSD_Uncheck} $LxeDeleteDataCheckbox
    StrCpy $LxeDeleteDataRequested "0"
    Abort
  confirm_delete_data:
    StrCpy $LxeDeleteDataRequested "1"
  ${Else}
    StrCpy $LxeDeleteDataRequested "0"
  ${EndIf}
FunctionEnd

Function un.LxeReadCleanupResult
  StrCpy $1 ""
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\lxe-wireguard-cleanup.txt" r
  ${IfNot} ${Errors}
    FileRead $0 $1
    FileClose $0
  ${EndIf}
  ${If} $1 == ""
    StrCpy $1 "WireGuard tunnel cleanup failed with exit code $2"
  ${EndIf}
FunctionEnd

Function un.LxeRemoveManagedTunnel
  Delete "$PLUGINSDIR\lxe-wireguard-cleanup.txt"
  IfFileExists "$INSTDIR\resources\wireguard\remove-lxe-tunnel.ps1" 0 missing_cleanup
  nsExec::ExecToStack `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\wireguard\remove-lxe-tunnel.ps1" -ResultPath "$PLUGINSDIR\lxe-wireguard-cleanup.txt"`
  Pop $2
  Pop $3
  ${If} $2 == "0"
    Return
  ${EndIf}
  Call un.LxeReadCleanupResult
  StrCpy $LxeDeleteDataRequested "0"
  MessageBox MB_OK|MB_ICONEXCLAMATION "未能删除 LXE Agent 的 WireGuard 隧道，本地运行数据已保留。$\n$1"
  Return

  missing_cleanup:
    StrCpy $LxeDeleteDataRequested "0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "安装目录缺少 WireGuard 清理脚本，本地运行数据已保留。$\n$INSTDIR\resources\wireguard\remove-lxe-tunnel.ps1"
FunctionEnd

Function un.LxeRemoveProgramFilesPreservingVar
  CreateDirectory "$PLUGINSDIR\old-install"
  FindFirst $R0 $R1 "$INSTDIR\*.*"

  lxe_remove_loop:
    StrCmp $R1 "" lxe_remove_complete
    StrCmp $R1 "." lxe_remove_next
    StrCmp $R1 ".." lxe_remove_next
    StrCmp $R1 "var" lxe_remove_next

    IfFileExists "$INSTDIR\$R1\*.*" lxe_remove_directory lxe_remove_file

    lxe_remove_directory:
      CreateDirectory "$PLUGINSDIR\old-install\$R1"
      Push "\$R1"
      Call un.atomicRMDir
      Pop $R2
      ${If} $R2 != 0
        Goto lxe_remove_failed
      ${EndIf}
      Goto lxe_remove_next

    lxe_remove_file:
      ClearErrors
      Rename "$INSTDIR\$R1" "$PLUGINSDIR\old-install\$R1"
      ${If} ${Errors}
        StrCpy $R2 "$INSTDIR\$R1"
        Goto lxe_remove_failed
      ${EndIf}

    lxe_remove_next:
      FindNext $R0 $R1
      Goto lxe_remove_loop

  lxe_remove_failed:
    FindClose $R0
    Push ""
    Call un.restoreFiles
    Pop $R3
    Abort "无法更新或卸载 LXE Agent，因为文件正在使用：$R2"

  lxe_remove_complete:
    FindClose $R0
    RMDir /r "$PLUGINSDIR\old-install"

    # atomicRMDir leaves the now-empty directory structure in place. Remove only
    # those program directories; var remains untouched in its original location.
    FindFirst $R0 $R1 "$INSTDIR\*.*"

  lxe_cleanup_loop:
    StrCmp $R1 "" lxe_cleanup_complete
    StrCmp $R1 "." lxe_cleanup_next
    StrCmp $R1 ".." lxe_cleanup_next
    StrCmp $R1 "var" lxe_cleanup_next
    RMDir /r "$INSTDIR\$R1"
    Delete "$INSTDIR\$R1"

  lxe_cleanup_next:
    FindNext $R0 $R1
    Goto lxe_cleanup_loop

  lxe_cleanup_complete:
    FindClose $R0
FunctionEnd

Function un.LxeDeleteInstallDirectory
  SetOutPath "$PLUGINSDIR"
  RMDir /r "$INSTDIR\var"
  IfFileExists "$INSTDIR\var\*.*" lxe_delete_data_failed 0

  # Keep the installed program and its uninstaller intact until local data has
  # been deleted successfully, so a failed deletion can be retried safely.
  Call un.LxeRemoveProgramFilesPreservingVar
  RMDir "$INSTDIR"
  IfFileExists "$INSTDIR\*.*" lxe_delete_root_failed lxe_delete_complete

  lxe_delete_data_failed:
    IfSilent lxe_delete_failed_silent lxe_delete_data_failed_interactive

  lxe_delete_data_failed_interactive:
    MessageBox MB_OK|MB_ICONSTOP "无法删除 LXE Agent 本地运行数据。请关闭正在使用以下目录中文件的程序后重试：$\n$INSTDIR\var"
    Abort

  lxe_delete_root_failed:
    IfSilent lxe_delete_failed_silent lxe_delete_root_failed_interactive

  lxe_delete_root_failed_interactive:
    MessageBox MB_OK|MB_ICONSTOP "本地运行数据已删除，但无法完全移除 LXE Agent 安装目录。请关闭正在使用安装目录中文件的程序后重试：$\n$INSTDIR"
    Abort

  lxe_delete_failed_silent:
    SetErrorLevel 5
    Abort

  lxe_delete_complete:
FunctionEnd

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.LxeDeleteDataPageCreate un.LxeDeleteDataPageLeave
!macroend

!macro customUnInit
  StrCpy $LxeDeleteDataRequested "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} "$0" "/DELETE_LXE_DATA=" $1
  ${IfNot} ${Errors}
  ${AndIf} $1 == "1"
    StrCpy $LxeDeleteDataRequested "1"
  ${EndIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${If} $LxeDeleteDataRequested == "1"
      Call un.LxeRemoveManagedTunnel
    ${EndIf}
  ${endif}
!macroend

!macro customRemoveFiles
  ${if} ${isUpdated}
    Call un.LxeRemoveProgramFilesPreservingVar
  ${else}
    ${If} $LxeDeleteDataRequested == "1"
      Call un.LxeDeleteInstallDirectory
    ${Else}
      Call un.LxeRemoveProgramFilesPreservingVar
    ${EndIf}
  ${endif}
!macroend

!endif
