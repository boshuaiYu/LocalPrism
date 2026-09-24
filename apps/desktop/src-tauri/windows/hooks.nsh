; LocalPrism uninstall cleanup.
;
; Tauri's "Delete application data" checkbox only removes
; $APPDATA\${BUNDLEID} and $LOCALAPPDATA\${BUNDLEID}. This binary's data is
; elsewhere:
;   - $INSTDIR when that folder is writable (custom installs such as D:\LocalPrism)
;   - otherwise %APPDATA%\LocalPrism
; The same binary also wrote %APPDATA%\ClaudePrism (legacy auth) and
; $INSTDIR\ClaudePrism (legacy skills manifest). WebView2 uses ${BUNDLEID}
; (com.claude-prism.desktop), usually under %LOCALAPPDATA%.
;
; A separate registered product also named ClaudePrism (its own uninstall.exe,
; for example D:\codexprism\ClaudePrism) is not this install. Do not remove
; that directory or a Start Menu shortcut that points at it.
;
; Checked paths are removed only when the checkbox is set and this is not an
; update. User papers are not listed: %USERPROFILE%\Documents\LocalPrism,
; any project folder outside app data, and LOCALPRISM_HOME when it is outside
; both AppData and $INSTDIR.

!macro NSIS_HOOK_POSTUNINSTALL
  ; Drop a same-install shortcut that still uses the old file name.
  ; Leave ClaudePrism.lnk alone when it belongs to the other install.
  ${If} $UpdateMode <> 1
    !insertmacro IsShortcutTarget "$SMPROGRAMS\ClaudePrism.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$SMPROGRAMS\ClaudePrism.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\ClaudePrism.lnk" "$INSTDIR\ClaudePrism.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$SMPROGRAMS\ClaudePrism.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\ClaudePrism.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$DESKTOP\ClaudePrism.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\ClaudePrism.lnk" "$INSTDIR\ClaudePrism.exe"
    Pop $0
    ${If} $0 = 1
      Delete "$DESKTOP\ClaudePrism.lnk"
    ${EndIf}
  ${EndIf}

  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; perMachine installers point $APPDATA at ProgramData until this runs.
    SetShellVarContext current

    RMDir /r "$APPDATA\${BUNDLEID}"
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
    RMDir /r "$APPDATA\LocalPrism"
    RMDir /r "$LOCALAPPDATA\LocalPrism"
    RMDir /r "$APPDATA\ClaudePrism"
    RMDir /r "$LOCALAPPDATA\ClaudePrism"

    ; Writable install dir used as the app home. Only app-owned entries.
    ; $INSTDIR\ClaudePrism is the legacy manifest folder inside this install,
    ; not another product's install directory.
    RMDir /r "$INSTDIR\claude-home"
    RMDir /r "$INSTDIR\providers"
    RMDir /r "$INSTDIR\uv"
    RMDir /r "$INSTDIR\skills"
    RMDir /r "$INSTDIR\.skills"
    RMDir /r "$INSTDIR\agents"
    RMDir /r "$INSTDIR\.agents"
    RMDir /r "$INSTDIR\slash"
    RMDir /r "$INSTDIR\ClaudePrism"
    Delete "$INSTDIR\skills-manifest.json"
    Delete "$INSTDIR\.localprism-writable"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
