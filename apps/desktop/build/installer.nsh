; 自定义 NSIS 安装脚本
; electron-builder 会自动加载 build/installer.nsh
;
; v0.2: productName 从 "写作IDE" 改为 "WritingIDE"（ASCII），避免 Windows 下
;       CJK 安装路径导致 Chromium icudtl.dat 加载失败。
;       同时清理旧版 "写作IDE" 遗留的锁文件和注册表键。
;
; 策略：完全跳过进程检测（只清理锁文件），用 DeleteRegKey 阻止旧卸载程序运行。
;       不调用任何 NSIS 插件函数（nsExec/nsProcess），确保跨平台编译兼容。

; 旧版 productName（v0.0.1 及之前）
!define LEGACY_CJK_NAME "写作IDE"

; ── 安装器 .onInit ──
; 注意：此宏仅在安装器中展开，不编译进卸载器
!macro customInit
  ; 清理当前版本锁文件
  Delete "$LOCALAPPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Delete "$APPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  ; 清理旧版 CJK 名称锁文件
  Delete "$LOCALAPPDATA\${LEGACY_CJK_NAME}\SingleInstanceLock"
  Delete "$APPDATA\${LEGACY_CJK_NAME}\SingleInstanceLock"

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
  Delete "$LOCALAPPDATA\${LEGACY_CJK_NAME}\SingleInstanceLock"
  Delete "$APPDATA\${LEGACY_CJK_NAME}\SingleInstanceLock"
!macroend

; ── 卸载器 un.onInit ──
!macro customUnInit
  Delete "$LOCALAPPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Delete "$APPDATA\${PRODUCT_FILENAME}\SingleInstanceLock"
  Delete "$LOCALAPPDATA\${LEGACY_CJK_NAME}\SingleInstanceLock"
  Delete "$APPDATA\${LEGACY_CJK_NAME}\SingleInstanceLock"
  Sleep 300
!macroend
