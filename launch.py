#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Install into this folder's private venv and open the local control panel."""
import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    if sys.version_info < (3, 11):
        raise RuntimeError("需要 Python 3.11 或更高版本，请从 https://www.python.org/downloads/ 安装。")
    arguments = sys.argv[1:]
    if "--demo" in arguments:
        os.execv(sys.executable, [sys.executable, str(ROOT / "app.py"), *arguments])
    environment = ROOT / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        print("正在创建独立运行环境…", flush=True)
        venv.create(environment, with_pip=True)
    probe = subprocess.run([str(python), "-c", "import certifi; from importlib.metadata import version; from pymobiledevice3.remote.rsd_tunnel import PreferredRsdTunnel; assert version('pymobiledevice3') == '11.50.2'"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if probe.returncode:
        print("首次启动正在安装定位组件，需要联网，可能花几分钟。", flush=True)
        uv = shutil.which("uv")
        if uv:
            command = [uv, "pip", "install", "--python", str(python), "-r", str(ROOT / "requirements.txt")]
        else:
            command = [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "-r", str(ROOT / "requirements.txt")]
        subprocess.run(command, check=True)
    os.execv(str(python), [str(python), str(ROOT / "app.py"), *arguments])


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("\n启动失败：" + str(exc), flush=True)
        print("请检查网络、Python 版本和终端中的具体错误。", flush=True)
        if sys.stdin.isatty():
            input("按回车关闭…")
        sys.exit(1)
