# SPDX-License-Identifier: GPL-3.0-or-later
"""Run Waypoint's unit suites and optionally the Chrome demo from any directory."""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description="运行 Waypoint 的 Python 和 JavaScript 测试")
    parser.add_argument("--browser", action="store_true", help="继续运行 Chrome 演示界面测试")
    args = parser.parse_args()

    node = shutil.which("node")
    if node is None:
        parser.exit(1, "未找到 Node.js。请安装 Node.js 22 或更高版本后重试。\n")
    js_tests = sorted((ROOT / "tests").glob("test_*.mjs"))
    if not js_tests:
        parser.exit(1, "tests/ 下没有找到 JavaScript 单元测试。\n")
    commands = [
        [sys.executable, "-m", "unittest", "discover", "-s", "tests"],
        [node, "--test", *js_tests],
    ]
    if args.browser:
        commands.append([node, "tests/browser/demo.mjs"])

    env = os.environ.copy()
    env.setdefault("PYTHON", sys.executable)
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, env=env)
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
