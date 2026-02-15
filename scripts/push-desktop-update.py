#!/usr/bin/env python3
"""
一键推送 Desktop Windows 安装包（NSIS）到更新源目录，并生成/上传 latest.json。

约定（v0.1）：
- 更新源由 Gateway 暴露：
  - GET /downloads/desktop/stable/latest.json
  - GET /downloads/desktop/stable/:file
- 服务器目录：${DESKTOP_UPDATES_DIR}/stable/

本脚本做什么：
1) 计算 installer.exe 的 sha256（可选写入 latest.json）
2) 生成 latest.json（windows.nsisUrl 指向 Gateway）
3) ssh 创建远端目录
4) scp 上传 exe 与 latest.json

使用示例（在项目根目录下）：
    python scripts/push-desktop-update.py \
      --ssh root@120.26.6.147 \
      --remote-dir /opt/writing-ide/desktop-updates/stable \
      --gateway-base http://120.26.6.147:8000 \
      --installer "apps/desktop/out/写作IDE Setup 0.0.4.exe" \
      --version 0.0.4 \
      --notes "修复自动更新；优化体验"

说明：
- 依赖本机已安装并可用的 ssh/scp（Git Bash 通常自带）。
- 远端路径建议不要包含空格。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote


def _safe_reconfigure_stdio():
    # Windows 下某些终端（尤其是 Git Bash）stdout 可能是 gbk，输出中文/特殊符号会异常。
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(1024 * 1024)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    # Windows 下避免弹窗
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    p = subprocess.run(cmd, text=True, capture_output=True, creationflags=creationflags)
    if check and p.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nstdout:\n{p.stdout}\nstderr:\n{p.stderr}")
    return p


def main() -> int:
    _safe_reconfigure_stdio()

    ap = argparse.ArgumentParser()
    ap.add_argument("--ssh", required=True, help="SSH 目标，例如 root@120.26.6.147")
    ap.add_argument("--ssh-port", default="", help="SSH 端口（可选）")
    ap.add_argument("--ssh-key", default="", help="SSH 私钥路径（可选）")
    ap.add_argument("--remote-dir", required=True, help="远端 stable 目录，例如 /opt/writing-ide/desktop-updates/stable")
    ap.add_argument("--gateway-base", required=True, help="Gateway base，例如 http://120.26.6.147:8000")
    ap.add_argument("--installer", required=True, help="本地 NSIS 安装包 exe 路径")
    ap.add_argument("--version", required=True, help="版本号，例如 0.0.4")
    ap.add_argument("--notes", default="", help="更新说明（可选）")
    ap.add_argument("--no-sha256", action="store_true", help="不计算/写入 sha256")
    ap.add_argument("--dry-run", action="store_true", help="只打印将执行的操作，不实际上传")

    args = ap.parse_args()

    installer = os.path.abspath(args.installer)
    if not os.path.exists(installer):
        print(f"[!] installer 不存在: {installer}")
        return 2

    file_name = os.path.basename(installer)
    gateway_base = str(args.gateway_base).rstrip("/")
    nsis_url = f"{gateway_base}/downloads/desktop/stable/{quote(file_name)}"

    print("=" * 60)
    print("写作 IDE - Desktop 更新推送脚本（v0.1）")
    print("=" * 60)
    print(f"[i] ssh: {args.ssh}")
    print(f"[i] remoteDir: {args.remote_dir}")
    print(f"[i] installer: {installer}")
    print(f"[i] version: {args.version}")
    print(f"[i] nsisUrl: {nsis_url}")

    sha = ""
    if not args.no_sha256:
        print("[i] 计算 sha256...")
        sha = sha256_file(installer)
        print(f"[i] sha256: {sha}")

    latest = {
        "channel": "stable",
        "version": str(args.version).strip(),
        "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "notes": str(args.notes or "").strip(),
        "windows": {
            "nsisUrl": nsis_url,
            "sha256": sha,
        },
    }

    # 写入临时 latest.json
    with tempfile.TemporaryDirectory() as td:
        latest_path = os.path.join(td, "latest.json")
        with open(latest_path, "w", encoding="utf-8") as f:
            json.dump(latest, f, ensure_ascii=False, indent=2)
            f.write("\n")

        ssh_cmd = ["ssh"]
        scp_cmd = ["scp"]
        if args.ssh_port:
            ssh_cmd += ["-p", str(args.ssh_port)]
            scp_cmd += ["-P", str(args.ssh_port)]
        if args.ssh_key:
            ssh_cmd += ["-i", str(args.ssh_key)]
            scp_cmd += ["-i", str(args.ssh_key)]

        # 1) mkdir -p remoteDir
        # 重要：Windows Git Bash 下 args.remote_dir 可能会被 MSYS 路径转换污染
        # （例如 /www/... 或 /opt/... 变成 C:/Program Files/Git/www/... 或 C:/Program Files/Git/opt/...）。
        # 这里对 remote_dir 做一次“强制还原”：
        # - 如果出现 "C:/Program Files/Git/(www|opt)/..." 这种形式，截取从 "/www/" 或 "/opt/" 开始的部分
        # - 只在明显被污染时处理，不影响正常 Linux 路径
        remote_dir = str(args.remote_dir)
        m = re.search(r"(/(?:www|opt)/.*)$", remote_dir)
        if m:
            remote_dir = m.group(1)
        mkdir_cmd = ssh_cmd + [args.ssh, f"mkdir -p {remote_dir}"]

        # 2) 上传：installer 到 remoteDir（目录末尾 /，避免处理带空格的远端文件路径 quoting）
        scp_exe_cmd = scp_cmd + [installer, f"{args.ssh}:{remote_dir}/"]
        scp_latest_cmd = scp_cmd + [latest_path, f"{args.ssh}:{remote_dir}/latest.json"]

        print("-" * 60)
        print("[i] 将执行：")
        print("  ", " ".join(mkdir_cmd))
        print("  ", " ".join(scp_exe_cmd))
        print("  ", " ".join(scp_latest_cmd))

        if args.dry_run:
            print("[i] dry-run：未执行上传。")
            return 0

        print("-" * 60)
        print("[1/3] 创建远端目录…")
        run(mkdir_cmd)
        print("[2/3] 上传 installer…")
        run(scp_exe_cmd)
        print("[3/3] 上传 latest.json…")
        run(scp_latest_cmd)

        print("-" * 60)
        print("[OK] 上传完成")
        print(f"[OK] latest.json: {gateway_base}/downloads/desktop/stable/latest.json")
        print(f"[OK] installer : {nsis_url}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())


