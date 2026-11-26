!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
  Var AjinosPreviousDir
  Var AjinosDataHome
  Var AjinosKeepOption
  Var AjinosResetOption
  Var AjinosResetData

  !macro customInit
    ReadRegStr $AjinosPreviousDir HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadEnvStr $AjinosDataHome "USERPROFILE"
    ${If} $AjinosDataHome != ""
      StrCpy $AjinosDataHome "$AjinosDataHome\.agent-autoloop-studio"
    ${EndIf}
    StrCpy $AjinosResetData ${BST_UNCHECKED}
  !macroend

  !macro customWelcomePage
    Page custom AjinosReinstallPage AjinosReinstallLeave
  !macroend

  !macro customPageAfterChangeDir
    !insertmacro skipPageIfUpdated
    !define MUI_DIRECTORYPAGE_TEXT_TOP "请选择安装 AJinOS 的空目录，或沿用原安装目录。"
    !insertmacro MUI_PAGE_DIRECTORY
  !macroend

  !macro customHeader
    Function AjinosReinstallPage
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      ${If} $AjinosPreviousDir == ""
        ${If} $AjinosDataHome == ""
        ${OrIfNot} ${FileExists} "$AjinosDataHome\."
          Abort
        ${EndIf}
      ${EndIf}

      !insertmacro MUI_HEADER_TEXT "重新安装 AJinOS" "选择如何处理原有数据。"
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == "error"
        Abort
      ${EndIf}
      ${If} $AjinosPreviousDir != ""
        ${NSD_CreateLabel} 0 0 100% 30u "检测到已有安装：$\r$\n$AjinosPreviousDir"
      ${Else}
        ${NSD_CreateLabel} 0 0 100% 30u "检测到此 Windows 用户有 AJinOS 的旧数据。"
      ${EndIf}
      Pop $0
      ${NSD_CreateRadioButton} 0 32u 100% 15u "保留原有数据（推荐）"
      Pop $AjinosKeepOption
      ${NSD_CreateRadioButton} 0 52u 100% 15u "备份原有数据并全新安装"
      Pop $AjinosResetOption
      ${NSD_CreateLabel} 12u 72u 95% 32u "全新安装会将默认数据目录移到同级备份目录，下一次启动时重新初始化。"
      Pop $0
      ${If} $AjinosResetData == ${BST_CHECKED}
        ${NSD_Check} $AjinosResetOption
      ${Else}
        ${NSD_Check} $AjinosKeepOption
      ${EndIf}
      nsDialogs::Show
    FunctionEnd

    Function AjinosReinstallLeave
      ${NSD_GetState} $AjinosResetOption $AjinosResetData
      ${If} $AjinosResetData == ${BST_CHECKED}
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "确认备份并重置 AJinOS 默认数据目录？$\r$\n$AjinosDataHome" IDYES +2
        Abort
      ${EndIf}
    FunctionEnd

    Function .onVerifyInstDir
      ${If} $INSTDIR == $AjinosPreviousDir
        Return
      ${EndIf}

      # NSIS removes the entire application directory during uninstall.
      FindFirst $0 $1 "$INSTDIR\*"
      ${DoWhile} $1 != ""
        ${If} $1 != "."
        ${AndIf} $1 != ".."
          FindClose $0
          Abort
        ${EndIf}
        FindNext $0 $1
      ${Loop}
      FindClose $0
    FunctionEnd
  !macroend

  !macro customInstall
    ${If} $AjinosResetData == ${BST_CHECKED}
    ${AndIf} $AjinosDataHome != ""
    ${AndIf} ${FileExists} "$AjinosDataHome\."
      ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
      StrCpy $7 "$AjinosDataHome.backup-$2$1$0-$4$5$6"
      ClearErrors
      Rename "$AjinosDataHome" "$7"
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONEXCLAMATION "程序已安装。原有数据无法移到备份目录，仍保留在原处。"
      ${Else}
        DetailPrint "旧数据已备份到 $7"
      ${EndIf}
    ${EndIf}
  !macroend
!endif
