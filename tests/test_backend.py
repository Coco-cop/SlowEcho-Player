"""Source-release smoke tests; synthetic data and temporary storage only."""
import ast
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import listening_segments
import portable_paths
import recognition_server
import storage_config
import subtitle_store

KEY = 'ab' * 16
LESSON = {'videoName': 'Synthetic lesson', 'offset': .25,
          'segments': [{'start': 1, 'end': 3, 'text': 'Hello there.', 'zh': '你好。'}]}


class SourceTests(unittest.TestCase):
    def test_python_source_syntax(self):
        for path in ROOT.glob('*.py'):
            with self.subTest(file=path.name):
                ast.parse(path.read_text(encoding='utf-8-sig'), filename=path.name)

    def test_default_directory_is_user_relative(self):
        with patch.object(portable_paths, 'bundled_data_dir', return_value=None):
            self.assertEqual(subtitle_store.default_library_root(),
                             os.path.join(os.path.expanduser('~'), '.echoplayer', 'subtitles'))

    def test_timed_segmentation_preserves_all_words(self):
        words = [{'word': 'word%d' % i, 'start': i * .4, 'end': i * .4 + .3}
                 for i in range(30)]
        groups = listening_segments.group_words_into_sentences(words, max_seconds=3, max_words=6)
        self.assertEqual([w['word'] for g in groups for w in g['words']],
                         [w['word'] for w in words])
        self.assertTrue(all(len(g['words']) <= 6 and g['end'] - g['start'] <= 3.001
                            for g in groups))
        self.assertTrue(all(a['end'] <= b['start'] for a, b in zip(groups, groups[1:])))


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {
            'ECHOPLAYER_LIBRARY_DIR': str(self.root / 'lessons'),
            'ECHOPLAYER_STORAGE_CONFIG': str(self.root / 'storage.json')})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_save_round_trip_excludes_credentials(self):
        payload = dict(LESSON, dsKey='synthetic-private-marker', settings={'secret': 'marker'})
        subtitle_store.save(KEY, payload)
        saved = subtitle_store.load(KEY)
        self.assertEqual(saved['segments'], LESSON['segments'])
        raw = (self.root / 'lessons' / (KEY + '.json')).read_text(encoding='utf-8')
        self.assertNotIn('synthetic-private-marker', raw)
        self.assertNotIn('settings', saved)
        srt = (self.root / 'lessons' / (KEY + '.srt')).read_text(encoding='utf-8')
        self.assertIn('00:00:01,000 --> 00:00:03,000', srt)
        self.assertIn('你好。', srt)

    def test_path_traversal_rejected(self):
        for key in ['../private', KEY + '/../../private', '', 'z' * 32]:
            with self.subTest(key=key), self.assertRaises(subtitle_store.LibraryError):
                subtitle_store.save(key, LESSON)
        self.assertFalse((self.root / 'lessons').exists())

    def test_invalid_and_oversized_payload_not_written(self):
        with self.assertRaises(subtitle_store.LibraryError):
            subtitle_store.save(KEY, {'segments': 'invalid'})
        with self.assertRaises(subtitle_store.LibraryError) as caught:
            subtitle_store.save(KEY, {'segments': [{}] * (subtitle_store.MAX_SEGMENTS + 1)})
        self.assertEqual(caught.exception.code, 413)
        self.assertFalse((self.root / 'lessons').exists())


class HTTPTests(StorageTests):
    # Do not inherit storage test cases twice; start a real local server once per HTTP case.
    test_save_round_trip_excludes_credentials = None
    test_path_traversal_rejected = None
    test_invalid_and_oversized_payload_not_written = None

    def setUp(self):
        super().setUp()
        self.server = recognition_server.create_server('127.0.0.1', 0, str(ROOT))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.manager.shutdown()
        self.thread.join(timeout=2)
        super().tearDown()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def test_public_assets_work_private_files_denied(self):
        status, html = self.request('GET', '/index.html')
        self.assertEqual(status, 200)
        self.assertIn(b'SlowEcho Player', html)
        for path in ['/recognition_server.py', '/.env', '/data/storage.json', '/local-media.json']:
            with self.subTest(path=path):
                self.assertEqual(self.request('GET', path)[0], 404)
        for path in recognition_server.PUBLIC_FILES:
            if (ROOT / path).is_file():
                with self.subTest(asset=path):
                    self.assertEqual(self.request('GET', '/' + path)[0], 200)

    def test_cross_site_write_rejected_and_valid_write_succeeds(self):
        path = '/api/library/' + KEY
        body = json.dumps(dict(LESSON, dsKey='synthetic-private-marker'))
        self.assertEqual(self.request('POST', path, body)[0], 403)
        headers = {'X-EchoPlayer': '1', 'Content-Type': 'application/json',
                   'Origin': 'https://untrusted.invalid'}
        self.assertEqual(self.request('POST', path, body, headers)[0], 403)
        self.assertIsNone(subtitle_store.load(KEY))
        headers['Origin'] = 'http://127.0.0.1:%d' % self.server.server_port
        self.assertEqual(self.request('POST', path, body, headers)[0], 200)
        status, raw = self.request('GET', path)
        self.assertEqual(status, 200)
        self.assertNotIn(b'synthetic-private-marker', raw)


if __name__ == '__main__':
    unittest.main()
