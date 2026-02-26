; 自定义 NSIS 安装脚本 —— 修复 "应用还在运行" 误报
; electron-builder 会自动加载 build/installer.nsh

!macro customCheckAppRunning
  ; 1) 强制杀掉同名进程（忽略错误，进程不存在也无妨）
  nsExec::ExecToLog 'cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t 2>nul'
  Sleep 500

  ; 2) 清理 Electron SingleInstanceLock（异常退出时残留导致误判）
  Delete "$LOCALAPPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Delete "$APPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"

  ; 3) 再等一下确保文件句柄释放
  Sleep 300
!macroend

!macro customUnCheckAppRunning
  nsExec::ExecToLog 'cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t 2>nul'
  Sleep 500
  Delete "$LOCALAPPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Delete "$APPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Sleep 300
!macroend
