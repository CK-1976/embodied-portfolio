"""把仓库外的个人资料写入待发布网站。"""

from __future__ import annotations

import argparse
import html
import json
import os
from pathlib import Path


PRIVATE_FIELDS = ("name", "initials", "email", "emailAlt", "phone")


def prepare(site: Path, profile_file: Path | None = None) -> None:
    private_text = profile_file.read_text(encoding="utf-8") if profile_file else os.environ.get("PORTFOLIO_PRIVATE_PROFILE", "")
    if not private_text:
        raise RuntimeError("缺少 PORTFOLIO_PRIVATE_PROFILE 密钥，已停止发布")
    private = json.loads(private_text)
    if not isinstance(private, dict) or not all(isinstance(private.get(key, ""), str) for key in PRIVATE_FIELDS):
        raise RuntimeError("私密资料格式错误")
    if not private.get("name") or not private.get("email"):
        raise RuntimeError("私密资料缺少姓名或主要邮箱")
    content_path = site / "content.json"
    content = json.loads(content_path.read_text(encoding="utf-8"))
    content["profile"].update({key: private.get(key, "") for key in PRIVATE_FIELDS})
    content_path.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for filename in ("index.html", "editor.html", "resume.html"):
        path = site / filename
        document = path.read_text(encoding="utf-8")
        path.write_text(document.replace("__PORTFOLIO_NAME__", html.escape(private["name"], quote=True)), encoding="utf-8")
    print("已准备站点个人资料")


def main() -> None:
    parser = argparse.ArgumentParser(description="注入只在发布网站展示的个人资料")
    parser.add_argument("--site", type=Path, required=True)
    parser.add_argument("--profile-file", type=Path)
    args = parser.parse_args()
    prepare(args.site, args.profile_file)


if __name__ == "__main__":
    main()
