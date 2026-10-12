!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "BestDict"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "BestDic"
!macroend
