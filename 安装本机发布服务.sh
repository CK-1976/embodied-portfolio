#!/usr/bin/env bash
# 为当前用户安装随登录启动的本机发布服务，凭据继续使用已有 GitHub CLI 登录。
set -euo pipefail
portfolio_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$portfolio_dir" <<'PY'
from pathlib import Path
import os,sys
repo = Path(sys.argv[1]).resolve()
config_dir = Path.home() / '.config/portfolio-publisher'
unit_dir = Path.home() / '.config/systemd/user'
config_dir.mkdir(parents=True, exist_ok=True); config_dir.chmod(0o700)
unit_dir.mkdir(parents=True, exist_ok=True)
def quote(value, specifiers=False):
    text = str(value).replace('\\', '\\\\').replace('"', '\\"')
    return '"' + (text.replace('%', '%%') if specifiers else text) + '"'
# 仅复制发布所需的代理设置，不复制登录令牌或其他进程环境。
environment = config_dir / 'environment'
lines = []
for key in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'):
    value = os.environ.get(key)
    if value and '\n' not in value and '\r' not in value:
        lines.append(key + '=' + quote(value))
environment.write_text('\n'.join(lines) + '\n'); environment.chmod(0o600)
unit = f'''[Unit]
Description=本机作品集发布服务
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 {quote(repo / 'editor_server.py', True)}
Environment=PYTHONUNBUFFERED=1
EnvironmentFile={environment.as_posix().replace('%', '%%')}
Restart=on-failure
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=10
UMask=0077

[Install]
WantedBy=default.target
'''
(unit_dir / 'portfolio-publisher.service').write_text(unit)
print('已准备当前用户的本机发布服务配置。')
PY
systemctl --user daemon-reload
systemctl --user enable portfolio-publisher.service
systemctl --user restart portfolio-publisher.service
python3 - <<'PY'
from urllib.request import urlopen
import json,time
for attempt in range(30):
    try:
        with urlopen('http://127.0.0.1:8771/api/config', timeout=2) as response:
            if json.load(response).get('available'):
                print('发布服务已启动，并会随登录自动启动。现在可在在线编辑页点击“一键更新网页和 PDF”。')
                break
    except OSError:
        pass
    time.sleep(.3)
else:
    raise SystemExit('服务尚未就绪，请运行 systemctl --user status portfolio-publisher.service 检查。')
PY
