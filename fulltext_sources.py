"""Bounded full-text routing, public repository search and mirror discovery."""
import html
import re
import threading
import time
import urllib.parse as U
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

BRANDS={
    'Sci-Hub':r'(?:www\.)?sci-hub\.[a-z]{2,12}',
    'Z-Library':r'(?:www\.)?(?:z-lib|z-library|zlibrary|singlelogin|[1-9]lib)\.[a-z]{2,12}',
    'Library Genesis':r'(?:www\.)?(?:libgen|librarygenesis)\.[a-z]{2,12}',
    "Anna's Archive":r'(?:www\.)?annas-archive\.[a-z]{2,12}',
}
CONFERENCE_REPOS={
    'NeurIPS':('proceedings.neurips.cc',r'neurips|neural information processing'),
    'PMLR':('proceedings.mlr.press',r'icml|aistats|machine learning research|learning theory'),
    'CVF Open Access':('openaccess.thecvf.com',r'cvpr|iccv|eccv|computer vision'),
    'ACL Anthology':('aclanthology.org',r'\bacl\b|emnlp|naacl|computational linguistics'),
}


class Anchors(HTMLParser):
    def __init__(self):
        super().__init__();self.urls=[]
    def handle_starttag(self,tag,attrs):
        if tag=='a':self.urls.append(dict(attrs).get('href',''))


def search_url(href):
    href=html.unescape(href)
    p=U.urlsplit(href);q=U.parse_qs(p.query)
    if p.path in ('/url','/l/') or p.hostname in ('www.google.com','google.com','duckduckgo.com','www.duckduckgo.com'):
        href=(q.get('uddg') or q.get('q') or q.get('url') or [href])[0]
    return href


def host_matches(url, pattern):
    p=U.urlsplit(url)
    return p.scheme=='https' and not p.username and not p.password and p.port in (None,443) and re.fullmatch(pattern,p.hostname or '') is not None


class SourceRouter:
    def __init__(self,fetch,getjson,safe_url,browser_search,find_pdf,budget):
        self.fetch=fetch;self.getjson=getjson;self.safe_url=safe_url;self.browser_search=browser_search;self.find_pdf=find_pdf;self.budget=budget
        self.mirrors={};self.health={};self.lock=threading.Lock()

    def web_search(self,query,pattern,limit=3):
        errors=[]
        engines=('https://www.google.com/search?q=','https://html.duckduckgo.com/html/?q=')
        searches=[(False,engine) for engine in engines]+[('rss','https://www.bing.com/search?format=rss&q=')]+[(True,engine) for engine in engines]
        for rendered,engine in searches:
                try:
                    url=engine+U.quote(query)
                    data=self.browser_search(url) if rendered is True else self.fetch(url,'application/rss+xml' if rendered=='rss' else 'text/html')[0]
                    if rendered=='rss':hrefs=[node.text or '' for node in ET.fromstring(data).findall('.//item/link')]
                    else:
                        links=Anchors();links.feed(data.decode('utf-8','replace'));hrefs=links.urls
                    urls=[]
                    for href in hrefs:
                        try:
                            target=search_url(href)
                            if host_matches(target,pattern):
                                self.safe_url(target)
                                if target not in urls:urls.append(target)
                                if len(urls)>=limit:break
                        except Exception as error:errors.append(str(error))
                    if urls:return urls[:limit],errors
                    errors.append('Search returned no eligible links; verification or search indexing may limit discovery.')
                except Exception as error:
                    errors.append(str(error))
        return [],list(dict.fromkeys(errors))

    def discover(self,name):
        now=time.monotonic()
        with self.lock:cached=self.mirrors.get(name)
        if cached and cached[0]>now:return cached[1],cached[2]
        term='libgen' if name=='Library Genesis' else name
        urls,errors=self.web_search('"'+term+'"',BRANDS[name])
        origins=list(dict.fromkeys('https://'+U.urlsplit(url).hostname for url in urls))
        with self.lock:self.mirrors[name]=(now+(900 if origins else 90),origins,errors)
        return origins,errors

    def plan(self,record):
        plan=list(dict.fromkeys(source['name'] for source in record.get('sources',[])))
        if record.get('doi') and record.get('kind')!='preprint':plan.append('PubMed Central')
        if record.get('kind')=='conference':
            title=record['csl'].get('container-title','')+' '+record['csl'].get('event-title','')
            plan.extend(name for name,(_,pattern) in CONFERENCE_REPOS.items() if re.search(pattern,title,re.I))
        names=['Sci-Hub','ResearchGate','Z-Library','Library Genesis',"Anna's Archive"]
        if not record.get('doi'):names.remove('Sci-Hub')
        with self.lock: names.sort(key=lambda name:(self.health.get(name,{}).get('retry_after',0)>time.monotonic(),-self.health.get(name,{}).get('successes',0)))
        plan.extend(name for name in names if name not in plan)
        return plan

    def candidates(self,name,record):
        known=[s for s in record.get('sources',[]) if s['name']==name]
        if known:return known,[]
        doi=record.get('doi','');query=doi or record['csl']['title']
        if name=='PubMed Central':
            data=self.getjson('https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?'+U.urlencode({'ids':doi,'idtype':'doi','format':'json','tool':'CitationWorkflow'}))
            rows=[r for r in data.get('records',[]) if r.get('doi','').lower()==doi.lower() and re.fullmatch(r'PMC\d+',r.get('pmcid','')) and r.get('live') is not False and str(r.get('live','')).lower()!='false']
            sources=[]
            for row in rows:
                bucket='https://pmc-oa-opendata.s3.amazonaws.com/'
                xml=self.fetch(bucket+'?'+U.urlencode({'list-type':2,'prefix':'metadata/'+row['pmcid']+'.','max-keys':20}))[0]
                keys=[node.text for node in ET.fromstring(xml).findall('.//{*}Key') if re.fullmatch(r'metadata/'+re.escape(row['pmcid'])+r'\.\d+\.json',node.text or '')]
                versions=[]
                for key in keys[:8]:
                    meta=self.getjson(bucket+U.quote(key,safe='/'))
                    if str(meta.get('doi','')).lower()!=doi.lower() or not meta.get('pdf_url'):continue
                    url=meta['pdf_url'].replace('s3://pmc-oa-opendata/',bucket,1)
                    manuscript=str(meta.get('is_manuscript','')).lower() in ('yes','true','1')
                    versions.append({'name':name,'url':url,'trusted':True,'version_note':'PMC author manuscript' if manuscript else 'PMC deposited article','manuscript':manuscript})
                versions.sort(key=lambda source:source['manuscript'])
                sources.extend(versions)
            return sources,[]
        if name in CONFERENCE_REPOS or name=='ResearchGate':
            domain=CONFERENCE_REPOS[name][0] if name in CONFERENCE_REPOS else 'researchgate.net'
            title='"'+record['csl']['title']+'"'
            urls,errors=self.web_search('site:'+domain+' '+(query if name=='ResearchGate' else title),r'(?:[a-z0-9-]+\.)?'+re.escape(domain))
            return [{'name':name,'url':url,'trusted':name!='ResearchGate'} for url in urls],errors
        origins,errors=self.discover(name)
        if name=='Sci-Hub':paths=['/'+U.quote(doi,safe='/')]
        elif name=='Z-Library':paths=['/s/'+U.quote(query,safe='')+'?type=articles']
        elif name=='Library Genesis':paths=['/scimag/?'+U.urlencode({'q':query})]
        else:paths=['/search?'+U.urlencode({'q':query})]
        return [{'name':name,'url':origin+path,'trusted':False} for origin in origins[:2] for path in paths],errors

    def retrieve(self,record):
        attempts=[];plan=self.plan(record)
        for name in plan:
            with self.lock:state=dict(self.health.get(name,{}))
            if state.get('retry_after',0)>time.monotonic():
                attempts.append(name+': temporarily unavailable after a recent connection/verification failure; will retry automatically.');continue
            try:
                with self.budget(45):
                    sources,errors=self.candidates(name,record)
                    attempts.extend(name+': '+error for error in errors)
                    if not sources:
                        attempts.append(name+': no eligible full-text candidate discovered.')
                        if errors:
                            with self.lock:self.health[name]={**state,'retry_after':time.monotonic()+90}
                    for source in sources:
                        try:
                            pdf,url=self.find_pdf(source['url'],record=record,trusted=source.get('trusted',False))
                            attempts.append(name+': PDF retrieved.')
                            with self.lock:self.health[name]={'successes':state.get('successes',0)+1,'retry_after':0}
                            return {'ok':True,'pdf':pdf,'url':url,'source':name,'version_note':source.get('version_note',''),'attempts':attempts,'plan':plan}
                        except Exception as error:
                            attempts.append(name+': '+str(error))
                            if getattr(error,'code',None) in (403,429,503) or re.search(r'sign.in|verification',str(error),re.I):
                                with self.lock:self.health[name]={**state,'retry_after':time.monotonic()+90}
            except Exception as error:
                attempts.append(name+': '+str(error))
                if isinstance(error,(TimeoutError,ConnectionError)) or getattr(error,'code',None) in (403,429,503):
                    with self.lock:self.health[name]={**state,'retry_after':time.monotonic()+90}
        return {'ok':False,'attempts':attempts,'plan':plan}
