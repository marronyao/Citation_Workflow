import json
import unittest
from unittest.mock import patch
import server
from pathlib import Path
import tempfile


class CoreTests(unittest.TestCase):
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
            server.CACHE['failure-test']={'sources':[{'name':'Publisher','url':'https://example.org'}], 'publisher':'https://example.org/login','doi':'10.1234/test','csl':{'title':'Test'}}
            with patch.object(server,'find_pdf',side_effect=ValueError('Login required')):
                result=server.download({'key':'failure-test','folder':folder})
            self.assertFalse(result['ok']);self.assertEqual(result['login'],'https://example.org/login')
            self.assertEqual(list(Path(folder).iterdir()),[])

    def test_duplicate_download_does_not_overwrite(self):
        with tempfile.TemporaryDirectory(dir=server.ROOT) as folder:
            server.CACHE['duplicate-test']={'sources':[{'name':'Publisher','url':'https://example.org'}], 'publisher':'https://example.org','doi':'10.1234/test','csl':{'title':'Test'}}
            with patch.object(server,'find_pdf',return_value=(b'%PDF-1.7 test','https://example.org/test.pdf')):
                a=server.download({'key':'duplicate-test','folder':folder})
                b=server.download({'key':'duplicate-test','folder':folder})
            self.assertNotEqual(a['path'],b['path']);self.assertTrue(Path(a['path']).exists());self.assertTrue(Path(b['path']).exists())


if __name__=='__main__': unittest.main()
