"""使用两个独立来源和临时仓库测试在线草稿的一键发布，不访问 GitHub。"""
import importlib.util
import json
import shutil
import subprocess
import tempfile
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('editor_server', ROOT / 'editor_server.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class TestPublisher(module.EditorApplication):
    fail_next = False

    def command(self, *args, **kwargs):
        if args[:4] == ('git', 'remote', 'get-url', 'origin'):
            return 'https://github.com/example/portfolio.git'
        if args[:3] == ('git', 'branch', '--show-current'):
            return 'main'
        if args[:3] == ('git', 'diff', '--cached'):
            return ''
        raise AssertionError('隔离测试不允许执行真实 GitHub 发布命令')

    def publish(self, expected, paths):
        time.sleep(.3)
        if self.fail_next:
            self.fail_next = False
            self.progress('测试网络失败，内容已保存到本机', status='error')
            return
        # 模拟部署结果，用于核对网页读取到了实际传递的内容与素材。
        for asset in paths:
            target = self.public / asset
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.repo / asset, target)
        (self.public / 'content.json').write_bytes(module.json_bytes(expected))
        self.progress('测试发布完成，网页与 PDF 已同步', status='success')


def main():
    with tempfile.TemporaryDirectory(prefix='portfolio-bridge-test-') as temporary:
        parent = Path(temporary)
        repo, public = parent / 'repo', parent / 'public'
        repo.mkdir(); public.mkdir()
        data = json.loads((ROOT / 'content.json').read_text())
        for project in data['projects']:
            project['cover'] = ''
            project['media'] = []
        data['profile']['heroImage'] = ''
        private = {'name':'维护者样例', 'initials':'TEST', 'email':'owner@example.invalid', 'emailAlt':'', 'phone':''}
        profile = parent / 'private-profile.json'
        profile.write_text(json.dumps(private))
        (repo / 'content.json').write_bytes(module.json_bytes(data))
        app = TestPublisher(repo, profile)
        app.public = public
        local = ThreadingHTTPServer(('127.0.0.1', 0), module.make_handler(app))
        local_url = f'http://127.0.0.1:{local.server_port}'

        class PublicHandler(SimpleHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                if self.path == '/test/fail-next':
                    app.fail_next = True
                    self.send_response(204); self.end_headers()
                else:
                    self.send_error(404)

        online = ThreadingHTTPServer(('127.0.0.1', 0), partial(PublicHandler, directory=str(public)))
        public_url = f'http://127.0.0.1:{online.server_port}'
        app.public_url = public_url + '/'
        for folder in (repo, public):
            for filename in module.STATIC_FILES:
                text = (ROOT / filename).read_text()
                if filename == 'editor-publish.js':
                    text = text.replace('http://127.0.0.1:8771', local_url)
                if filename.endswith('.html'):
                    text = text.replace('__PORTFOLIO_NAME__', private['name']).replace('__PORTFOLIO_INITIALS__', private['initials'])
                (folder / filename).write_text(text)
        data['profile'].update(private)
        (public / 'content.json').write_bytes(module.json_bytes(data))
        for server in (local, online):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            subprocess.run([
                '/home/asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
                str(ROOT / 'tests/bridge_e2e.cjs'), public_url, local_url,
            ], check=True)
        finally:
            local.shutdown(); online.shutdown()
            local.server_close(); online.server_close(); app.temporary.cleanup()


if __name__ == '__main__':
    main()
