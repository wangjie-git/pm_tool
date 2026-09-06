; 深链接 pm-todo:// 注册（tauri-plugin-deep-link Windows NSIS 安装钩子）
; 安装时把协议写进注册表，卸载时清除；MAINBINARYNAME 由 Tauri NSIS 模板注入。
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\pm-todo" "" "URL:pm-todo"
  WriteRegStr SHCTX "Software\Classes\pm-todo" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\pm-todo\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "Software\Classes\pm-todo\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\pm-todo"
!macroend
