ShowInstDetails show
ShowUninstDetails show

!macro customInit
  DetailPrint "Mat Beast Scoreboard installer initializing..."

  StrCpy $R0 ""
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  StrCmp $R0 "" 0 found_old_uninstaller
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"

found_old_uninstaller:
  StrCmp $R0 "" done_init

  DetailPrint "Previous installation detected; proceeding with installer-managed upgrade."
  Goto done_init

done_init:
  DetailPrint "Installer initialization complete."
!macroend

!macro customInstall
  DetailPrint "Starting legacy cleanup..."

  ; Always remove very old shortcut names (no longer used by any current build).
  Delete "$DESKTOP\Mat Beast Score.lnk"
  Delete "$SMPROGRAMS\Mat Beast Score.lnk"

  !if "${APP_ID}" == "com.matbeastscore.scoreboard.demo"
    ; ------------------------------------------------------------------
    ; Demo installer — must NOT delete or recreate "Mat Beast Scoreboard.lnk"
    ; (that name belongs to the production app). Only refresh *this* product's
    ; shortcut using electron-builder defines (PRODUCT_FILENAME / exe name).
    ; ------------------------------------------------------------------
    Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
    RMDir /r "$LOCALAPPDATA\Programs\matbeastscore"
    RMDir /r "$LOCALAPPDATA\Programs\Mat Beast Score"
    ; Fallback: desktop shortcut if assisted-install UI skipped it.
    CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !else
    ; ------------------------------------------------------------------
    ; Production installer — legacy migration from older folder/shortcut names.
    ; ------------------------------------------------------------------
    Delete "$DESKTOP\Mat Beast Scoreboard.lnk"
    Delete "$SMPROGRAMS\Mat Beast Scoreboard.lnk"
    RMDir /r "$LOCALAPPDATA\Programs\matbeastscore"
    RMDir /r "$LOCALAPPDATA\Programs\Mat Beast Score"
    RMDir /r "$LOCALAPPDATA\Programs\Mat Beast Scoreboard"
    CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !endif

  DetailPrint "Legacy cleanup complete."
!macroend
