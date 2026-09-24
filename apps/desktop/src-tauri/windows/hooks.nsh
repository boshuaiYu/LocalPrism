; LocalPrism uninstall cleanup.
;
; Tauri's NSIS "Delete application data" checkbox only removes
; $APPDATA\${BUNDLEID} and $LOCALAPPDATA\${BUNDLEID}
; (com.claude-prism.desktop). This app does not store its data there.
;
; localprism_home() is:
;   1. $INSTDIR when that folder is writable (custom install such as D:\LocalPrism)
;   2. otherwise %APPDATA%\LocalPrism  (dirs::config_dir on Windows)
; Legacy auth from the ClaudePrism name lives in %APPDATA%\ClaudePrism.
;
; This hook runs only when that checkbox is checked and this is not an update.
; It never removes user papers. Default projects live in
; %USERPROFILE%\Documents\LocalPrism, and project files may also live in any
; folder the user opened. Those paths are not listed here.
; A LOCALPRISM_HOME override outside AppData and outside $INSTDIR is also kept.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; perMachine installers switch $APPDATA to ProgramData until this runs.
    SetShellVarContext current

    RMDir /r "$APPDATA\LocalPrism"
    RMDir /r "$LOCALAPPDATA\LocalPrism"
    RMDir /r "$APPDATA\ClaudePrism"
    RMDir /r "$LOCALAPPDATA\ClaudePrism"

    ; Writable install dir used as the app home. Remove only app-owned trees,
    ; then remove $INSTDIR if nothing else remains. Do not RMDir /r $INSTDIR:
    ; the user may have placed other files next to the executable.
    RMDir /r "$INSTDIR\claude-home"
    RMDir /r "$INSTDIR\providers"
    RMDir /r "$INSTDIR\uv"
    RMDir /r "$INSTDIR\skills"
    RMDir /r "$INSTDIR\.skills"
    RMDir /r "$INSTDIR\agents"
    RMDir /r "$INSTDIR\.agents"
    RMDir /r "$INSTDIR\slash"
    Delete "$INSTDIR\.localprism-writable"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
