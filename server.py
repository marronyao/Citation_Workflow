"""Citation Workflow local Windows companion. Python 3.10+, standard library only."""
import argparse
from collections import OrderedDict
from contextlib import contextmanager
from paper_metadata import MetadataClient, identifier
from fulltext_sources import SourceRouter
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
LAST_ARXIV = 0
ARXIV_LOCK = threading.Lock()
REQUEST_CONTEXT = threading.local()
PDF_CACHE = OrderedDict()
PDF_CACHE_LOCK = threading.Lock()
PDF_CACHE_LIMIT = 512_000_000
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
    return identifier(value)


@contextmanager
def request_budget(seconds):
    previous = getattr(REQUEST_CONTEXT, 'deadline', float('inf'))
    REQUEST_CONTEXT.deadline = min(previous, time.monotonic()+seconds)
    try:
        yield
    finally:
        REQUEST_CONTEXT.deadline = previous


def remaining_timeout(default=15):
    remaining = getattr(REQUEST_CONTEXT, 'deadline', float('inf'))-time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Source search time limit reached; try this source again later.')
    return min(default, remaining)


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
    global LAST_ARXIV
    safe_url(url)
    if U.urlsplit(url).hostname == 'export.arxiv.org':
        with ARXIV_LOCK:
            pause = max(0, 3.05-(time.monotonic()-LAST_ARXIV))
            if pause > remaining_timeout():
                raise TimeoutError('arXiv rate-limit wait exceeds the search time limit.')
            time.sleep(pause); LAST_ARXIV=time.monotonic()
    req = R.Request(url, headers={'User-Agent':'CitationWorkflow/0.2 (local research tool)','Accept':accept})
    with R.build_opener(Redirect()).open(req, timeout=remaining_timeout()) as res:
        data=res.read(limit+1)
        if len(data)>limit:
            raise ValueError('The file exceeds the size limit.')
        return data,res.url,res.headers.get_content_type()


def getjson(url):
    return json.loads(fetch(url, 'application/json')[0])


def lookup(value):
    result=MetadataClient(fetch,getjson).resolve(value)
    key=secrets.token_urlsafe(18)
    if len(CACHE)>=256:
        CACHE.pop(next(iter(CACHE)))
    result['key']=key
    result['source_plan']=SOURCE_ROUTER.plan(result)
    CACHE[key]=result
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
        super().__init__();self.pdfs=[];self.links=[];self.pages=[];self.meta={};self.words=[];self.current=None;self.current_words=[];self.entries=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='meta':
            key=(a.get('name') or a.get('property') or '').lower()
            self.meta[key]=a.get('content','')
            if key in ('citation_pdf_url','wkhealth_pdf_url'):self.pdfs.append(a.get('content',''))
        if tag in ('iframe','embed','object'):
            self.pdfs.append(a.get('src') or a.get('data') or '')
        if tag=='a' and a.get('href'):
            href=a['href'];self.current=href;self.current_words=[]
            if re.search(r'(\.pdf(?:[?#]|$)|/pdf(?:[/;?#]|$)|/(?:slow_|fast_)?download|/dl/|/get\.php)',href,re.I):self.links.append(href)
            elif re.search(r'/(?:md5|book|publication|article|scimag)/|ads\.php',href,re.I):self.pages.append(href)
    def handle_data(self,data):
        self.words.append(data)
        if self.current:self.current_words.append(data)
        if self.current and re.fullmatch(r'\s*(?:GET|Download(?: PDF| full.?text)?)\s*',data,re.I):self.links.append(self.current)
    def handle_endtag(self,tag):
        if tag=='a':
            if self.current:self.entries.append((self.current,' '.join(self.current_words)))
            self.current=None


def find_pdf(url, record=None, trusted=False):
    queue=[url];seen=set();last_error='No directly accessible PDF found.'
    for _ in range(5):
        if not queue:break
        current=queue.pop(0)
        if current in seen:continue
        seen.add(current)
        data,final,kind=fetch(current,limit=80_000_000)
        if data[:1024].lstrip().startswith(b'%PDF-'):
            return data,final
        if 'html' not in kind:continue
        parser=Links();parser.feed(data.decode('utf-8','replace'))
        if record and parser.meta.get('citation_doi') and record.get('doi') and parser.meta['citation_doi'].lower().removeprefix('https://doi.org/')!=record['doi'].lower():
            last_error='The page identifies a different DOI; skipped.';continue
        words=' '.join(parser.words)
        if re.search(r'captcha|verify (?:you|that)|just a moment|log in to download|request full.text',words,re.I) and not parser.pdfs and not parser.links:
            last_error='Sign-in or manual verification is required.';continue
        normalise=lambda value:re.sub(r'[^\w]+',' ',html.unescape(str(value))).casefold().strip()
        matching=set()
        if record:
            title=normalise(record['csl']['title']);doi=record.get('doi','').lower()
            matching={href for href,label in parser.entries if (title and title in normalise(label)) or (doi and doi in (href+' '+label).lower())}
        catalogue=bool(re.search(r'/search(?:\?|/)|/s/|/scimag/\?',current))
        pdf_links=parser.pdfs+parser.links
        if catalogue and not trusted and record:
            pdf_links=[link for link in pdf_links if link in matching]
        for candidate in list(dict.fromkeys(pdf_links))[:4]:
            target=U.urljoin(final,html.unescape(candidate))
            try:
                pdf,resolved,content_type=fetch(target,limit=80_000_000)
                if pdf[:1024].lstrip().startswith(b'%PDF-'):return pdf,resolved
                if 'html' in content_type and target not in seen:queue.append(target)
            except Exception as error:last_error=str(error)
        # Follow bounded catalogue record links on the same site, never advertising links.
        for candidate in parser.pages[:4]:
            if record and not trusted and candidate not in matching:continue
            target=U.urljoin(final,html.unescape(candidate))
            if U.urlsplit(target).hostname==U.urlsplit(final).hostname and target not in seen:queue.append(target)
    raise ValueError(last_error+' No PDF was saved.')


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
                                capture_output=True, timeout=remaining_timeout(30),
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode or not result.stdout:
            raise ValueError('Browser search did not return a search page.')
        return result.stdout


SOURCE_ROUTER=SourceRouter(lambda *a,**k:fetch(*a,**k), lambda *a,**k:getjson(*a,**k), lambda url:safe_url(url), lambda url:browser_search(url), lambda *a,**k:find_pdf(*a,**k), request_budget)


def cached_pdf(key):
    with PDF_CACHE_LOCK:
        now=time.monotonic()
        for stale in [k for k,v in PDF_CACHE.items() if v['expires']<now]:
            PDF_CACHE.pop(stale)['file'].close()
        item=PDF_CACHE.get(key)
        if item:
            PDF_CACHE.move_to_end(key)
            item['file'].seek(0)
            return {**item['result'],'pdf':item['file'].read()}
    return None


def search_fulltext(payload):
    record=CACHE.get(payload.get('key'))
    if not record:raise ValueError('The paper session has expired. Find the paper again.')
    result=cached_pdf(record['key'])
    if result:return {k:v for k,v in result.items() if k!='pdf'}
    with request_budget(360):
        result=SOURCE_ROUTER.retrieve(record)
    if result['ok']:
        pdf=result.pop('pdf')
        file=tempfile.TemporaryFile();file.write(pdf);file.seek(0)
        with PDF_CACHE_LOCK:
            if record['key'] in PDF_CACHE:PDF_CACHE.pop(record['key'])['file'].close()
            PDF_CACHE[record['key']]={'file':file,'bytes':len(pdf),'expires':time.monotonic()+1800,'result':dict(result)}
            while sum(item['bytes'] for item in PDF_CACHE.values())>PDF_CACHE_LIMIT:
                PDF_CACHE.popitem(last=False)[1]['file'].close()
    else:
        result.update({'login':record['publisher'],'publishers':publisher_choices(record)})
    return result


def publisher_choices(record):
    choices = []
    urls = [record['publisher'], record['csl'].get('URL', ''), 'https://doi.org/'+record['doi'] if record.get('doi') else '']
    labels={'nature.com':'Nature','cell.com':'Cell Press','sciencedirect.com':'Elsevier','elsevier.com':'Elsevier','wiley.com':'Wiley','pubs.acs.org':'ACS','pubs.rsc.org':'RSC','link.springer.com':'Springer','ieeexplore.ieee.org':'IEEE','dl.acm.org':'ACM'}
    for url in urls:
        try:
            safe_url(url)
            if url and url not in [choice['url'] for choice in choices]:
                host=U.urlsplit(url).hostname
                label=next((label for domain,label in labels.items() if host==domain or host.endswith('.'+domain)),None)
                choices.append({'name':'Official article · '+(label or record.get('platform') or record['csl'].get('publisher') or host), 'url':url})
        except Exception:
            continue
    choices.append({'name':'Search Google for the publisher', 'url':'https://www.google.com/search?'+U.urlencode({'q':record['doi']+' '+record['csl']['title']+' publisher'})})
    return choices


def download(payload):
    folder=windows_folder(payload.get('folder',''))
    if os.name!='nt':raise ValueError('Only Windows is currently supported.')
    target=Path(folder)
    if not target.is_dir():raise ValueError('The folder does not exist. Create it first or choose an existing folder.')
    record=CACHE.get(payload.get('key'))
    if not record and (payload.get('identifier') or payload.get('doi')):
        record=lookup(payload.get('identifier') or payload['doi'])
    if not record:raise ValueError('The paper session has expired. Find the paper again.')
    key=record['key']
    result=cached_pdf(key)
    if not result:
        result=search_fulltext({'key':key})
        if not result['ok']:return result
        result=cached_pdf(key)
    if not result:raise ValueError('The temporary PDF has expired. Retry the download.')
    pdf=result['pdf'];name=filename(record['csl']['title'])
    for n in range(10000):
        dest=target/(name if n==0 else name[:-4]+f' ({n}).pdf')
        try:
            with dest.open('xb') as file:
                try:file.write(pdf)
                except Exception:
                    file.close();dest.unlink(missing_ok=True);raise
            return {**{k:v for k,v in result.items() if k!='pdf'},'ok':True,'path':str(dest),'bytes':len(pdf)}
        except FileExistsError:continue
    raise ValueError('Too many files share this name. Choose another folder.')


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
                result = lookup(payload.get('identifier') or payload.get('doi',''))
            elif self.path == '/api/search':
                result = search_fulltext(payload)
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
