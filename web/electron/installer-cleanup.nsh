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

  MessageBox MB_ICONQUESTION|MB_YESNO "A previous Mat Beast Scoreboard installation was detected.$\r$\n$\r$\nOpen the uninstaller now?$\r$\n$\r$\nThis setup will close. After uninstall finishes, run this installer again." IDYES do_uninstall IDNO done_init

do_uninstall:
  DetailPrint "Launching previous uninstaller; this setup will exit (re-run this installer after uninstall)."
  ; Full uninstall command line from registry (interactive — do not add /S).
  ; ExecWait can return while files are still locked; continuing the install in parallel causes conflicts.
  Exec '$R0'
  IfErrors uninstall_launch_failed
  Quit
uninstall_launch_failed:
  MessageBox MB_ICONEXCLAMATION|MB_OK "Could not start the uninstaller. Remove the old version from Windows Settings → Apps, then run this setup again, or choose a different install folder."
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
