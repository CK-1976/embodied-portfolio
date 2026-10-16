"""提供仅本机可访问的编辑台，保存后自动发布网页与简历。"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import mimetypes
import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

PRIVATE_FIELDS = ('name', 'initials', 'email', 'emailAlt', 'phone')
PUBLIC_PROFILE = dict(zip(PRIVATE_FIELDS, ('作品集作者', 'PI', '', '', '')))
STATIC_FILES = {
    'index.html', 'editor.html', 'resume.html', 'app.js', 'styles.css',
    'editor.js', 'editor.css', 'editor-storage.js', 'content-state.js',
    'resume.js', 'resume.css',
}


class EditorError(Exception):
    """可以直接显示给维护者的校验错误。"""


def atomic_write(path: Path, body: bytes, private: bool = False):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.saving-' + secrets.token_hex(6))
    try:
        temporary.write_bytes(body)
        if private:
            temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def asset_path(value: str) -> str:
    if not isinstance(value, str) or '\\' in value or any(part.startswith('.') for part in value.split('/')):
        raise EditorError('素材路径不合法')
    if not re.fullmatch(r'assets/(images|video)/[\w/.-]+\.(jpg|jpeg|png|webp|mp4)', value, re.IGNORECASE):
        raise EditorError('素材必须位于 assets/images 或 assets/video，并使用支持的格式')
    return value


def referenced_assets(content):
    values = [content['profile'].get('heroImage', '')]
    for project in content['projects']:
        values.append(project.get('cover', ''))
        for media in project['media']:
            values.extend([media.get('src', ''), media.get('poster', '')])
    result = set()
    for value in values:
        if not value:
            continue
        if not isinstance(value, str):
            raise EditorError('素材地址必须是文字')
        if value.startswith('assets/'):
            result.add(asset_path(value))
        elif urlsplit(value).scheme not in ('https', 'http') or not urlsplit(value).netloc:
            raise EditorError('外部素材地址必须是完整的 HTTP 或 HTTPS 地址')
    return result


def validate_content(content):
    if not isinstance(content, dict) or not isinstance(content.get('profile'), dict):
        raise EditorError('个人资料格式错误')
    for key in PRIVATE_FIELDS:
        if not isinstance(content['profile'].get(key, ''), str):
            raise EditorError('姓名、缩写和联系方式必须是文字')
    if not content['profile'].get('name') or not content['profile'].get('email'):
        raise EditorError('请填写姓名和主要邮箱')
    for key in ('projects', 'capabilities', 'experiences', 'certificates', 'navigation'):
        if not isinstance(content.get(key), list):
            raise EditorError('内容缺少必要列表：' + key)
    ids = []
    for project in content['projects']:
        if not isinstance(project, dict) or not isinstance(project.get('title'), str):
            raise EditorError('项目内容格式错误')
        identifier = project.get('id', '')
        if not isinstance(identifier, str) or not re.fullmatch('[a-z0-9-]+', identifier):
            raise EditorError('项目锚点只能使用英文小写、数字和连字符')
        ids.append(identifier)
        for key in ('tags', 'contributions', 'resumeBullets'):
            if not isinstance(project.get(key), list) or not all(isinstance(item, str) for item in project[key]):
                raise EditorError('项目标签或条目格式错误')
        if not isinstance(project.get('media'), list):
            raise EditorError('项目影像列表格式错误')
        for media in project['media']:
            if not isinstance(media, dict) or media.get('type') not in ('image', 'video') or not isinstance(media.get('title'), str):
                raise EditorError('项目影像内容格式错误')
    if len(ids) != len(set(ids)):
        raise EditorError('项目锚点不能重复')
    for record in content['experiences']:
        if not isinstance(record, dict) or not isinstance(record.get('bullets'), list) or not all(isinstance(item, str) for item in record['bullets']):
            raise EditorError('工作经历格式错误')
    for record in content['capabilities']:
        if not isinstance(record, dict) or not isinstance(record.get('tags'), list) or not all(isinstance(item, str) for item in record['tags']):
            raise EditorError('能力标签格式错误')
    if not all(isinstance(item, str) for item in content['certificates']):
        raise EditorError('证书格式错误')
    for item in content['navigation']:
        if not isinstance(item, dict) or not isinstance(item.get('label'), str) or not isinstance(item.get('href'), str):
            raise EditorError('导航格式错误')
    return referenced_assets(content)


class EditorApplication:
    def __init__(self, repo: Path, profile: Path):
        self.repo = repo.resolve()
        self.profile = profile.resolve()
        if self.profile.is_relative_to(self.repo):
            raise EditorError('私密资料文件必须放在公开仓库外')
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.temporary = tempfile.TemporaryDirectory(prefix='portfolio-editor-')
        self.uploads = Path(self.temporary.name)
        self.job = None
        remote = self.command('git', 'remote', 'get-url', 'origin').strip()
        match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([\w.-]+/[\w.-]+?)(?:\.git)?', remote)
        if not match:
            raise EditorError('编辑台需要连接既有 GitHub 仓库')
        self.repository = match.group(1)
        owner, name = self.repository.split('/')
        self.public_url = f'https://{owner.lower()}.github.io/{name}/'

    def command(self, *args, input_text=None, timeout=60):
        result = subprocess.run(args, cwd=self.repo, input=input_text, text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            raise EditorError('GitHub 或 Git 操作失败，请检查本机登录、网络及仓库权限；已保存内容可以重试发布')
        return result.stdout

    def snapshot(self):
        with self.lock:
            content = json.loads((self.repo / 'content.json').read_text(encoding='utf-8'))
            profile = json.loads(self.profile.read_text(encoding='utf-8'))
            content['profile'].update({key: profile.get(key, '') for key in PRIVATE_FIELDS})
            revision = hashlib.sha256(json_bytes(content)).hexdigest()
            return content, revision

    def resolve_asset(self, value):
        path = (self.repo / asset_path(value)).resolve()
        if not path.is_relative_to(self.repo / 'assets'):
            raise EditorError('素材路径超出项目目录')
        return path

    def save_upload(self, value, body):
        asset_path(value)
        extension = Path(value).suffix.lower()
        signatures = {'.jpg': body.startswith(b'\xff\xd8'), '.jpeg': body.startswith(b'\xff\xd8'), '.png': body.startswith(b'\x89PNG\r\n\x1a\n'), '.webp': body[:4] == b'RIFF' and body[8:12] == b'WEBP', '.mp4': body[4:8] == b'ftyp'}
        if not signatures.get(extension):
            raise EditorError('素材内容与文件格式不一致')
        atomic_write(self.uploads / value, body)

    def begin_publish(self, payload):
        with self.lock:
            if self.job and self.job['status'] == 'running':
                raise EditorError('上一轮发布尚未完成，请稍候')
            content = payload.get('content')
            paths = validate_content(content)
            old_content, current_revision = self.snapshot()
            if payload.get('revision') != current_revision:
                raise EditorError('内容已被另一窗口更新，请先载入最新版本；当前草稿仍保留')
            if self.command('git', 'branch', '--show-current').strip() != 'main':
                raise EditorError('请在 main 分支使用一键发布')
            if self.command('git', 'diff', '--cached', '--name-only').strip():
                raise EditorError('仓库存在已暂存的其他改动，请先处理后再发布')
            for value in paths:
                if not (self.uploads / value).is_file() and not self.resolve_asset(value).is_file():
                    raise EditorError('找不到素材：' + value)
            public = json.loads(json.dumps(content))
            public['profile'].update(PUBLIC_PROFILE)
            body = json_bytes(public)
            private = {key: content['profile'].get(key, '') for key in PRIVATE_FIELDS}
            for key in ('name', 'email', 'emailAlt', 'phone'):
                value = private.get(key)
                if value and value in body.decode('utf-8'):
                    raise EditorError('项目文字包含姓名或联系方式，请把个人资料只填在对应资料栏')
            backup = self.repo.parent / 'portfolio-editor-backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3))
            backup.mkdir(parents=True)
            backup.chmod(0o700)
            atomic_write(backup / 'content.json', (self.repo / 'content.json').read_bytes(), True)
            atomic_write(backup / 'private-profile.json', self.profile.read_bytes(), True)
            for value in paths:
                uploaded = self.uploads / value
                if uploaded.is_file():
                    atomic_write(self.resolve_asset(value), uploaded.read_bytes())
            atomic_write(self.profile, json_bytes(private), True)
            atomic_write(self.repo / 'content.json', body)
            _, revision = self.snapshot()
            self.job = {'id': secrets.token_hex(8), 'status': 'running', 'message': '已保存到本机，准备发布', 'revision': revision, 'url': self.public_url}
            threading.Thread(target=self.publish, args=(content, paths), daemon=True).start()
            return dict(self.job)

    def progress(self, message, **fields):
        with self.lock:
            self.job.update(message=message, **fields)

    def runs(self):
        return json.loads(self.command('gh', 'run', 'list', '--repo', self.repository, '--workflow', 'pages.yml', '--limit', '12', '--json', 'databaseId,headSha,status,conclusion'))

    def publish(self, expected, paths):
        try:
            known = {run['databaseId'] for run in self.runs()}
            self.progress('同步网页个人资料')
            private = {key: expected['profile'].get(key, '') for key in PRIVATE_FIELDS}
            self.command('gh', 'secret', 'set', 'PORTFOLIO_PRIVATE_PROFILE', '--repo', self.repository, input_text=json.dumps(private, ensure_ascii=False))
            selected = ['content.json', *sorted(paths)]
            self.command('git', 'add', '--', *selected)
            changed = self.command('git', 'diff', '--cached', '--name-only').strip()
            if changed:
                try:
                    self.command('git', '-c', 'user.name=Portfolio Maintainer', '-c', 'user.email=maintainer@users.noreply.github.com', 'commit', '-m', '从编辑台更新作品集内容与素材', '--', *selected)
                except Exception:
                    # 提交失败时只撤销本轮暂存，保留内容和素材，允许直接重试。
                    self.command('git', 'reset', 'HEAD', '--', *selected)
                    raise
            sha = self.command('git', 'rev-parse', 'HEAD').strip()
            self.progress('已保存，正在推送 GitHub')
            self.command('git', 'push', 'origin', 'main', timeout=120)
            if not changed:
                self.command('gh', 'workflow', 'run', 'pages.yml', '--repo', self.repository, '--ref', 'main')
            self.progress('正在构建网站与简历 PDF')
            run = None
            for _ in range(20):
                run = next((item for item in self.runs() if item['headSha'] == sha and item['databaseId'] not in known), None)
                if run:
                    break
                time.sleep(3)
            if not run:
                raise EditorError('已推送，但尚未读取到发布任务；可到 GitHub Actions 查看')
            run_url = f'https://github.com/{self.repository}/actions/runs/{run["databaseId"]}'
            self.progress('网站与 PDF 发布中', workflowUrl=run_url)
            self.command('gh', 'run', 'watch', str(run['databaseId']), '--repo', self.repository, '--exit-status', '--interval', '5', timeout=600)
            self.progress('发布完成，正在核对线上内容')
            for attempt in range(8):
                try:
                    request = Request(self.public_url + 'content.json?v=' + sha, headers={'Cache-Control': 'no-cache'})
                    with urlopen(request, timeout=20) as response:
                        actual = json.load(response)
                    if actual == expected:
                        break
                except (OSError, ValueError):
                    pass
                if attempt == 7:
                    raise EditorError('发布任务已成功，但线上内容校验尚未通过；请查看发布记录后重试')
                time.sleep(5)
            with urlopen(self.public_url + 'assets/resume.pdf?v=' + sha, timeout=30) as response:
                pdf = response.read()
            if not pdf.startswith(b'%PDF') or len(pdf) < 10000:
                raise EditorError('网页已发布，但简历文件未通过检查')
            atomic_write(self.repo / 'assets/resume.pdf', pdf)
            atomic_write(self.repo.parent / 'output/pdf/机器人感知-投递版简历.pdf', pdf)
            self.progress('已发布，公开网页和简历 PDF 已同步', status='success', sha=sha)
        except Exception as error:
            message = str(error) if isinstance(error, EditorError) else '发布中断，内容已保存在本机，可保留草稿后重试'
            self.progress(message, status='error')


def make_handler(application):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def guard(self, mutation=False):
            origin = f'http://127.0.0.1:{self.server.server_port}'
            if self.headers.get('Host') != origin.removeprefix('http://'):
                raise EditorError('请通过本机编辑台地址访问')
            if self.headers.get('Sec-Fetch-Site') == 'cross-site':
                # 允许公开编辑页打开本机页面，接口和后台请求仍拒绝跨站访问。
                navigation = (not mutation and self.headers.get('Sec-Fetch-Mode') == 'navigate'
                              and self.headers.get('Sec-Fetch-Dest') == 'document'
                              and urlsplit(self.path).path in ('/', '/editor.html', '/index.html', '/resume.html'))
                if not navigation:
                    raise EditorError('不接受其他网站发起的请求')
            if mutation and (self.headers.get('Origin') != origin or not secrets.compare_digest(self.headers.get('X-Editor-Token', ''), application.token)):
                raise EditorError('编辑台校验失败，请刷新本机页面')

        def send_json(self, value, status=200, **headers):
            body = json_bytes(value)
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            for key, value in headers.items():
                self.send_header(key.replace('_', '-'), value)
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def read_body(self, maximum):
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > maximum:
                raise EditorError('请求内容为空或超过大小限制')
            body = self.rfile.read(length)
            if len(body) != length:
                raise EditorError('上传未完成，请重试')
            return body

        def do_GET(self):
            try:
                self.guard()
                route = unquote(urlsplit(self.path).path).lstrip('/') or 'index.html'
                if route == 'api/config':
                    _, revision = application.snapshot()
                    return self.send_json({'available': True, 'token': application.token, 'revision': revision, 'publicUrl': application.public_url})
                if route == 'api/status':
                    with application.lock:
                        return self.send_json(application.job or {'status': 'idle'})
                if route == 'content.json':
                    content, revision = application.snapshot()
                    return self.send_json(content, X_Content_Revision=revision)
                if route not in STATIC_FILES and not route.startswith('assets/'):
                    self.send_error(404)
                    return
                file = application.resolve_asset(route) if route.startswith('assets/') and route != 'assets/resume.pdf' else application.repo / route
                if not file.is_file():
                    self.send_error(404)
                    return
                body = file.read_bytes()
                if file.suffix == '.html':
                    content, _ = application.snapshot()
                    document = body.decode('utf-8').replace('__PORTFOLIO_NAME__', html.escape(content['profile']['name'], quote=True))
                    document = document.replace('__PORTFOLIO_INITIALS__', html.escape(content['profile'].get('initials', 'PI'), quote=True))
                    body = document.encode('utf-8')
                start, end = 0, len(body) - 1
                partial = self.headers.get('Range')
                if partial:
                    match = re.fullmatch(r'bytes=(\d+)-(\d*)', partial)
                    if not match or int(match[1]) >= len(body):
                        self.send_error(416)
                        return
                    start = int(match[1])
                    end = min(int(match[2]), end) if match[2] else end
                    if end < start:
                        self.send_error(416)
                        return
                self.send_response(206 if partial else 200)
                self.send_header('Content-Type', mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Accept-Ranges', 'bytes')
                if partial:
                    self.send_header('Content-Range', f'bytes {start}-{end}/{len(body)}')
                self.send_header('Content-Length', str(end - start + 1))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(body[start:end + 1])
            except (EditorError, ValueError, KeyError, TypeError):
                self.send_json({'error': '请求不合法或编辑台资料未就绪'}, 400)
            except (BrokenPipeError, ConnectionResetError):
                pass

        do_HEAD = do_GET

        def do_PUT(self):
            try:
                self.guard(True)
                route = unquote(urlsplit(self.path).path).lstrip('/')
                if not route.startswith('api/media/'):
                    raise EditorError('上传入口不存在')
                application.save_upload(route.removeprefix('api/media/'), self.read_body(80 * 1024 * 1024))
                self.send_json({'saved': True})
            except (EditorError, ValueError) as error:
                self.send_json({'error': str(error)}, 400)

        def do_POST(self):
            try:
                self.guard(True)
                if urlsplit(self.path).path != '/api/publish':
                    raise EditorError('保存入口不存在')
                payload = json.loads(self.read_body(4 * 1024 * 1024))
                if not isinstance(payload, dict):
                    raise EditorError('保存数据格式错误')
                self.send_json(application.begin_publish(payload), 202)
            except (EditorError, ValueError, TypeError) as error:
                self.send_json({'error': str(error)}, 409 if isinstance(error, EditorError) else 400)

    return Handler


def main():
    parser = argparse.ArgumentParser(description='启动本机作品集编辑台，保存后发布网页与PDF')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--profile-file', type=Path)
    parser.add_argument('--port', type=int, default=8771)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    profile = args.profile_file or args.repo.parent / 'portfolio-private-profile.json'
    if not profile.is_file():
        parser.error('缺少仓库外的个人资料文件，请先配置私密资料')
    app = EditorApplication(args.repo, profile)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(app))
    url = f'http://127.0.0.1:{server.server_port}/editor.html'
    print('本机编辑台：' + url, flush=True)
    print('保存并发布会自动更新公开网页与简历；按Ctrl+C停止编辑台。', flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.temporary.cleanup()


if __name__ == '__main__':
    main()
