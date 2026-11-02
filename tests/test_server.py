import json
import unittest
from unittest.mock import patch
import server
from pathlib import Path
import tempfile
import subprocess


class CoreTests(unittest.TestCase):
    def test_folder_picker_selects_existing_folder_and_cancellation(self):
        selected = subprocess.CompletedProcess([], 0, json.dumps({'folder':'D:/Research papers'}))
        cancelled = subprocess.CompletedProcess([], 0, '{"folder":""}')
        with patch.object(server.subprocess, 'run', side_effect=[selected, cancelled]) as run, patch.object(server.Path, 'is_dir', return_value=True):
            self.assertEqual(server.choose_folder('D:/Papers'), {'folder':'D:\\Research papers'})
            self.assertEqual(server.choose_folder(), {'folder':''})
        self.assertEqual(run.call_args_list[0].args[0][-1], 'D:/Papers')
        self.assertFalse(server.PICKER_LOCK.locked())

    def test_folder_picker_failure_releases_lock(self):
        with patch.object(server.subprocess, 'run', side_effect=subprocess.TimeoutExpired('picker', 180)):
            with self.assertRaisesRegex(ValueError, 'timed out'):
                server.choose_folder()
        self.assertFalse(server.PICKER_LOCK.locked())

    def test_expired_batch_record_is_looked_up_again(self):
        with tempfile.TemporaryDirectory(dir=server.ROOT) as folder:
            record={'sources':[{'name':'PubMed Central','url':'https://example.org'}], 'doi':'10.1234/refresh','csl':{'title':'Refreshed paper'}}
            with patch.object(server, 'lookup', return_value=record) as lookup, patch.object(server, 'find_pdf', return_value=(b'%PDF-test', 'https://example.org/p.pdf')):
                result=server.download({'key':'expired-key', 'doi':'10.1234/refresh', 'folder':folder})
            lookup.assert_called_once_with('10.1234/refresh')
            self.assertTrue(result['ok']); self.assertTrue(Path(result['path']).is_file())

    def test_doi_and_windows_paths(self):
        for value in ('10.1234/ABC.1', ' https://doi.org/10.1234/ABC.1 ', 'doi:10.1234/ABC.1', 'https://dx.doi.org/10.1234%2FABC.1'):
            self.assertEqual(server.doi_normalize(value), '10.1234/ABC.1')
        for value in ('D:/Papers', '"D:\\Papers"', "'D:/Papers'"):
            self.assertEqual(server.windows_folder(value), 'D:\\Papers')
        for value in ('relative/path', 'file:///D:/Papers', 'D:/CON', 'D:/bad?name', 'D:/trailing.'):
            with self.assertRaises(ValueError): server.windows_folder(value)

    def test_windows_safe_filename(self):
        self.assertEqual(server.filename('A: B / C?'), 'A_ B _ C_.pdf')
        self.assertEqual(server.filename('CON'), '_CON.pdf')
        self.assertLessEqual(len(server.filename('x'*400)),164)

    def test_reference_doi_does_not_override_paper(self):
        xml=b'''<PubmedArticleSet><PubmedArticle><MedlineCitation><Article><ArticleTitle>Target paper</ArticleTitle><Journal><Title>Test journal</Title></Journal></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1234/target</ArticleId><ArticleId IdType="pubmed">123</ArticleId><ArticleId IdType="pmc">PMC123</ArticleId></ArticleIdList><ReferenceList><Reference><ArticleIdList><ArticleId IdType="doi">10.9999/reference</ArticleId><ArticleId IdType="pubmed">999</ArticleId></ArticleIdList></Reference></ReferenceList></PubmedData></PubmedArticle></PubmedArticleSet>'''
        def fake_fetch(url,*args,**kwargs):
            if 'efetch' in url: return xml,url,'text/xml'
            return json.dumps({'type':'article-journal','title':'Target paper'}).encode(),url,'application/json'
        with patch.object(server,'getjson',return_value={'esearchresult':{'idlist':['123']}}),patch.object(server,'fetch',side_effect=fake_fetch):
            result=server.lookup('10.1234/target')
        self.assertEqual(result['pmid'],'123');self.assertEqual(result['pmc'],'PMC123')

    def test_login_html_is_not_saved_as_pdf(self):
        with patch.object(server,'fetch',return_value=(b'<html>Login</html>','https://example.org','text/html')):
            with self.assertRaises(ValueError): server.find_pdf('https://example.org')

    def test_pdf_meta_and_protocol_relative_link(self):
        calls=[]
        def fake(url,*args,**kwargs):
            calls.append(url)
            return (b'%PDF-1.7 test',url,'application/pdf') if len(calls)>1 else (b'<meta name="citation_pdf_url" content="//example.org/paper.pdf">',url,'text/html')
        with patch.object(server,'fetch',side_effect=fake):
            data,url=server.find_pdf('https://example.org/article')
        self.assertEqual(url,'https://example.org/paper.pdf');self.assertTrue(data.startswith(b'%PDF'))

    def test_origin_default_rejects_remote(self):
        handler=object.__new__(server.Handler)
        handler.server=type('FakeServer',(),{'server_port':8765})()
        handler.headers={'Origin':'https://untrusted.example'}
        self.assertFalse(handler.origin_ok())
        handler.headers={'Origin':'http://127.0.0.1:8765'}
        self.assertTrue(handler.origin_ok())

    def test_failed_sources_return_login_and_do_not_write(self):
        with tempfile.TemporaryDirectory(dir=server.ROOT) as folder:
            server.CACHE['failure-test']={'sources':[{'name':'PubMed Central','url':'https://example.org'}], 'publisher':'https://example.org/login','doi':'10.1234/test','csl':{'title':'Test'}}
            with patch.object(server,'discover_mirrors',return_value=([], ['Search unavailable'])), patch.object(server,'find_pdf',side_effect=ValueError('Login required')):
                result=server.download({'key':'failure-test','folder':folder})
            self.assertFalse(result['ok']);self.assertEqual(result['login'],'https://example.org/login')
            self.assertEqual(list(Path(folder).iterdir()),[])

    def test_duplicate_download_does_not_overwrite(self):
        with tempfile.TemporaryDirectory(dir=server.ROOT) as folder:
            server.CACHE['duplicate-test']={'sources':[{'name':'PubMed Central','url':'https://example.org'}], 'publisher':'https://example.org','doi':'10.1234/test','csl':{'title':'Test'}}
            with patch.object(server,'find_pdf',return_value=(b'%PDF-1.7 test','https://example.org/test.pdf')):
                a=server.download({'key':'duplicate-test','folder':folder})
                b=server.download({'key':'duplicate-test','folder':folder})
            self.assertNotEqual(a['path'],b['path']);self.assertTrue(Path(a['path']).exists());self.assertTrue(Path(b['path']).exists())

    def test_mirror_discovery_filters_and_unwraps_links(self):
        page=b'<a href="/url?q=https%3A%2F%2Fsci-hub.se%2F">Mirror</a><a href="https://sci-hub.se/x">Duplicate</a><a href="https://sci-hub.se.evil.example/">Fake</a><a href="http://sci-hub.ru">HTTP</a>'
        with patch.object(server, 'fetch', return_value=(page, 'https://www.google.com/search', 'text/html')), patch.object(server, 'safe_url', side_effect=lambda u:u):
            mirrors, errors=server.discover_mirrors()
        self.assertEqual(mirrors, ['https://sci-hub.se']); self.assertEqual(errors, [])

    def test_search_falls_back_after_blocked_engine(self):
        page=b'<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsci-hub.ru">Mirror</a>'
        with patch.object(server, 'fetch', side_effect=[ValueError('Blocked'), (page, '', 'text/html')]), patch.object(server, 'safe_url', side_effect=lambda u:u):
            mirrors, errors=server.discover_mirrors()
        self.assertEqual(mirrors, ['https://sci-hub.ru']); self.assertIn('Blocked', errors[0])

    def test_browser_search_fallback(self):
        page=b'<a href="https://sci-hub.se/">Mirror</a>'
        with patch.object(server, 'fetch', return_value=(b'<html>Verification</html>', '', 'text/html')), patch.object(server, 'browser_search', return_value=page) as browser, patch.object(server, 'safe_url', side_effect=lambda u:u):
            mirrors, errors=server.discover_mirrors()
        self.assertEqual(mirrors, ['https://sci-hub.se']); self.assertEqual(len(errors), 2)
        browser.assert_called_once()

    def test_databases_precede_publisher_and_try_next_mirror(self):
        with tempfile.TemporaryDirectory(dir=server.ROOT) as folder:
            server.CACHE['order-test']={'sources':[{'name':'PubMed Central','url':'https://example.org/pmc'}, {'name':'Publisher','url':'https://publisher.example'}], 'publisher':'https://publisher.example', 'doi':'10.1234/test','csl':{'title':'Test'}}
            with patch.object(server, 'discover_mirrors', return_value=(['https://sci-hub.se','https://sci-hub.ru'], [])), patch.object(server, 'find_pdf', side_effect=[ValueError('No PMC PDF'), ValueError('Mirror unavailable'), (b'%PDF-test', 'https://example.org/p.pdf')]) as find:
                result=server.download({'key':'order-test','folder':folder})
            self.assertTrue(result['ok']); self.assertEqual(result['source'], 'Sci-Hub')
            self.assertEqual([c.args[0] for c in find.call_args_list], ['https://example.org/pmc','https://sci-hub.se/10.1234/test','https://sci-hub.ru/10.1234/test'])

    def test_discovery_failure_offers_publisher_without_fetching_it(self):
        with tempfile.TemporaryDirectory(dir=server.ROOT) as folder:
            server.CACHE['publisher-test']={'sources':[{'name':'Publisher','url':'https://doi.org/10.1234/test'}], 'publisher':'https://doi.org/10.1234/test','doi':'10.1234/test','csl':{'title':'Test', 'URL':'https://publisher.example/article'}}
            with patch.object(server,'discover_mirrors',return_value=([], ['Search blocked'])), patch.object(server,'safe_url',side_effect=lambda u:u), patch.object(server,'find_pdf') as find:
                result=server.download({'key':'publisher-test','folder':folder})
            find.assert_not_called()
            self.assertFalse(result['ok']); self.assertEqual(len(result['publishers']),3)
            self.assertEqual(result['attempts'], ['Search blocked'])


if __name__=='__main__': unittest.main()
