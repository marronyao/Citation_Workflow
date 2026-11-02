"""DOI, conference and version-aware preprint metadata. No PubMed queries."""
import html
import re
import urllib.parse as U
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

ARXIV_ID = r'(?:\d{4}\.\d{4,5}|[a-z][a-z.-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?'
PREPRINT_HOSTS = {'www.biorxiv.org':'bioRxiv', 'biorxiv.org':'bioRxiv', 'www.medrxiv.org':'medRxiv', 'medrxiv.org':'medRxiv', 'chemrxiv.org':'ChemRxiv', 'www.chemrxiv.org':'ChemRxiv'}
CONFERENCE_HOSTS = {'proceedings.neurips.cc':'NeurIPS','proceedings.mlr.press':'PMLR','openaccess.thecvf.com':'CVF Open Access','aclanthology.org':'ACL Anthology'}


def clean(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', '', str(value or '')))).strip()


def identifier(value):
    value = U.unquote(str(value).strip().strip('\"\'').strip())
    raw = re.sub(r'^(?:arxiv:\s*|https?://(?:export\.)?arxiv\.org/(?:abs|pdf|html)/)', '', value, flags=re.I)
    raw = re.sub(r'\.pdf$', '', raw.split('?')[0])
    if re.fullmatch(ARXIV_ID, raw, re.I):
        return 'arxiv:'+raw
    if value.startswith(('https://','http://')):
        parsed = U.urlsplit(value)
        if parsed.username or parsed.password or parsed.port not in (None,80,443):
            raise ValueError('Use a public article link without credentials or a custom port.')
        if parsed.hostname in CONFERENCE_HOSTS:
            return 'https://'+parsed.hostname+parsed.path
        if parsed.hostname in PREPRINT_HOSTS:
            if parsed.hostname.endswith('chemrxiv.org') and re.fullmatch(r'/doi/(?:full/|pdf/|abs/)?10\.26434/[^\s<>"\']+',parsed.path):
                return parsed.path[parsed.path.index('10.26434/'):]
            if parsed.hostname.endswith(('biorxiv.org','medrxiv.org')) and re.fullmatch(r'/content/10\.1101/[^\s<>"\']+', parsed.path):
                return 'https://'+parsed.hostname+parsed.path.removesuffix('.full.pdf').removesuffix('.full').rstrip('/')
            if parsed.hostname.endswith('chemrxiv.org') and re.fullmatch(r'/engage/chemrxiv/article-details/[a-f0-9]{24}', parsed.path):
                return 'https://chemrxiv.org'+parsed.path
    doi = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi\s*:\s*)', '', value, flags=re.I)
    if re.fullmatch(r'10\.\d{4,9}/[^\s<>"\']+', doi, re.I):
        return doi
    raise ValueError('Enter a DOI, arXiv ID, preprint link, or NeurIPS/PMLR/CVF/ACL paper link.')


class PageMetadata(HTMLParser):
    def __init__(self):
        super().__init__(); self.meta={}
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag=='meta':
            key=(a.get('name') or a.get('property') or '').lower()
            self.meta.setdefault(key,[]).append(a.get('content',''))
    def first(self,key):
        return next(iter(self.meta.get(key,[])), '')


def crossref_csl(item):
    types={'proceedings-article':'paper-conference','posted-content':'article','journal-article':'article-journal'}
    event=item.get('event') or {}
    c={'type':types.get(item.get('type'),'article-journal'), 'title':clean(next(iter(item.get('title') or []),'')),
       'author':item.get('author',[]), 'container-title':clean(next(iter(item.get('container-title') or []),'')),
       'container-title-short':next(iter(item.get('short-container-title') or []),''), 'publisher':item.get('publisher',''),
       'issued':item.get('published') or item.get('issued') or {}, 'volume':item.get('volume',''), 'issue':item.get('issue',''),
       'page':item.get('page') or item.get('article-number',''), 'URL':item.get('URL',''), 'DOI':item.get('DOI','')}
    if event:
        c.update({'event-title':event.get('name',''),'event-place':event.get('location','')})
    if item.get('type')=='posted-content': c['genre']='Preprint'
    return c


def datacite_csl(a):
    kind=a.get('types',{}).get('resourceTypeGeneral','')
    authors=[]
    for person in a.get('creators',[]):
        authors.append({'family':person['familyName'],'given':person.get('givenName','')} if person.get('familyName') else {'literal':person.get('name','')})
    year=a.get('publicationYear')
    return {'type':'paper-conference' if kind in ('ConferencePaper','ConferenceProceeding') else 'article' if kind=='Preprint' else 'article-journal',
            'title':clean(next(iter(a.get('titles') or [{}]),{}).get('title','')), 'author':authors,
            'issued':{'date-parts':[[int(year)]]} if year else {}, 'publisher':a.get('publisher',''), 'URL':a.get('url',''),
            'genre':'Preprint' if kind=='Preprint' else '', 'DOI':a.get('doi',''), 'version':a.get('version','')}


class MetadataClient:
    def __init__(self, fetch, getjson):
        self.fetch=fetch; self.getjson=getjson

    def resolve(self, value):
        value=identifier(value)
        if value.startswith('arxiv:') or value.lower().startswith('10.48550/arxiv.'):
            return self.arxiv(value.split(':',1)[1] if value.startswith('arxiv:') else value.split('/',1)[1][6:])
        host=U.urlsplit(value).hostname
        if host in CONFERENCE_HOSTS:
            return self.conference(value)
        if host in PREPRINT_HOSTS:
            if host.endswith(('biorxiv.org','medrxiv.org')):
                server='biorxiv' if 'biorxiv' in host else 'medrxiv'
                doi=value.split('/content/',1)[1]
                version=re.search(r'v(\d+)$',doi)
                return self.bio(doi[:version.start()] if version else doi, server, version.group(1) if version else None)
            data,_,_=self.fetch(value,'text/html')
            meta=PageMetadata();meta.feed(data.decode('utf-8','replace'))
            doi=meta.first('citation_doi') or meta.first('dc.identifier')
            if not doi: raise ValueError('The ChemRxiv page did not expose a DOI. Paste its DOI to continue.')
            return self.doi(identifier(doi))
        return self.doi(value)

    def doi(self, doi):
        warnings=[];csl=None; crossref={}; datacite={}
        try:
            crossref=self.getjson('https://api.crossref.org/works/'+U.quote(doi,safe=''))['message']
            if crossref.get('DOI','').lower()!=doi.lower(): raise ValueError('The metadata DOI did not match.')
            csl=crossref_csl(crossref)
        except Exception:
            try:
                datacite=self.getjson('https://api.datacite.org/dois/'+U.quote(doi,safe=''))['data']['attributes']
                if datacite.get('doi','').lower()!=doi.lower(): raise ValueError('The metadata DOI did not match.')
                csl=datacite_csl(datacite)
            except Exception:
                try:
                    csl=__import__('json').loads(self.fetch('https://doi.org/'+U.quote(doi,safe='/'),'application/vnd.citationstyles.csl+json')[0])
                    if csl.get('DOI',doi).lower()!=doi.lower(): raise ValueError('The metadata DOI did not match.')
                except Exception:
                    pass
        if not csl or not csl.get('title'): raise ValueError('No metadata found. Check the identifier or try again later.')
        csl['title']=clean(csl['title']);csl.update({'id':doi,'DOI':doi})
        landing=csl.get('URL') or 'https://doi.org/'+doi
        kind='conference' if csl.get('type')=='paper-conference' else 'preprint' if csl.get('genre')=='Preprint' else 'journal'
        platform='ChemRxiv' if doi.lower().startswith('10.26434/chemrxiv') or 'chemrxiv.org' in landing else ''
        if doi.startswith('10.1101/'):
            for server in ('biorxiv','medrxiv'):
                try: return self.bio(doi,server)
                except Exception: continue
            kind='preprint';warnings.append('The bioRxiv/medRxiv version service was unavailable; using DOI metadata.')
        if platform: kind='preprint'
        if kind=='preprint':
            csl.update({'type':'article','genre':'Preprint','publisher':platform or csl.get('publisher','')})
            version=re.search(r'-v(\d+)$',doi)
            if version:csl['version']=version.group(1)
        official=[]
        if kind=='preprint' and platform=='ChemRxiv': official=[{'name':platform,'url':'https://chemrxiv.org/doi/pdf/'+doi,'trusted':True},{'name':platform,'url':landing,'trusted':True}]
        content_urls=datacite.get('contentUrl') or []
        if isinstance(content_urls,str):content_urls=[content_urls]
        for url in content_urls:
            if isinstance(url,str) and '.pdf' in url.lower() and kind=='preprint': official.append({'name':platform or 'Preprint repository','url':url,'trusted':True})
        # Non-publisher repositories explicitly deposited in registration metadata.
        for item in crossref.get('link',[]):
            url=item.get('URL','')
            if U.urlsplit(url).hostname in ('arxiv.org','www.biorxiv.org','www.medrxiv.org','chemrxiv.org','proceedings.neurips.cc','proceedings.mlr.press','openaccess.thecvf.com','aclanthology.org'):
                official.append({'name':'Repository','url':url,'trusted':True})
        return {'identifier':doi,'doi':doi,'csl':csl,'kind':kind,'platform':platform,'version':str(csl.get('version','')),'publisher':landing,'sources':official,'warnings':warnings,'metadata_source':'Crossref' if crossref else 'DataCite' if datacite else 'DOI registration'}

    def conference(self,url):
        data,final,_=self.fetch(url,'text/html')
        page=PageMetadata();page.feed(data.decode('utf-8','replace'))
        title=clean(page.first('citation_title'))
        if not title:raise ValueError('No paper metadata on this conference page. Use the individual paper page or its DOI.')
        authors=[]
        for name in page.meta.get('citation_author',[]):
            parts=clean(name).split(', ',1)
            if len(parts)==2:authors.append({'family':parts[0],'given':parts[1]})
            else:
                parts=clean(name).rsplit(' ',1)
                authors.append({'given':parts[0],'family':parts[1]} if len(parts)==2 else {'literal':parts[0]})
        date=re.findall(r'\d+',page.first('citation_publication_date') or page.first('citation_date'))[:3]
        doi=page.first('citation_doi');platform=CONFERENCE_HOSTS[U.urlsplit(url).hostname]
        csl={'id':doi or url,'DOI':doi,'type':'paper-conference','title':title,'author':authors,'issued':{'date-parts':[[int(x) for x in date]]} if date else {},
             'container-title':page.first('citation_conference_title') or page.first('citation_journal_title') or platform,
             'publisher':page.first('citation_publisher') or platform,'URL':url,'volume':page.first('citation_volume'),
             'page':'-'.join(filter(None,[page.first('citation_firstpage'),page.first('citation_lastpage')]))}
        pdf=page.first('citation_pdf_url')
        return {'identifier':url,'doi':doi,'csl':csl,'kind':'conference','platform':platform,'version':'','publisher':url,
                'sources':[{'name':platform,'url':U.urljoin(final,pdf) if pdf else url,'trusted':True}], 'warnings':[],'metadata_source':platform}

    def arxiv(self, arxiv_id):
        data,_,_=self.fetch('https://export.arxiv.org/api/query?'+U.urlencode({'id_list':arxiv_id,'max_results':1}),'application/atom+xml')
        tree=ET.fromstring(data);ns={'a':'http://www.w3.org/2005/Atom'};entry=tree.find('a:entry',ns)
        if entry is None: raise ValueError('No arXiv record found.')
        text=lambda path: clean(entry.findtext(path,'',ns))
        resolved=text('a:id').split('/abs/')[-1]
        if not re.fullmatch(ARXIV_ID,resolved,re.I) or re.sub(r'v\d+$','',resolved).lower()!=re.sub(r'v\d+$','',arxiv_id).lower(): raise ValueError('The arXiv identifier did not match.')
        if re.search(r'v\d+$',arxiv_id) and resolved.lower()!=arxiv_id.lower(): raise ValueError('The requested arXiv version was not returned.')
        authors=[]
        for node in entry.findall('a:author',ns):
            parts=clean(node.findtext('a:name','',ns)).rsplit(' ',1)
            authors.append({'given':parts[0],'family':parts[1]} if len(parts)==2 else {'literal':parts[0]})
        date=[int(x) for x in text('a:published')[:10].split('-')];version=re.search(r'v(\d+)$',resolved)
        doi='10.48550/arXiv.'+re.sub(r'v\d+$','',resolved)
        url='https://arxiv.org/abs/'+resolved
        csl={'id':'arxiv:'+resolved,'DOI':doi,'type':'article','genre':'Preprint','title':text('a:title'),'author':authors,'issued':{'date-parts':[date]},'publisher':'arXiv','archive':'arXiv','archive_location':resolved,'number':resolved,'URL':url,'version':version.group(1) if version else ''}
        warnings=['This record is an arXiv preprint; its identifier and version are preserved.']
        if re.search(r'withdrawn|retracted',text('a:summary'),re.I): warnings.append('The arXiv record contains a withdrawal/retraction notice. Review the repository page.')
        return {'identifier':'arxiv:'+resolved,'doi':doi,'csl':csl,'kind':'preprint','platform':'arXiv','version':csl['version'],'publisher':url,'sources':[{'name':'arXiv','url':'https://arxiv.org/pdf/'+resolved,'trusted':True}],'warnings':warnings,'metadata_source':'arXiv'}

    def bio(self, doi, server, version=None):
        result=self.getjson(f'https://api.biorxiv.org/details/{server}/'+U.quote(doi,safe='/')+'/na/json')
        items=[item for item in result.get('collection',[]) if item.get('doi','').lower()==doi.lower() and (not version or str(item.get('version'))==str(version))]
        if not items: raise ValueError('No matching preprint/version on '+server+'.')
        item=max(items,key=lambda item:int(item.get('version',0)))
        version=str(item.get('version','1')); platform='bioRxiv' if server=='biorxiv' else 'medRxiv'
        url=f'https://www.{server}.org/content/{doi}v{version}'
        authors=[]
        for author in item.get('authors','').split(';'):
            parts=author.strip().rsplit(', ',1)
            if len(parts)==2: authors.append({'family':parts[0],'given':parts[1]})
            elif parts[0]: authors.append({'literal':parts[0]})
        date=[int(x) for x in item['date'].split('-')]
        csl={'id':doi+'v'+version,'DOI':doi,'type':'article','genre':'Preprint','title':clean(item['title']),'author':authors,'issued':{'date-parts':[date]},'publisher':platform,'URL':url,'version':version}
        return {'identifier':url,'doi':doi,'csl':csl,'kind':'preprint','platform':platform,'version':version,'publisher':url,'sources':[{'name':platform,'url':url+'.full.pdf','trusted':True}],'warnings':['This is a '+platform+' preprint (version '+version+'); a published journal article is a separate record.'],'metadata_source':platform}
