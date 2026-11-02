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
import subprocess
import socket
import sys
import tempfile
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
PICKER_LOCK = threading.Lock()


def choose_folder(initial=''):
    """Run Tk on its own main thread/process so HTTP worker threads stay safe."""
    if not PICKER_LOCK.acquire(blocking=False):
        raise ValueError('A folder selection window is already open.')
    script = '''import json, sys, tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
root.attributes('-topmost', True)
try:
    folder = filedialog.askdirectory(parent=root, title='Choose a folder for your papers', initialdir=sys.argv[1] or None, mustexist=True)
    print(json.dumps({'folder': folder}))
finally:
    root.destroy()
'''
    try:
        result = subprocess.run([sys.executable, '-c', script, str(initial)],
                                capture_output=True, text=True, encoding='utf-8', timeout=180,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                                env={**os.environ, 'PYTHONIOENCODING':'utf-8'})
        if result.returncode:
            raise ValueError('The folder picker could not open. Enter the folder path manually.')
        selected = json.loads(result.stdout)['folder']
        if selected:
            selected = windows_folder(selected)
            if not Path(selected).is_dir():
                raise ValueError('The selected folder no longer exists.')
        return {'folder':selected}
    except subprocess.TimeoutExpired:
        raise ValueError('Folder selection timed out. Try again or enter the path manually.')
    finally:
        PICKER_LOCK.release()


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
    req = R.Request(url, headers={'User-Agent': 'CitationWorkflow/0.2 (local research tool)', 'Accept': accept})
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
        csl['container-title-short'] = text(a,'Journal/ISOAbbreviation') or text(article,'MedlineCitation/MedlineJournalInfo/MedlineTA') or csl.get('container-title-short','')
    if not csl or not csl.get('title'):
        raise ValueError('No paper metadata found. Check the DOI or try again later.')
    short = csl.get('container-title-short') or csl.get('journal-abbreviation') or csl.get('short-container-title')
    if not short:
        try:
            metadata = getjson('https://api.crossref.org/works/'+U.quote(doi, safe=''))['message']
            short = metadata.get('short-container-title')
            if not csl.get('page'):
                csl['page'] = metadata.get('page') or metadata.get('article-number','')
        except Exception:
            pass
    if short:
        csl['container-title-short'] = short[0] if isinstance(short,list) else short
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


def reference_example(payload):
    example = str(payload.get('example','')).strip()
    if not 30 <= len(example) <= 6000:
        raise ValueError('Paste one complete reference example (30–6000 characters).')
    match = re.search(r'10\.\d{4,9}/[^\s<>"\]]+', example, re.I)
    if match:
        doi = match.group().rstrip('.,;')
        while doi.endswith(')') and doi.count(')') > doi.count('('):
            doi = doi[:-1]
        return lookup(doi_normalize(doi))
    # A strong title match is required. Never infer a style using a merely similar paper.
    results = getjson('https://api.crossref.org/works?'+U.urlencode({'query.bibliographic':example,'rows':3}))['message']['items']
    normalise = lambda value: re.sub(r'[^\w]+',' ',html.unescape(re.sub(r'<[^>]+>','',value))).strip().casefold()
    reference = normalise(example)
    years = set(re.findall(r'\b(?:18|19|20)\d{2}\b', example))
    matches = set()
    for item in results:
        dates = [str(item.get(field,{}).get('date-parts',[[]])[0][0]) for field in ('issued','published','published-print','published-online') if item.get(field,{}).get('date-parts',[[]])[0]]
        if years and dates and not years.intersection(dates):
            continue
        if item.get('DOI') and any(len(normalise(title)) > 12 and normalise(title) in reference for title in item.get('title',[])):
            matches.add(item['DOI'])
    if len(matches) != 1:
        raise ValueError('The example paper could not be identified reliably. Add its DOI to the reference and try again.')
    return lookup(next(iter(matches)))


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


class SearchLinks(HTMLParser):
    def __init__(self):
        super().__init__(); self.urls = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.urls.append(dict(attrs).get('href', ''))


def browser_search(url):
    """Render search with an isolated, hidden browser; never reuse a signed-in profile."""
    browsers = []
    for base in (os.environ.get('PROGRAMFILES', ''), os.environ.get('PROGRAMFILES(X86)', ''), os.environ.get('LOCALAPPDATA', '')):
        if base:
            browsers.extend([Path(base)/'Google/Chrome/Application/chrome.exe', Path(base)/'Microsoft/Edge/Application/msedge.exe'])
    browser = next((path for path in browsers if path.is_file()), None)
    if not browser:
        raise ValueError('Chrome or Edge was not found for browser search.')
    with tempfile.TemporaryDirectory(prefix='citation-search-') as profile:
        result = subprocess.run([str(browser), '--headless=new', '--disable-gpu', '--no-first-run',
                                 '--no-default-browser-check', '--user-data-dir='+profile,
                                 '--dump-dom', '--timeout=15000', '--virtual-time-budget=5000', url],
                                capture_output=True, timeout=30,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode or not result.stdout:
            raise ValueError('Browser search did not return a search page.')
        return result.stdout


def discover_mirrors():
    """Discover candidates afresh; PDF retrieval below checks actual availability."""
    errors = []
    engines = ('https://www.google.com/search?q=', 'https://html.duckduckgo.com/html/?q=')
    searches = [(engine, False) for engine in engines] + [(engine, True) for engine in engines]
    for engine, rendered in searches:
        try:
            url = engine + U.quote('Sci-Hub active mirror')
            data = browser_search(url) if rendered else fetch(url, 'text/html')[0]
            links = SearchLinks(); links.feed(data.decode('utf-8', 'replace'))
            mirrors = []
            for href in links.urls:
                parts = U.urlsplit(html.unescape(href))
                query = U.parse_qs(parts.query)
                candidate = (query.get('uddg') or query.get('q') or query.get('url') or [href])[0]
                parsed = U.urlsplit(candidate)
                # Only direct Sci-Hub domains, never a search-result lookalike or private host.
                if parsed.scheme == 'https' and re.fullmatch(r'(?:www\.)?sci-hub\.[a-z]{2,12}', parsed.hostname or ''):
                    origin = 'https://' + parsed.hostname
                    safe_url(origin)
                    if origin not in mirrors:
                        mirrors.append(origin)
            if mirrors:
                return mirrors[:3], errors
            errors.append('Sci-Hub discovery: search returned no eligible mirror links.')
        except Exception as e:
            errors.append('Sci-Hub discovery: ' + str(e))
    return [], errors


def pmc_sources(record):
    return [source for source in record['sources'] if source['name'] == 'PubMed Central'], []


def scihub_sources(record):
    mirrors, errors = discover_mirrors()
    return [{'name':'Sci-Hub', 'url':mirror+'/'+U.quote(record['doi'], safe='/')} for mirror in mirrors], errors


# Add future database adapters here. Each returns (candidate sources, discovery errors).
DATABASE_PROVIDERS = (pmc_sources, scihub_sources)


def publisher_choices(record):
    choices = []
    urls = [record['publisher'], record['csl'].get('URL', '')]
    for url in urls:
        try:
            safe_url(url)
            if url and url not in [choice['url'] for choice in choices]:
                choices.append({'name':'Publisher · '+(record['csl'].get('publisher') or U.urlsplit(url).hostname), 'url':url})
        except Exception:
            continue
    choices.append({'name':'Search Google for the publisher', 'url':'https://www.google.com/search?'+U.urlencode({'q':record['doi']+' '+record['csl']['title']+' publisher'})})
    return choices


def download(payload):
    record = CACHE.get(payload.get('key'))
    if not record and payload.get('doi'):
        record = lookup(doi_normalize(payload['doi']))
    if not record:
        raise ValueError('The paper session has expired. Find the paper again to continue.')
    folder = windows_folder(payload.get('folder',''))
    if os.name != 'nt':
        raise ValueError('Only Windows is currently supported.')
    target = Path(folder)
    if not target.is_dir():
        raise ValueError('The folder does not exist. Create it first or choose an existing folder.')
    errors = []
    def candidates():
        for provider in DATABASE_PROVIDERS:
            try:
                sources, discovery_errors = provider(record)
                errors.extend(discovery_errors)
                yield from sources
            except Exception as e:
                errors.append(provider.__name__ + ': ' + str(e))

    for source in candidates():
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
    return {'ok':False,'login':record['publisher'],'publishers':publisher_choices(record),'attempts':errors}


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
        if path not in ('/','/index.html','/app.js','/custom-style.js','/styles.css','/vendor/citation.js','/favicon.svg'):
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
            elif self.path == '/api/folder':
                result = choose_folder(payload.get('initial',''))
            elif self.path == '/api/style-example':
                result = reference_example(payload)
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
