import json
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch
import server
from paper_metadata import MetadataClient, identifier
from fulltext_sources import SourceRouter, BRANDS, host_matches


def crossref(doi='10.1234/test',kind='journal-article'):
    return {'message':{'DOI':doi,'type':kind,'title':['Target paper'],'container-title':['Conference Proceedings' if kind=='proceedings-article' else 'Nature Neuroscience'],'short-container-title':['Nat Neurosci'],'author':[{'family':'Yao','given':'Zihao'}],'published':{'date-parts':[[2026]]},'page':'1-4','URL':'https://www.nature.com/articles/test'}}


def router(**kwargs):
    args={'fetch':Mock(),'getjson':Mock(),'safe_url':lambda url:url,'browser_search':Mock(),'find_pdf':Mock(),'budget':lambda seconds:nullcontext()};args.update(kwargs)
    return SourceRouter(**args)


class MetadataTests(unittest.TestCase):
    def test_no_pubmed_requests_and_standard_abbreviation(self):
        fetch=Mock(side_effect=AssertionError('No extra metadata fetch expected'))
        getjson=Mock(return_value=crossref())
        paper=MetadataClient(fetch,getjson).resolve('10.1234/test')
        self.assertEqual(paper['csl']['container-title-short'],'Nat Neurosci')
        self.assertEqual(paper['kind'],'journal')
        self.assertTrue(all('pubmed' not in c.args[0] and 'eutils' not in c.args[0] for c in getjson.call_args_list))
        fetch.assert_not_called()

    def test_conference_type_and_proceedings_are_preserved(self):
        paper=MetadataClient(Mock(),Mock(return_value=crossref(kind='proceedings-article'))).resolve('10.1234/test')
        self.assertEqual(paper['kind'],'conference');self.assertEqual(paper['csl']['type'],'paper-conference')
        self.assertEqual(paper['csl']['container-title'],'Conference Proceedings')

    def test_identifier_versions_and_lookalikes(self):
        self.assertEqual(identifier('https://arxiv.org/pdf/1706.03762v1.pdf'),'arxiv:1706.03762v1')
        self.assertEqual(identifier('arXiv:hep-th/0601001v2'),'arxiv:hep-th/0601001v2')
        self.assertEqual(identifier('https://www.medrxiv.org/content/10.1101/2020.01.01.123456v2.full.pdf'),'https://www.medrxiv.org/content/10.1101/2020.01.01.123456v2')
        for url in ('https://arxiv.org.evil.example/abs/1706.03762','https://user@arxiv.org/abs/1706.03762'):
            with self.assertRaises(ValueError):identifier(url)

    def test_arxiv_requested_version_and_published_doi_are_not_substituted(self):
        xml=b'''<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/1706.03762v1</id><title>Attention Is All You Need</title><published>2017-06-12T00:00:00Z</published><summary>Paper summary</summary><author><name>Ashish Vaswani</name></author><arxiv:doi>10.9999/published</arxiv:doi></entry></feed>'''
        client=MetadataClient(Mock(return_value=(xml,'','text/xml')),Mock())
        paper=client.resolve('arxiv:1706.03762v1')
        self.assertEqual(paper['doi'],'10.48550/arXiv.1706.03762');self.assertEqual(paper['version'],'1')
        self.assertTrue(paper['sources'][0]['url'].endswith('v1'))
        with self.assertRaisesRegex(ValueError,'version'):client.resolve('arxiv:1706.03762v2')

    def test_biorxiv_and_medrxiv_resolve_exact_version(self):
        for platform in ('biorxiv','medrxiv'):
            items=[{'doi':'10.1101/2020.01.01.123456','title':'Target preprint','authors':'Doe, Jane; Yao, Zihao','date':'2020-01-01','version':v} for v in ('1','2')]
            client=MetadataClient(Mock(),Mock(return_value={'collection':items}))
            paper=client.resolve(f'https://www.{platform}.org/content/10.1101/2020.01.01.123456v1')
            self.assertEqual(paper['version'],'1');self.assertEqual(paper['kind'],'preprint')
            self.assertTrue(paper['sources'][0]['url'].endswith('v1.full.pdf'))

    def test_chemrxiv_datacite_metadata_and_pdf(self):
        doi='10.26434/chemrxiv-2026-test-v1'
        data={'data':{'attributes':{'doi':doi,'types':{'resourceTypeGeneral':'Preprint'},'titles':[{'title':'Chemical preprint'}],'creators':[{'givenName':'Jane','familyName':'Doe'}],'publicationYear':2026,'publisher':'ChemRxiv','url':'https://chemrxiv.org/engage/chemrxiv/article-details/'+'a'*24,'contentUrl':'https://chemrxiv.org/paper.pdf','version':'1'}}}
        client=MetadataClient(Mock(),Mock(side_effect=[ValueError('Not Crossref'),data]))
        paper=client.resolve(doi)
        self.assertEqual(paper['platform'],'ChemRxiv');self.assertEqual(paper['kind'],'preprint')
        self.assertTrue(any(source['url'].endswith('paper.pdf') for source in paper['sources']))

    def test_no_doi_conference_page_metadata(self):
        page=b'<meta name="citation_title" content="A conference paper"><meta name="citation_author" content="Jane Doe"><meta name="citation_publication_date" content="2026/07/01"><meta name="citation_conference_title" content="Proceedings of ICML"><meta name="citation_pdf_url" content="paper.pdf">'
        url='https://proceedings.mlr.press/v200/test.html'
        paper=MetadataClient(Mock(return_value=(page,url,'text/html')),Mock()).resolve(url)
        self.assertEqual(paper['doi'],'');self.assertEqual(paper['csl']['type'],'paper-conference')
        self.assertEqual(paper['sources'][0]['url'],'https://proceedings.mlr.press/v200/paper.pdf')

    def test_wrong_doi_metadata_is_rejected(self):
        client=MetadataClient(Mock(side_effect=ValueError('No DOI record')),Mock(side_effect=[crossref(doi='10.9999/other'),ValueError('Not found')]))
        with self.assertRaises(ValueError):client.resolve('10.1234/test')


class SourceTests(unittest.TestCase):
    def test_all_requested_databases_and_preprint_priority(self):
        r=router();paper={'doi':'10.1234/test','csl':{},'kind':'journal','sources':[]}
        self.assertEqual(r.plan(paper),['PubMed Central','Sci-Hub','ResearchGate','Z-Library','Library Genesis',"Anna's Archive"])
        paper.update({'kind':'preprint','sources':[{'name':'arXiv','url':'https://arxiv.org/pdf/1234.12345'}]})
        self.assertEqual(r.plan(paper)[0],'arXiv');self.assertNotIn('PubMed Central',r.plan(paper))

    def test_pmc_cloud_exact_doi_and_deposited_article_preference(self):
        def getjson(url):
            if 'idconv' in url:
                return {'records':[{'doi':'10.9999/wrong','pmcid':'PMC1'},{'doi':'10.1234/test','pmcid':'PMC2'}]}
            if url.endswith('PMC2.1.json'):return {'doi':'10.1234/test','pdf_url':'s3://pmc-oa-opendata/PMC2.1/manuscript.pdf','is_manuscript':'yes'}
            if url.endswith('PMC2.2.json'):return {'doi':'10.1234/test','pdf_url':'s3://pmc-oa-opendata/PMC2.2/article.pdf','is_manuscript':'no'}
            return {'doi':'10.9999/other','pdf_url':'s3://pmc-oa-opendata/PMC2.3/wrong.pdf'}
        fetch=Mock(return_value=(b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Contents><Key>metadata/PMC2.1.json</Key></Contents><Contents><Key>metadata/PMC2.2.json</Key></Contents><Contents><Key>metadata/PMC2.3.json</Key></Contents></ListBucketResult>','','text/xml'))
        r=router(getjson=Mock(side_effect=getjson),fetch=fetch)
        sources,_=r.candidates('PubMed Central',{'doi':'10.1234/test','csl':{},'sources':[]})
        self.assertEqual(len(sources),2);self.assertTrue(sources[0]['url'].endswith('article.pdf'))
        self.assertTrue(sources[1]['url'].endswith('manuscript.pdf'))
        self.assertTrue(all('pubmed' not in call.args[0] and 'oa.fcgi' not in call.args[0] for call in r.getjson.call_args_list))

    def test_dynamic_mirrors_unwrap_search_and_reject_lookalikes(self):
        for name,domain in [('Sci-Hub','sci-hub.se'),('Z-Library','z-lib.sk'),('Library Genesis','libgen.is'),("Anna's Archive",'annas-archive.org')]:
            page=f'<a href="/url?q=https%3A%2F%2F{domain}%2F">Mirror</a><a href="https://{domain}.evil.example/">Fake</a>'.encode()
            r=router(fetch=Mock(return_value=(page,'','text/html')))
            origins,_=r.discover(name);self.assertEqual(origins,['https://'+domain])
            self.assertFalse(host_matches('https://'+domain+'.evil.example',BRANDS[name]))
            self.assertFalse(host_matches('https://user@'+domain,BRANDS[name]))

    def test_browser_fallback_after_search_verification(self):
        r=router(fetch=Mock(return_value=(b'<html>Verification</html>','','text/html')),browser_search=Mock(return_value=b'<a href="https://z-lib.sk/">Mirror</a>'))
        origins,errors=r.discover('Z-Library');self.assertEqual(origins,['https://z-lib.sk']);self.assertTrue(errors)
        r.browser_search.assert_called_once()

    def test_rss_search_fallback_and_dead_mirror_do_not_hide_other_results(self):
        rss=b'<rss><channel><item><link>https://sci-hub.dead/</link></item><item><link>https://sci-hub.ru/index</link></item></channel></rss>'
        def validate(url):
            if 'dead' in url:raise ValueError('DNS unavailable')
            return url
        r=router(fetch=Mock(side_effect=[(b'<html>Verification</html>','','text/html'),(b'<html>Verification</html>','','text/html'),(rss,'','text/xml')]),safe_url=validate)
        mirrors,errors=r.discover('Sci-Hub')
        self.assertEqual(mirrors,['https://sci-hub.ru']);self.assertTrue(any('DNS unavailable' in error for error in errors));r.browser_search.assert_not_called()

    def test_provider_failure_does_not_skip_other_databases_or_fetch_publisher(self):
        r=router(find_pdf=Mock(side_effect=[ValueError('Verification'),(b'%PDF-test','https://example.org/good.pdf')]))
        paper={'doi':'10.1234/test','csl':{},'kind':'journal','publisher':'https://publisher.example','sources':[]}
        def candidates(name,record):return ([{'name':name,'url':'https://example.org/'+name}] if name in ('Sci-Hub','ResearchGate') else []),[]
        with patch.object(r,'candidates',side_effect=candidates):result=r.retrieve(paper)
        self.assertTrue(result['ok']);self.assertEqual(result['source'],'ResearchGate')
        self.assertFalse(any('publisher' in call.args[0] for call in r.find_pdf.call_args_list))

    def test_cooldown_is_reported_and_retried_after_expiry(self):
        import time
        r=router();r.health['Sci-Hub']={'retry_after':time.monotonic()+90}
        paper={'doi':'10.1234/test','csl':{},'kind':'journal','sources':[]}
        with patch.object(r,'candidates',return_value=([],[])) as candidates:
            result=r.retrieve(paper)
        self.assertTrue(any('Sci-Hub: temporarily unavailable' in message for message in result['attempts']))
        self.assertNotIn('Sci-Hub',[c.args[0] for c in candidates.call_args_list])
        r.health['Sci-Hub']['retry_after']=0
        with patch.object(r,'candidates',return_value=([],[])) as candidates:r.retrieve(paper)
        self.assertIn('Sci-Hub',[c.args[0] for c in candidates.call_args_list])


class CacheAndDownloadTests(unittest.TestCase):
    def setUp(self):
        self.key='retrieval-test';server.CACHE[self.key]={'key':self.key,'identifier':'10.1234/test','doi':'10.1234/test','csl':{'title':'Target paper'},'publisher':'https://www.nature.com/articles/test','sources':[]}
    def tearDown(self):
        with server.PDF_CACHE_LOCK:
            for item in server.PDF_CACHE.values():item['file'].close()
            server.PDF_CACHE.clear()
        server.CACHE.pop(self.key,None)

    def test_search_caches_pdf_and_duplicate_saves_do_not_overwrite(self):
        with patch.object(server.SOURCE_ROUTER,'retrieve',return_value={'ok':True,'pdf':b'%PDF-test','source':'PMC','url':'https://example.org/p.pdf','attempts':[]}) as retrieve:
            first=server.search_fulltext({'key':self.key});second=server.search_fulltext({'key':self.key})
            self.assertTrue(first['ok']);self.assertNotIn('pdf',first);self.assertNotIn('pdf',second)
            with tempfile.TemporaryDirectory(dir=server.ROOT) as folder:
                a=server.download({'key':self.key,'folder':folder});b=server.download({'key':self.key,'folder':folder})
                self.assertNotEqual(a['path'],b['path']);self.assertEqual(Path(a['path']).read_bytes(),b'%PDF-test')
            retrieve.assert_called_once()

    def test_failure_returns_official_options_and_writes_nothing(self):
        with patch.object(server.SOURCE_ROUTER,'retrieve',return_value={'ok':False,'attempts':['All sources unavailable']}),patch.object(server,'safe_url',side_effect=lambda url:url):
            with tempfile.TemporaryDirectory(dir=server.ROOT) as folder:
                result=server.download({'key':self.key,'folder':folder})
                self.assertFalse(result['ok']);self.assertEqual(list(Path(folder).iterdir()),[])
        self.assertTrue(any('Nature' in p['name'] for p in result['publishers']))

    def test_expired_metadata_is_refreshed_with_exact_version_identifier(self):
        with patch.object(server,'lookup',return_value=server.CACHE[self.key]) as lookup,patch.object(server,'cached_pdf',return_value={'pdf':b'%PDF-test','source':'arXiv','ok':True}):
            with tempfile.TemporaryDirectory(dir=server.ROOT) as folder:
                result=server.download({'key':'expired','identifier':'arxiv:1706.03762v1','folder':folder})
        self.assertTrue(result['ok']);lookup.assert_called_once_with('arxiv:1706.03762v1')

    def test_different_doi_page_is_not_saved(self):
        page=b'<meta name="citation_doi" content="10.9999/wrong"><meta name="citation_pdf_url" content="paper.pdf">'
        with patch.object(server,'fetch',return_value=(page,'https://example.org','text/html')) as fetch:
            with self.assertRaisesRegex(ValueError,'different DOI'):server.find_pdf('https://example.org',record=server.CACHE[self.key])
        fetch.assert_called_once()

    def test_request_budget_stops_expired_search(self):
        with server.request_budget(0):
            with self.assertRaises(TimeoutError):server.remaining_timeout()

