#!/bin/zsh
set -eu
task_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
task_python=""
for candidate in /usr/local/bin/python3.13 /opt/homebrew/bin/python3.13 /usr/local/bin/python3 /opt/homebrew/bin/python3 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    task_python="$candidate"
    break
  fi
done
if [[ -z "$task_python" ]]; then
  print "需要先安装 Python 3.11 或更新版本：https://www.python.org/downloads/"
  read '?按回车关闭…'
  exit 1
fi
exec "$task_python" "$task_dir/launch.py" "$@"
