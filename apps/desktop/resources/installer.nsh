!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var LxeDeleteDataCheckbox
Var LxeDeleteDataRequested
Var LxePreservedVarPath
Var LxeAtomicRemoval

Function un.LxeDeleteDataPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 18u 100% 28u "同时删除 LXE Agent 本地运行数据（配置、密钥、数据库、日志、登录会话和缓存）"
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

Function un.LxeRestorePreservedVar
  CreateDirectory "$INSTDIR"
  ClearErrors
  Rename "$LxePreservedVarPath" "$INSTDIR\var"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "无法恢复 LXE Agent 本地运行数据。数据仍保存在：$\n$LxePreservedVarPath"
    Abort
  ${EndIf}
FunctionEnd

Function un.LxeRemoveFilesPreservingVar
  StrCpy $LxePreservedVarPath "$INSTDIR.__lxe_var_preserved"
  IfFileExists "$LxePreservedVarPath\*.*" 0 no_previous_backup
    IfFileExists "$INSTDIR\var\*.*" conflicting_backup restore_previous_backup
  restore_previous_backup:
    Call un.LxeRestorePreservedVar
    Goto no_previous_backup
  conflicting_backup:
    MessageBox MB_OK|MB_ICONSTOP "检测到两份 LXE Agent 本地运行数据，已停止卸载以避免覆盖：$\n$INSTDIR\var$\n$LxePreservedVarPath"
    Abort

  no_previous_backup:
  IfFileExists "$INSTDIR\var\*.*" preserve_var remove_without_var
  preserve_var:
    ClearErrors
    Rename "$INSTDIR\var" "$LxePreservedVarPath"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "无法暂存 LXE Agent 本地运行数据，已停止卸载：$\n$INSTDIR\var"
      Abort
    ${EndIf}

    ${If} $LxeAtomicRemoval == "1"
      CreateDirectory "$PLUGINSDIR\old-install"
      Push ""
      Call un.atomicRMDir
      Pop $0
      ${If} $0 != 0
        Push ""
        Call un.restoreFiles
        Pop $1
        Call un.LxeRestorePreservedVar
        Abort "Can't update LXE Agent because this file is busy: $0"
      ${EndIf}
    ${Else}
      RMDir /r "$INSTDIR"
    ${EndIf}
    RMDir /r "$INSTDIR"
    Call un.LxeRestorePreservedVar
    Return

  remove_without_var:
    ${If} $LxeAtomicRemoval == "1"
      CreateDirectory "$PLUGINSDIR\old-install"
      Push ""
      Call un.atomicRMDir
      Pop $0
      ${If} $0 != 0
        Push ""
        Call un.restoreFiles
        Pop $1
        Abort "Can't update LXE Agent because this file is busy: $0"
      ${EndIf}
      RMDir /r "$INSTDIR"
    ${Else}
      RMDir /r "$INSTDIR"
    ${EndIf}
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
    StrCpy $LxeAtomicRemoval "1"
    Call un.LxeRemoveFilesPreservingVar
  ${else}
    ${If} $LxeDeleteDataRequested == "1"
      RMDir /r "$INSTDIR"
    ${Else}
      StrCpy $LxeAtomicRemoval "0"
      Call un.LxeRemoveFilesPreservingVar
    ${EndIf}
  ${endif}
!macroend
