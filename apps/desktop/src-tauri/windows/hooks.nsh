; LocalPrism uninstall cleanup.
;
; Tauri's checkbox normally deletes $APPDATA\${BUNDLEID} and
; $LOCALAPPDATA\${BUNDLEID} (com.claude-prism.desktop). windows/installer.nsi
; leaves those folders in place: they are the WebView2 profile shared with
; the separate ClaudePrism 1.3.0 product.
;
; This hook deletes only data this LocalPrism build writes:
;   - %APPDATA%\LocalPrism and %LOCALAPPDATA%\LocalPrism
;   - app-owned trees inside this install directory, when a writable custom
;     path such as D:\LocalPrism is the app home
;
; It does not delete %APPDATA%\ClaudePrism, %LOCALAPPDATA%\ClaudePrism,
; com.claude-prism.desktop, ClaudePrism shortcuts, or another install such as
; D:\codexprism\ClaudePrism.
;
; User papers are not listed: %USERPROFILE%\Documents\LocalPrism, any project
; folder outside app data, and LOCALPRISM_HOME when it is outside both
; AppData and $INSTDIR.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; perMachine installers point $APPDATA at ProgramData until this runs.
    SetShellVarContext current

    ; Skip when that folder is this install. A full RMDir /r would remove
    ; files next to the executable that are not in the list below.
    ${If} "$APPDATA\LocalPrism" != $INSTDIR
      RMDir /r "$APPDATA\LocalPrism"
    ${EndIf}
    ${If} "$LOCALAPPDATA\LocalPrism" != $INSTDIR
      RMDir /r "$LOCALAPPDATA\LocalPrism"
    ${EndIf}

    ; Writable install dir used as the app home. Only app-owned entries
    ; inside this LocalPrism install. Do not RMDir /r $INSTDIR.
    RMDir /r "$INSTDIR\claude-home"
    RMDir /r "$INSTDIR\providers"
    RMDir /r "$INSTDIR\uv"
    RMDir /r "$INSTDIR\skills"
    RMDir /r "$INSTDIR\.skills"
    RMDir /r "$INSTDIR\agents"
    RMDir /r "$INSTDIR\.agents"
    RMDir /r "$INSTDIR\slash"
    Delete "$INSTDIR\skills-manifest.json"
    Delete "$INSTDIR\.localprism-writable"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
