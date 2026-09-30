"""根据当前网站内容生成可直接下载的投递版 PDF。"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        if os.environ.get("PORTFOLIO_DEBUG") == "1":
            print("本地页面请求：" + format % args, flush=True)


def webdriver_request(base: str, route: str, payload: dict | None = None, method: str | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(base + route, data=data, headers={"Content-Type": "application/json"}, method=method)
    with urlopen(request, timeout=25) as response:
        result = json.load(response)
    if isinstance(result.get("value"), dict) and result["value"].get("error"):
        raise RuntimeError(f"浏览器控制失败：{result['value']['message']}")
    return result


def render_with_webdriver(url: str, output: Path, chrome: str, chromedriver: str, chrome_data: str) -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    driver = subprocess.Popen([chromedriver, f"--port={port}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    session_id = None
    try:
        for _ in range(50):
            if driver.poll() is not None:
                raise RuntimeError("ChromeDriver 启动失败")
            try:
                webdriver_request(base, "/status")
                break
            except URLError:
                time.sleep(0.1)
        else:
            raise RuntimeError("ChromeDriver 启动超时")
        args = ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-extensions", f"--user-data-dir={chrome_data}"]
        session = webdriver_request(base, "/session", {"capabilities": {"alwaysMatch": {"browserName": "chrome", "goog:chromeOptions": {"binary": chrome, "args": args}}}})
        session_id = session["value"]["sessionId"]
        route = f"/session/{session_id}"
        webdriver_request(base, route + "/url", {"url": url})
        for _ in range(100):
            ready = webdriver_request(base, route + "/execute/sync", {"script": "return document.body.dataset.resumeReady === 'true' && document.fonts.status === 'loaded'", "args": []})
            if ready["value"]:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("简历页面渲染超时")
        result = webdriver_request(base, route + "/goog/cdp/execute", {"cmd": "Page.printToPDF", "params": {"printBackground": True, "preferCSSPageSize": True, "displayHeaderFooter": False}})
        pdf = base64.b64decode(result["value"]["data"])
        if len(pdf) < 10_000 or pdf[:4] != b"%PDF":
            raise RuntimeError("ChromeDriver 返回的 PDF 无效")
        output.write_bytes(pdf)
    finally:
        if session_id:
            try:
                webdriver_request(base, f"/session/{session_id}", method="DELETE")
            except Exception:
                pass
        driver.terminate()
        try:
            driver.wait(timeout=5)
        except subprocess.TimeoutExpired:
            driver.kill()
            driver.wait()


def build(site: Path, chrome: str, chromedriver: str | None = None) -> Path:
    output = site / "assets" / "resume.pdf"
    output.parent.mkdir(parents=True, exist_ok=True)
    handler = partial(QuietHandler, directory=str(site))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="portfolio-chrome-") as chrome_data:
            url = f"http://127.0.0.1:{server.server_port}/resume.html"
            with urlopen(url, timeout=5) as response:
                if response.status != 200:
                    raise RuntimeError(f"本地页面返回状态 {response.status}")
                print("本地页面服务正常", flush=True)
            if chromedriver:
                render_with_webdriver(url, output, chrome, chromedriver, chrome_data)
                return output
            common = [
                chrome,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--disable-background-networking",
                "--disable-extensions",
                "--no-pdf-header-footer",
                f"--user-data-dir={chrome_data}",
            ]
            try:
                check = subprocess.run([*common, "--dump-dom", url], capture_output=True, text=True, timeout=25)
            except subprocess.TimeoutExpired as error:
                page_output = error.stdout or b""
                if isinstance(page_output, str):
                    page_output = page_output.encode("utf-8")
                ready = b'data-resume-ready="true"' in page_output
                print(f"Chrome 页面输出字节数：{len(page_output)}；已渲染标记：{ready}", flush=True)
                details = (error.stderr or b"")[-1800:]
                if isinstance(details, bytes):
                    details = details.decode("utf-8", errors="replace")
                raise RuntimeError(f"Chrome 页面检查超时：{details}") from error
            if check.returncode or 'data-resume-ready="true"' not in check.stdout:
                raise RuntimeError("简历页面未正确加载，已停止生成 PDF")
            temporary_pdf = output.with_suffix(".building.pdf")
            try:
                result = subprocess.run([*common, "--no-pdf-header-footer", f"--print-to-pdf={temporary_pdf}", url], capture_output=True, text=True, timeout=60)
                if result.returncode or not temporary_pdf.exists() or temporary_pdf.stat().st_size < 10_000 or temporary_pdf.read_bytes()[:4] != b"%PDF":
                    raise RuntimeError(f"PDF 生成失败：{result.stderr.strip()}")
                os.replace(temporary_pdf, output)
            finally:
                temporary_pdf.unlink(missing_ok=True)
    finally:
        server.shutdown()
        server.server_close()
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="生成网站的投递版 PDF 简历")
    parser.add_argument("--chrome", default=shutil.which("google-chrome") or shutil.which("chromium"))
    parser.add_argument("--chromedriver", default=shutil.which("chromedriver"))
    parser.add_argument("--site", type=Path, default=Path(__file__).resolve().parent)
    arguments = parser.parse_args()
    if not arguments.chrome:
        parser.error("找不到 Chrome 或 Chromium，请通过 --chrome 指定浏览器路径")
    output = build(arguments.site.resolve(), arguments.chrome, arguments.chromedriver)
    print(f"已生成：{output}")


if __name__ == "__main__":
    main()
