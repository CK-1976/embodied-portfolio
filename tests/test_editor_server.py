"""核对本机编辑台的访问边界、版本冲突和私密资料分离。"""
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('editor_server', ROOT / 'editor_server.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class LocalApplication(module.EditorApplication):
    def command(self, *args, **kwargs):
        if args[:4] == ('git', 'remote', 'get-url', 'origin'):
            return 'https://github.com/example/portfolio.git'
        if args[:3] == ('git', 'branch', '--show-current'):
            return 'main'
        if args[:3] == ('git', 'diff', '--cached'):
            return ''
        raise AssertionError('测试不允许调用真实发布命令')

    def publish(self, expected, paths):
        self.expected = expected
        self.progress('测试发布已接收', status='success')


class EditorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.parent = Path(self.temporary.name)
        self.repo = self.parent / 'portfolio'
        self.repo.mkdir()
        self.content = json.loads((ROOT / 'content.json').read_text())
        # 素材用最小图片代替，不涉及公司数据或真实个人资料。
        for project in self.content['projects']:
            project['cover'] = ''
            project['media'] = []
        self.content['profile']['heroImage'] = ''
        (self.repo / 'content.json').write_bytes(module.json_bytes(self.content))
        (self.repo / 'index.html').write_text('__PORTFOLIO_NAME__ __PORTFOLIO_INITIALS__')
        self.profile = self.parent / 'private-profile.json'
        self.profile.write_text(json.dumps({'name':'测试维护者', 'initials':'TEST', 'email':'test@example.invalid'}))
        self.app = LocalApplication(self.repo, self.profile)
        self.server = module.ThreadingHTTPServer(('127.0.0.1', 0), module.make_handler(self.app))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.temporary.cleanup()
        self.temporary.cleanup()

    def request(self, path, method='GET', data=None, headers=None):
        request = Request(self.url + path, method=method, data=data, headers=headers or {})
        try:
            with urlopen(request) as response:
                return response.status, response.read(), response.headers
        except HTTPError as error:
            return error.code, error.read(), error.headers

    def auth(self):
        return {'Origin':self.url, 'X-Editor-Token':self.app.token, 'Content-Type':'application/json'}

    def test_local_read_and_private_path_denial(self):
        status, body, headers = self.request('/content.json')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['profile']['initials'], 'TEST')
        self.assertTrue(headers['X-Content-Revision'])
        self.assertEqual(self.request('/.git/config')[0], 404)
        self.assertEqual(self.request('/../private-profile.json')[0], 404)
        self.assertEqual(self.request('/api/config', headers={'Host':'evil.invalid'})[0], 400)
        self.assertEqual(self.request('/api/config', headers={'Sec-Fetch-Site':'cross-site'})[0], 400)

    def test_public_page_can_open_local_editor_but_not_api(self):
        headers={'Sec-Fetch-Site':'cross-site', 'Sec-Fetch-Mode':'navigate', 'Sec-Fetch-Dest':'document'}
        self.assertEqual(self.request('/index.html',headers=headers)[0],200)
        self.assertEqual(self.request('/api/config',headers=headers)[0],400)

    def test_write_requires_origin_and_token(self):
        for headers in ({}, {'Origin':'https://evil.invalid','X-Editor-Token':self.app.token}, {'Origin':self.url}):
            self.assertNotEqual(self.request('/api/publish', 'POST', b'{}', headers)[0], 202)
        self.assertIsNone(self.app.job)

    def test_conflict_preserves_content(self):
        content, _ = self.app.snapshot()
        original = (self.repo / 'content.json').read_bytes()
        payload = json.dumps({'content':content,'revision':'old'}).encode()
        self.assertEqual(self.request('/api/publish','POST',payload,self.auth())[0],409)
        self.assertEqual((self.repo / 'content.json').read_bytes(),original)

    def test_publish_separates_private_fields_and_backs_up(self):
        content, revision = self.app.snapshot()
        content['profile']['intro'] = '新的项目简介'
        payload = json.dumps({'content':content,'revision':revision}).encode()
        self.assertEqual(self.request('/api/publish','POST',payload,self.auth())[0],202)
        public = (self.repo / 'content.json').read_text()
        self.assertNotIn('测试维护者',public)
        self.assertNotIn('test@example.invalid',public)
        self.assertEqual(json.loads(public)['profile']['name'],'作品集作者')
        self.assertEqual(self.app.snapshot()[0],content)
        self.assertEqual(len(list((self.parent / 'portfolio-editor-backups').glob('*/content.json'))),1)
        self.assertEqual(self.profile.stat().st_mode & 0o777,0o600)

    def test_private_text_in_project_is_rejected(self):
        content, revision = self.app.snapshot()
        content['projects'][0]['summary'] = '测试维护者的项目'
        payload = json.dumps({'content':content,'revision':revision}).encode()
        self.assertEqual(self.request('/api/publish','POST',payload,self.auth())[0],409)
        self.assertIsNone(self.app.job)

    def test_upload_signature_and_traversal(self):
        body=b'\xff\xd8\xff\xe0test'
        self.assertEqual(self.request('/api/media/assets/images/new.jpg','PUT',body,self.auth())[0],200)
        self.assertEqual(self.request('/api/media/assets/images/new.png','PUT',body,self.auth())[0],400)
        self.assertEqual(self.request('/api/media/assets/images/../leak.jpg','PUT',body,self.auth())[0],400)
        outside=self.parent/'outside.jpg';outside.write_bytes(body)
        (self.repo/'assets/images').mkdir(parents=True)
        (self.repo/'assets/images/link.jpg').symlink_to(outside)
        self.assertEqual(self.request('/assets/images/link.jpg')[0],400)

    def test_failed_commit_clears_only_selected_index_entries(self):
        calls = []
        def command(*args, **kwargs):
            calls.append(args)
            if args[:3] == ('gh', 'run', 'list'):
                return '[]'
            if args[:3] == ('git', 'diff', '--cached'):
                return 'content.json'
            if 'commit' in args:
                raise module.EditorError('测试提交失败')
            return ''
        self.app.command = command
        self.app.job = {'status':'running'}
        module.EditorApplication.publish(self.app, self.app.snapshot()[0], {'assets/images/test.jpg'})
        self.assertEqual(self.app.job['status'], 'error')
        self.assertIn(('git','reset','HEAD','--','content.json','assets/images/test.jpg'), calls)

    def test_video_range_and_pdf_download(self):
        folder=self.repo/'assets/video';folder.mkdir(parents=True)
        (folder/'test.mp4').write_bytes(b'0000ftyp0123456789')
        status,body,headers=self.request('/assets/video/test.mp4',headers={'Range':'bytes=8-11'})
        self.assertEqual((status,body),(206,b'0123'))
        self.assertEqual(headers['Content-Range'],'bytes 8-11/18')
        (self.repo/'assets/resume.pdf').write_bytes(b'%PDF-test')
        self.assertEqual(self.request('/assets/resume.pdf')[0],200)


if __name__ == '__main__':
    unittest.main()
