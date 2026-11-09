#!/bin/zsh
set -eu
task_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec python3 "$task_dir/launch.py" --demo
