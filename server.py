"""Citation Workflow local Windows companion. Python 3.10+, standard library only."""
import argparse
import html
import ipaddress
import json
import ntpath
import os
from pathlib import Path
import re
import secrets
import socket
import threading
import time
import webbrowser
import urllib.parse as U
import urllib.request as R
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
TOKEN = secrets.token_urlsafe(32)
CACHE = {}
LAST_NCBI = 0
NCBI_LOCK = threading.Lock()
ALLOWED_ORIGIN = None


def doi_normalize(value):
    value = str(value).strip().strip('\"\'').strip()
    value = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi\s*:\s*)', '', value, flags=re.I)
    value = U.unquote(value).strip()
    if not re.fullmatch(r'10\.\d{4,9}/[^\s<>\"]+', value, re.I):
        raise ValueError('Enter a valid DOI, e.g. 10.1038/s41586-021-03819-2.')
    return value


def windows_folder(value):
    value = str(value).strip().strip('\"\'').strip().replace('/', '\\')
    if not re.match(r'^[A-Za-z]:\\', value) or re.search(r'[<>\"|?*\x00-\x1f]', value) or ':' in value[2:]:
        raise ValueError('Enter an absolute Windows path, e.g. D:\\Papers. Slashes and surrounding quotation marks are accepted.')
    value = ntpath.normpath(value)
    for part in value[3:].split('\\'):
        if part and (part.endswith((' ', '.')) or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', part, re.I)):
            raise ValueError('The folder name contains a reserved Windows name or unsupported trailing characters.')
    return value


def filename(title):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', html.unescape(title)).strip(' .')[:160].rstrip(' .') or 'article'
    if re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', name, re.I):
        name = '_' + name
    return name + '.pdf'


def safe_url(url):
    p = U.urlsplit(url)
    if p.scheme not in ('https', 'http') or not p.hostname or p.username or p.password or p.port not in (None, 80, 443):
        raise ValueError('The full-text link must be a public HTTP(S) URL.')
    if any(not ipaddress.ip_address(x[4][0]).is_global for x in socket.getaddrinfo(p.hostname, p.port or 443)):
        raise ValueError('Private network URLs are not supported.')
    return url


class Redirect(R.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, accept='*/*', limit=8_000_000):
    global LAST_NCBI
    safe_url(url)
    if 'eutils.ncbi.nlm.nih.gov' == U.urlsplit(url).hostname:
        with NCBI_LOCK:
            time.sleep(max(0, .36 - (time.monotonic() - LAST_NCBI)))
            LAST_NCBI = time.monotonic()
    req = R.Request(url, headers={'User-Agent': 'CitationWorkflow/0.1 (local research tool)', 'Accept': accept})
    with R.build_opener(Redirect()).open(req, timeout=25) as res:
        data = res.read(limit + 1)
        if len(data) > limit:
            raise ValueError('The file exceeds the size limit.')
        return data, res.url, res.headers.get_content_type()


def getjson(url):
    return json.loads(fetch(url, 'application/json')[0])


def text(node, path):
    found = node.find(path)
    return ''.join(found.itertext()).strip() if found is not None else ''


def lookup(doi):
    warnings = []
    csl = None
    pmid = pmc = ''
    article = None
    try:
        base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/'
        ids = getjson(base + 'esearch.fcgi?' + U.urlencode({'db':'pubmed','term':doi+'[AID]','retmode':'json'}))['esearchresult']['idlist']
        if ids:
            tree = ET.fromstring(fetch(base + 'efetch.fcgi?' + U.urlencode({'db':'pubmed','id':','.join(ids[:5]),'retmode':'xml'}))[0])
            for entry in tree.findall('.//PubmedArticle'):
                # ReferenceList contains other papers' identifiers: never include them.
                identifiers = {n.get('IdType'): n.text or '' for n in entry.findall('./PubmedData/ArticleIdList/ArticleId')}
                if identifiers.get('doi', '').lower() == doi.lower():
                    article = entry
                    pmid, pmc = identifiers.get('pubmed',''), identifiers.get('pmc','')
                    break
        if article is None:
            warnings.append('No exact DOI match found in PubMed; trying DOI registration metadata.')
    except Exception as e:
        warnings.append('PubMed is temporarily unavailable: ' + str(e))
    try:
        csl = json.loads(fetch('https://doi.org/' + U.quote(doi, safe='/'), 'application/vnd.citationstyles.csl+json')[0])
    except Exception as e:
        warnings.append('DOI metadata could not be retrieved: ' + str(e))
    if article is not None:
        a = article.find('.//Article')
        if not csl:
            authors = []
            for author in a.findall('./AuthorList/Author'):
                if text(author, 'CollectiveName'):
                    authors.append({'literal':text(author,'CollectiveName')})
                else:
                    authors.append({'family':text(author,'LastName'), 'given':text(author,'ForeName') or text(author,'Initials')})
            year = text(a,'Journal/JournalIssue/PubDate/Year') or text(a,'Journal/JournalIssue/PubDate/MedlineDate')[:4]
            csl = {'type':'article-journal','author':authors,'issued':{'date-parts':[[int(year)]]} if year.isdigit() else {},
                   'container-title':text(a,'Journal/Title'),'volume':text(a,'Journal/JournalIssue/Volume'),
                   'issue':text(a,'Journal/JournalIssue/Issue'),'page':text(a,'Pagination/StartPage') or text(a,'Pagination/MedlinePgn')}
        csl['title'] = text(a,'ArticleTitle') or csl.get('title','')
        csl['container-title'] = text(a,'Journal/Title') or csl.get('container-title','')
    if not csl or not csl.get('title'):
        raise ValueError('No paper metadata found. Check the DOI or try again later.')
    csl.update({'id':doi,'DOI':doi})
    result = {'doi':doi,'csl':csl,'pmid':pmid,'pmc':pmc,'warnings':warnings,
              'publisher':'https://doi.org/'+doi,'sources':[]}
    if pmc:
        result['sources'].append({'name':'PubMed Central','url':f'https://pmc.ncbi.nlm.nih.gov/articles/{pmc}/'})
    result['sources'].append({'name':'Publisher','url':'https://doi.org/'+doi})
    key = secrets.token_urlsafe(18)
    if len(CACHE) >= 64:
        CACHE.pop(next(iter(CACHE)))
    CACHE[key] = result
    result['key'] = key
    return result


class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.pdfs = []; self.links = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'meta' and (a.get('name','').lower() == 'citation_pdf_url' or a.get('property','').lower() == 'citation_pdf_url'):
            self.pdfs.append(a.get('content',''))
        if tag in ('iframe','embed'):
            self.pdfs.append(a.get('src',''))
        if tag == 'a' and a.get('href'):
            href = a['href']
            if re.search(r'(\.pdf(?:[?#]|$)|/pdf(?:[/;?#]|$)|download.*pdf)', href, re.I):
                self.links.append(href)


def find_pdf(url):
    data, final, kind = fetch(url, limit=80_000_000)
    if data[:1024].lstrip().startswith(b'%PDF-'):
        return data, final
    if 'html' not in kind:
        raise ValueError('The source did not return a PDF.')
    parser = Links(); parser.feed(data.decode('utf-8', 'replace'))
    for candidate in list(dict.fromkeys(parser.pdfs + parser.links))[:10]:
        try:
            target = U.urljoin(final, html.unescape(candidate))
            pdf, resolved, _ = fetch(target, limit=80_000_000)
            if pdf[:1024].lstrip().startswith(b'%PDF-'):
                return pdf, resolved
        except Exception:
            continue
    raise ValueError('No directly accessible PDF found. Sign-in or manual verification may be required.')


def download(payload):
    record = CACHE.get(payload.get('key'))
    if not record:
        raise ValueError('The paper session has expired. Find the paper again to continue.')
    folder = windows_folder(payload.get('folder',''))
    if os.name != 'nt':
        raise ValueError('Only Windows is currently supported.')
    target = Path(folder)
    if not target.is_dir():
        raise ValueError('The folder does not exist. Create it first or choose an existing folder.')
    sources = list(record['sources'])
    mirror = str(payload.get('mirror','')).strip().rstrip('/')
    if mirror:
        safe_url(mirror)
        sources.append({'name':'Sci-Hub (custom mirror)','url':mirror+'/'+U.quote(record['doi'],safe='/')})
    errors = []
    for source in sources:
        try:
            pdf, url = find_pdf(source['url'])
        except Exception as e:
            errors.append(source['name']+'：'+str(e)); continue
        name = filename(record['csl']['title'])
        dest = target / name
        # Exclusive creation prevents overwriting; duplicate files get a numeric suffix.
        for n in range(10000):
            dest = target / (name if n == 0 else name[:-4]+f' ({n}).pdf')
            try:
                with dest.open('xb') as f:
                    try:
                        f.write(pdf)
                    except Exception:
                        f.close(); dest.unlink(missing_ok=True); raise
                return {'ok':True,'path':str(dest),'bytes':len(pdf),'source':source['name'],'url':url,'attempts':errors}
            except FileExistsError:
                continue
        raise ValueError('Too many files share this name. Choose another folder.')
    return {'ok':False,'login':record['publisher'],'attempts':errors}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,directory=str(ROOT),**kwargs)
    def origin_ok(self):
        origin = self.headers.get('Origin')
        return not origin or origin == f'http://127.0.0.1:{self.server.server_port}' or origin == f'http://localhost:{self.server.server_port}' or (ALLOWED_ORIGIN and origin == ALLOWED_ORIGIN)
    def end_headers(self):
        if self.origin_ok() and self.headers.get('Origin'):
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary','Origin')
        self.send_header('X-Content-Type-Options','nosniff')
        super().end_headers()
    def reply(self,obj,status=200):
        data = json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_OPTIONS(self):
        if not self.origin_ok():
            self.reply({'error':'Origin blocked'},403); return
        self.send_response(204); self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS'); self.send_header('Access-Control-Allow-Headers','Content-Type, X-Citation-Token'); self.send_header('Access-Control-Allow-Private-Network','true'); self.end_headers()
    def do_GET(self):
        if not self.origin_ok() or self.headers.get('Host') not in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'):
            self.reply({'error':'Origin / Host blocked'},403); return
        if self.path == '/api/health':
            self.reply({'ok':True,'token':TOKEN,'platform':os.name}); return
        # Serve only public frontend assets, never local source/config/dependencies.
        path = U.urlsplit(self.path).path
        if path not in ('/','/index.html','/app.js','/styles.css','/vendor/citation.js','/favicon.svg'):
            self.send_error(404); return
        super().do_GET()
    def do_POST(self):
        if not self.origin_ok() or self.headers.get('X-Citation-Token') != TOKEN:
            self.reply({'error':'Connection authentication failed. Refresh the page.'},403); return
        try:
            length = int(self.headers.get('Content-Length','0'))
            if not 0 < length < 20000:
                raise ValueError('Invalid request size.')
            payload = json.loads(self.rfile.read(length))
            if self.path == '/api/lookup':
                result = lookup(doi_normalize(payload.get('doi','')))
            elif self.path == '/api/download':
                result = download(payload)
            else:
                self.reply({'error':'Unknown API'},404); return
            self.reply(result)
        except Exception as e:
            self.reply({'error':str(e)},400)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--origin',help='Exact GitHub Pages origin to allow, e.g. https://name.github.io')
    parser.add_argument('--open-browser',action='store_true')
    args = parser.parse_args(); ALLOWED_ORIGIN = args.origin
    print(f'Citation Workflow: http://127.0.0.1:{args.port}',flush=True)
    httpd = ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    if args.open_browser:
        threading.Timer(.4,lambda:webbrowser.open(f'http://127.0.0.1:{args.port}')).start()
    httpd.serve_forever()
