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
  ; Remove common legacy desktop/start-menu shortcuts from prior variants.
  Delete "$DESKTOP\Mat Beast Score.lnk"
  Delete "$DESKTOP\Mat Beast Scoreboard.lnk"
  Delete "$SMPROGRAMS\Mat Beast Scoreboard.lnk"
  Delete "$SMPROGRAMS\Mat Beast Score.lnk"

  ; Remove old per-user install roots that were used in earlier builds.
  RMDir /r "$LOCALAPPDATA\Programs\matbeastscore"
  RMDir /r "$LOCALAPPDATA\Programs\Mat Beast Score"
  RMDir /r "$LOCALAPPDATA\Programs\Mat Beast Scoreboard"

  ; Fallback: explicitly create the desktop shortcut in case task UI is skipped.
  CreateShortCut "$DESKTOP\Mat Beast Scoreboard.lnk" "$INSTDIR\Mat Beast Scoreboard.exe"
  DetailPrint "Legacy cleanup complete."
!macroend
