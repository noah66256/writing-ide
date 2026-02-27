; 自定义 NSIS 安装脚本 —— 修复 "写作IDE无法关闭" 误报
; electron-builder 会自动加载 build/installer.nsh
;
; 问题：默认 _CHECK_APP_RUNNING 用 tasklist|find.exe 管道检测进程，
;       CJK 进程名在 cmd.exe 管道中编码不兼容导致误报。
;       升级时运行旧卸载程序（内置同样 buggy 检查）也会误报。
;
; 策略：完全跳过进程检测（只清理锁文件），用 DeleteRegKey 阻止旧卸载程序运行。
;       不调用任何 NSIS 插件函数（nsExec/nsProcess），确保 macOS 交叉编译兼容。

; ── 安装器 .onInit ──
; 注意：此宏仅在安装器中展开，不编译进卸载器
!macro customInit
  Delete "$LOCALAPPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Delete "$APPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"

  ; 删除旧版卸载注册表键 → uninstallOldVersion 读不到旧卸载路径 → 跳过旧卸载程序
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
  !endif

  Sleep 500
!macroend

; ── 替换进程检测（安装器 + 卸载器共用） ──
; 完全跳过进程检测，只清理锁文件。不调用任何插件。
!macro customCheckAppRunning
  Delete "$LOCALAPPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Delete "$APPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
!macroend

; ── 卸载器 un.onInit ──
!macro customUnInit
  Delete "$LOCALAPPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Delete "$APPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Sleep 300
!macroend
