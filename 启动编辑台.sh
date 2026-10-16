#!/usr/bin/env bash
# 在本机启动编辑与自动发布服务，关闭终端会停止服务。
set -euo pipefail
portfolio_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$portfolio_dir/editor_server.py" --open "$@"
