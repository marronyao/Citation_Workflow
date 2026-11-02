import json
import unittest
from unittest.mock import patch
import server
import subprocess


class CoreTests(unittest.TestCase):
    def test_example_doi_is_extracted_without_trailing_punctuation(self):
        example='Smith A. A complete journal reference. Journal 2026;1:2. https://doi.org/10.1234/example.'
        with patch.object(server,'lookup',return_value={'csl':{}}) as lookup:
            server.reference_example({'example':example})
        lookup.assert_called_once_with('10.1234/example')

    def test_example_without_doi_requires_unique_title_match(self):
        example='Smith A. A distinctive title about neuronal repair. Journal 2026;1:2.'
        found={'message':{'items':[{'DOI':'10.1234/example','title':['A distinctive title about neuronal repair']}, {'DOI':'10.1234/other','title':['An unrelated paper']}]}}
        with patch.object(server,'getjson',return_value=found), patch.object(server,'lookup',return_value={}) as lookup:
            server.reference_example({'example':example})
        lookup.assert_called_once_with('10.1234/example')
        found['message']['items'].append({'DOI':'10.1234/ambiguous','title':['A distinctive title about neuronal repair']})
        with patch.object(server,'getjson',return_value=found), patch.object(server,'lookup') as lookup:
            with self.assertRaisesRegex(ValueError,'reliably'):
                server.reference_example({'example':example})
            lookup.assert_not_called()

    def test_example_year_disambiguates_reprinted_article(self):
        example='Smith A. A distinctive title about neuronal repair. Journal 1952;1:2.'
        items=[{'DOI':doi,'title':['A distinctive title about neuronal repair'],'issued':{'date-parts':[[year]]}} for doi,year in [('10.1234/original',1952),('10.1234/reprint',1990)]]
        with patch.object(server,'getjson',return_value={'message':{'items':items}}), patch.object(server,'lookup',return_value={}) as lookup:
            server.reference_example({'example':example})
        lookup.assert_called_once_with('10.1234/original')


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


if __name__=='__main__': unittest.main()
