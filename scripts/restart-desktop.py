#!/usr/bin/env python3
"""
一键清除 5173 端口并重新启动 Desktop 开发环境。
使用方法（在项目根目录下）：
    python scripts/restart-desktop.py
"""

import subprocess
import sys
import os
import re
import time

PORT = 5173
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_pids_on_port(port: int) -> list[int]:
    """获取占用指定端口的所有 PID（Windows）"""
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        lines = result.stdout.splitlines()
        pids = set()
        pattern = re.compile(rf"[:\[].*:{port}\s", re.IGNORECASE)
        for line in lines:
            if pattern.search(line):
                parts = line.split()
                if parts:
                    try:
                        pid = int(parts[-1])
                        if pid > 0:
                            pids.add(pid)
                    except ValueError:
                        pass
        return list(pids)
    except Exception as e:
        print(f"[!] 获取端口占用失败: {e}")
        return []


def kill_pid(pid: int) -> bool:
    """强制结束指定 PID 的进程（Windows）"""
    try:
        result = subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            capture_output=True,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        if result.returncode == 0:
            print(f"[✓] 已结束进程 PID={pid}")
            return True
        else:
            # 可能进程已不存在
            print(f"[!] 结束进程 PID={pid} 失败（可能已退出）")
            return False
    except Exception as e:
        print(f"[!] 结束进程 PID={pid} 出错: {e}")
        return False


def clear_port(port: int) -> int:
    """清除占用指定端口的所有进程，返回已杀进程数"""
    pids = get_pids_on_port(port)
    if not pids:
        print(f"[i] 端口 {port} 未被占用")
        return 0
    print(f"[i] 端口 {port} 被以下进程占用: {pids}")
    killed = 0
    for pid in pids:
        if kill_pid(pid):
            killed += 1
    return killed


def start_desktop():
    """启动 Desktop 开发环境"""
    print(f"\n[i] 正在启动 Desktop (npm run dev:desktop)...")
    print(f"[i] 项目目录: {PROJECT_ROOT}")
    print(f"[i] 端口: {PORT}")
    print("-" * 50)

    env = os.environ.copy()
    env["DESKTOP_DEV_PORT"] = str(PORT)

    # 直接前台运行，方便看日志；Ctrl+C 可退出
    try:
        subprocess.run(
            ["npm", "run", "dev:desktop"],
            cwd=PROJECT_ROOT,
            env=env,
            shell=True,  # Windows 下需要 shell=True 让 npm 可执行
        )
    except KeyboardInterrupt:
        print("\n[i] 已停止 Desktop")


def main():
    print("=" * 50)
    print("  写作 IDE - Desktop 重启脚本")
    print("=" * 50)
    print()

    # 1. 清除端口
    print(f"[1/2] 清除端口 {PORT}...")
    killed = clear_port(PORT)
    if killed > 0:
        print(f"[i] 等待 1 秒让端口释放...")
        time.sleep(1)

    # 2. 启动 Desktop
    print(f"\n[2/2] 启动 Desktop...")
    start_desktop()


if __name__ == "__main__":
    main()

