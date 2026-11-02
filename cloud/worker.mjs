/* Citation Workflow cloud API. No local helper or user filesystem access. */
const VERSION='0.4.0-2', MAX_PDF=80*1024*1024;
const REPOSITORIES=['arxiv.org','export.arxiv.org','proceedings.mlr.press','proceedings.neurips.cc','openaccess.thecvf.com','aclanthology.org','biorxiv.org','www.biorxiv.org','medrxiv.org','www.medrxiv.org','chemrxiv.org','www.chemrxiv.org'];
const HOSTS=[...REPOSITORIES,'api.crossref.org','api.datacite.org','doi.org','api.biorxiv.org','pmc.ncbi.nlm.nih.gov','www.ncbi.nlm.nih.gov','pmc-oa-opendata.s3.amazonaws.com','journals.plos.org','www.jstatsoft.org','jstatsoft.org','www.nature.com','nature.com','www.science.org','science.org','elifesciences.org','www.elifesciences.org','peerj.com','www.frontiersin.org','www.mdpi.com','link.springer.com','link.springer.com','academic.oup.com','onlinelibrary.wiley.com','www.cell.com','www.sciencedirect.com','pubs.acs.org','pubs.rsc.org'];
const enc=new TextEncoder();
export function safeURL(value) {
  const u=new URL(value);
  if(u.protocol!=='https:' || u.username || u.password || u.port || !HOSTS.includes(u.hostname)) throw Error('Unsupported source URL.');
  return u;
}
export function normalizeIdentifier(value) {
  if(typeof value!=='string' || value.length>2000) throw Error('Enter a paper DOI, arXiv ID or supported paper link.');
  let s=decodeURIComponent(value.trim()).replace(/^doi:\s*/i,'').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'');
  const ar=s.replace(/^(?:arxiv:\s*|https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf|html)\/)/i,'').split('?')[0].replace(/\.pdf$/i,'');
  if(/^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(ar)) return 'arxiv:'+ar;
  if(/^10\.\d{4,9}\/[^\s<>"']+$/i.test(s)) return s;
  const u=safeURL(s);
  if(!REPOSITORIES.includes(u.hostname)) throw Error('Use a DOI or a supported repository paper link.');
  return u.origin+u.pathname;
}
export function filename(title) {return String(title||'Paper').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,140).replace(/[. ]+$/,'')+'.pdf';}
function clean(s='') {return String(s).replace(/<[^>]*>/g,'').replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&quot;/g,'"').replace(/&apos;|&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();}
async function upstream(value, options={}) {
  let url=safeURL(String(value).replace(/^http:\/\//i,'https://'));
  for(let i=0;i<5;i++) {
    const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(18000),headers:{'User-Agent':'CitationWorkflow/0.4.0 (+https://github.com/marronyao/Citation_Workflow)',...options.headers}});
    if([301,302,303,307,308].includes(r.status)) {const location=r.headers.get('location');await r.body?.cancel();if(!location) throw Error('Source returned an invalid redirect.');url=safeURL(new URL(location,url));continue;}
    if(!r.ok){await r.body?.cancel();throw Error('Source returned HTTP '+r.status);}
    return r;
  }
  throw Error('Too many source redirects.');
}
async function boundedText(r,max=2*1024*1024) {
  const reader=r.body.getReader(),chunks=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw Error('Source metadata is too large.');chunks.push(value);}}
  catch(e){await reader.cancel();throw e;}
  const all=new Uint8Array(size);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.length;}return new TextDecoder().decode(all);
}
async function jsonURL(url) {return JSON.parse(await boundedText(await upstream(url,{headers:{Accept:'application/json'}})));}
function authors(list=[]) {return list.map(a=>a.name?{literal:clean(a.name)}:{given:clean(a.given||a.givenName),family:clean(a.family||a.familyName)});}
function person(s) {s=clean(s);if(s.includes(',')){const [family,...given]=s.split(',');return {family:family.trim(),given:given.join(',').trim()};}const words=s.split(' ');return {family:words.pop(),given:words.join(' ')};}
function xmlTag(xml,tag) {return clean(xml.match(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>','i'))?.[1]||'');}
function metaTags(html) {
  const out={};for(const tag of html.match(/<meta\b[^>]*>/gi)||[]){const attrs={};for(const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))attrs[m[1].toLowerCase()]=clean(m[2]??m[3]);const key=(attrs.name||attrs.property||'').toLowerCase();if(key&&attrs.content)(out[key]??=[]).push(attrs.content);}return out;
}
function paperRecord(identifier,csl,extra={}) {
  if(!csl.title)throw Error('No paper title was returned by the metadata source.');
  const kind=csl.type==='paper-conference'?'conference':csl.genre==='Preprint'?'preprint':'journal';
  const doi=csl.DOI||'',publisher=csl.URL||(doi?'https://doi.org/'+doi:identifier);
  return {identifier,doi,csl:{...csl,title:clean(csl.title)},kind,publisher,sources:[{name:'Official article',url:publisher}],warnings:[],source_plan:kind==='journal'?['PMC','Publisher open access']:['Original repository'],pdf_candidates:[],...extra};
}
async function fromPage(url,identifier=url) {
  const html=await boundedText(await upstream(url));const m=metaTags(html),get=k=>m['citation_'+k]?.[0]||'';
  const conference=/proceedings\.|thecvf|aclanthology/.test(new URL(url).hostname);
  const date=(get('publication_date')||get('date')).split(/[-/]/).map(Number).filter(Boolean);
  const csl={id:identifier,type:conference?'paper-conference':'article',title:get('title'),author:(m.citation_author||[]).map(person),issued:{'date-parts':[date.length?date:[new Date().getUTCFullYear()]]},'container-title':get('conference_title')||get('journal_title')||get('book_title'),publisher:get('publisher'),DOI:get('doi'),URL:url,volume:get('volume'),issue:get('issue'),page:[get('firstpage'),get('lastpage')].filter(Boolean).join('-')};
  if(!conference)csl.genre='Preprint';
  const pdf=get('pdf_url');return paperRecord(identifier,csl,{platform:conference?csl['container-title']:new URL(url).hostname,metadata_source:'Original repository',pdf_candidates:pdf?[{url:new URL(pdf,url).href,name:'Original repository'}]:[]});
}
async function arxiv(identifier) {
  const id=identifier.slice(6),base=id.replace(/v\d+$/,''),version=id.match(/v(\d+)$/)?.[1]||'';
  const xml=await boundedText(await upstream('https://export.arxiv.org/api/query?id_list='+encodeURIComponent(id))),entry=xml.match(/<entry>[\s\S]*?<\/entry>/)?.[0];
  if(!entry || !xmlTag(entry,'id').includes(base))throw Error('arXiv paper was not found.');
  const actual=version || xmlTag(entry,'id').match(/v(\d+)$/)?.[1]||'',full=base+(actual?'v'+actual:'');
  return paperRecord(identifier,{id:identifier,type:'article',genre:'Preprint',title:xmlTag(entry,'title'),author:[...entry.matchAll(/<author>([\s\S]*?)<\/author>/g)].map(m=>person(xmlTag(m[1],'name'))),issued:{'date-parts':[xmlTag(entry,'published').slice(0,10).split('-').map(Number)]},DOI:'10.48550/arXiv.'+base,publisher:'arXiv',URL:'https://arxiv.org/abs/'+full,version:actual},{kind:'preprint',platform:'arXiv',version:actual,metadata_source:'arXiv',pdf_candidates:[{url:'https://arxiv.org/pdf/'+full,name:'arXiv'}]});
}
async function resolve(identifier) {
  if(/^10\.48550\/arxiv\./i.test(identifier))return arxiv('arxiv:'+identifier.replace(/^10\.48550\/arxiv\./i,''));
  if(identifier.startsWith('arxiv:'))return arxiv(identifier);
  if(identifier.startsWith('https://'))return fromPage(identifier);
  let errors=[];
  try {
    const m=(await jsonURL('https://api.crossref.org/works/'+encodeURIComponent(identifier))).message;
    if(m.DOI?.toLowerCase()!==identifier.toLowerCase())throw Error('DOI mismatch');
    const pre=m.type==='posted-content';
    return paperRecord(identifier,{id:identifier,type:m.type==='proceedings-article'?'paper-conference':pre?'article':'article-journal',...(pre?{genre:'Preprint'}:{}),title:m.title?.[0],author:authors(m.author),issued:m.published||m.issued,'container-title':m['container-title']?.[0],'container-title-short':m['short-container-title']?.[0],publisher:m.publisher,volume:m.volume,issue:m.issue,page:m.page||m['article-number'],DOI:m.DOI,URL:'https://doi.org/'+m.DOI},{metadata_source:'Crossref',pdf_candidates:(m.link||[]).filter(l=>l['content-type']==='application/pdf').slice(0,4).map(l=>({url:l.URL,name:'Publisher open access'}))});
  }catch(e){errors.push(e.message);}
  try {
    const a=(await jsonURL('https://api.datacite.org/dois/'+encodeURIComponent(identifier))).data.attributes;
    if(a.doi.toLowerCase()!==identifier.toLowerCase())throw Error('DOI mismatch');
    const pre=/preprint/i.test(a.types?.resourceTypeGeneral+' '+a.types?.resourceType);
    const p=paperRecord(identifier,{id:identifier,type:pre?'article':'article-journal',...(pre?{genre:'Preprint'}:{}),title:a.titles?.[0]?.title,author:(a.creators||[]).map(a=>a.familyName?{family:a.familyName,given:a.givenName}:{literal:a.name}),issued:{'date-parts':[[+a.publicationYear]]},publisher:a.publisher,DOI:a.doi,URL:a.url},{metadata_source:'DataCite'});
    if(a.url){try{const original=await fromPage(a.url,identifier);p.pdf_candidates=original.pdf_candidates;}catch{}}
    return p;
  }catch(e){errors.push(e.message);}
  throw Error('Paper metadata was not found. Check the DOI or try again later. '+errors.join('; '));
}
function base64(bytes){let s='';for(const c of bytes)s+=String.fromCharCode(c);return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function unbase64(s){return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));}
async function hmacKey(secret) {if(!secret)throw Error('Cloud service is not configured.');return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function sign(data,secret) {const payload=base64(enc.encode(JSON.stringify({...data,exp:Date.now()+3600000})));return payload+'.'+base64(new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(secret),enc.encode(payload))));}
export async function verify(token,secret,purpose) {
  if(typeof token!=='string'||token.length>12000)throw Error('Invalid download ticket.');const [payload,sig,...extra]=token.split('.');
  if(extra.length||!sig||!await crypto.subtle.verify('HMAC',await hmacKey(secret),unbase64(sig),enc.encode(payload)))throw Error('Invalid download ticket.');
  const data=JSON.parse(new TextDecoder().decode(unbase64(payload)));if(data.exp<Date.now()||data.purpose!==purpose)throw Error('This paper link has expired. Find the paper again.');return data;
}
async function cached(key,ctx,loader,ttl=3600) {
  const url='https://citation-workflow-api.marronyao.workers.dev/cache/'+VERSION+'/'+encodeURIComponent(key),cache=globalThis.caches?.default;
  const hit=await cache?.match(url);if(hit)return hit.json();
  const data=await loader();if(cache)ctx.waitUntil(cache.put(url,Response.json(data,{headers:{'Cache-Control':'public,max-age='+ttl}})));return data;
}
async function pdfResponse(url) {
  const r=await upstream(url,{headers:{Accept:'application/pdf'}});
  if(+r.headers.get('content-length')>MAX_PDF){await r.body.cancel();throw Error('PDF exceeds the 80 MB download limit.');}
  const reader=r.body.getReader();let prefix=new Uint8Array(),size=0;
  while(prefix.length<5) {const {done,value}=await reader.read();if(done)break;const all=new Uint8Array(prefix.length+value.length);all.set(prefix);all.set(value,prefix.length);prefix=all;}
  if(new TextDecoder().decode(prefix.slice(0,5))!=='%PDF-'){await reader.cancel();throw Error('Source did not return a PDF.');}
  size=prefix.length;
  return new Response(new ReadableStream({start(controller){controller.enqueue(prefix);},async pull(controller){try{const {done,value}=await reader.read();if(done){controller.close();return;}size+=value.length;if(size>MAX_PDF)throw Error('PDF exceeds 80 MB.');controller.enqueue(value);}catch(e){await reader.cancel();controller.error(e);}},cancel(reason){return reader.cancel(reason);}}),{headers:{'Content-Type':'application/pdf'}});
}
async function pmcCandidates(doi) {
  const conversion=await jsonURL('https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids='+encodeURIComponent(doi)+'&idtype=doi&format=json&tool=CitationWorkflow');
  const pmcid=conversion.records?.find(r=>r.doi?.toLowerCase()===doi.toLowerCase())?.pmcid;if(!/^PMC\d+$/.test(pmcid||''))return [];
  const bucket='https://pmc-oa-opendata.s3.amazonaws.com/';
  const listing=await boundedText(await upstream(bucket+'?list-type=2&prefix=metadata/'+pmcid+'.&max-keys=10'));
  const keys=[...listing.matchAll(/<Key>([^<]+\.json)<\/Key>/g)].map(m=>clean(m[1])).reverse();const result=[];
  for(const key of keys.slice(0,3)){const metadata=await jsonURL(bucket+key),rows=Array.isArray(metadata)?metadata:[metadata];for(const m of rows){if(String(m.doi||'').toLowerCase()===doi.toLowerCase()&&m.pdf_url)result.push({url:m.pdf_url.replace('s3://pmc-oa-opendata/',bucket),name:'PMC',version_note:m.is_manuscript?'Author manuscript':''});}}
  return result;
}
async function searchPaper(paper,ctx) {
  return cached('search:'+paper.identifier,ctx,async()=>{
    const attempts=[],candidates=[...paper.pdf_candidates];
    if(paper.kind==='journal'&&paper.doi)try{candidates.unshift(...await pmcCandidates(paper.doi));}catch(e){attempts.push('PMC: '+e.message);}
    // Deterministic open-access publisher URLs, tied to the exact requested DOI.
    if(/^10\.1371\//i.test(paper.doi))candidates.push({url:'https://journals.plos.org/'+(paper.doi.split('/')[1].split('.')[1]==='pbio'?'plosbiology':'plosone')+'/article/file?id='+encodeURIComponent(paper.doi)+'&type=printable',name:'PLOS'});
    if(/^10\.18637\/jss\./i.test(paper.doi)) {
      try{const page='https://www.jstatsoft.org/article/view/'+paper.doi.split('.').slice(-2).join('');const html=await boundedText(await upstream(page));const pdf=metaTags(html).citation_pdf_url?.[0]||html.match(/href=["']([^"']*\/article\/(?:view|download)\/[^"']+\/\d+)["']/i)?.[1];if(pdf)candidates.push({url:clean(pdf).replace('/article/view/','/article/download/'),name:'Journal of Statistical Software'});}catch(e){attempts.push('JSS: '+e.message);}
    }
    if(!candidates.length && paper.doi)try {
      const landing=await upstream('https://doi.org/'+paper.doi),html=await boundedText(landing),pdf=metaTags(html).citation_pdf_url?.[0];if(pdf)candidates.push({url:pdf,name:'Publisher open access'});
    }catch(e){attempts.push('Official article: '+e.message);}
    const seen=new Set();for(const candidate of candidates.slice(0,8)) {
      if(seen.has(candidate.url))continue;seen.add(candidate.url);
      try {const pdf=await pdfResponse(candidate.url);await pdf.body.cancel();attempts.push(candidate.name+': PDF verified');return {ok:true,...candidate,source:candidate.name,attempts,publishers:paper.sources};}
      catch(e){attempts.push(candidate.name+': '+e.message);}
    }
    attempts.push('No accessible PDF was verified. Some publishers require institutional access or block automated cloud requests.');return {ok:false,attempts,publishers:paper.sources,login:paper.publisher};
  },300);
}
export default {async fetch(request,env,ctx) {
  const origin=request.headers.get('Origin'),allowed=(env.ALLOWED_ORIGINS||'https://marronyao.github.io').split(','),cors={'Access-Control-Allow-Origin':origin&&allowed.includes(origin)?origin:allowed[0],'Vary':'Origin','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Expose-Headers':'Content-Disposition','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  const respond=(data,status=200)=>Response.json(data,{status,headers:cors});
  if(origin&&!allowed.includes(origin))return respond({error:'Origin is not allowed.'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  try {
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/api/health')return respond({ok:true,version:'0.4.0',mode:'cloud'});
    if(env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({key:request.headers.get('CF-Connecting-IP')||'unknown'})).success)return respond({error:'Too many requests. Please wait one minute and try again.'},429);
    if(request.method==='GET'&&url.pathname==='/api/pdf') {
      const ticket=await verify(url.searchParams.get('ticket'),env.SIGNING_KEY,'pdf'),pdf=await pdfResponse(ticket.url);
      return new Response(pdf.body,{headers:{...cors,'Content-Type':'application/pdf','Content-Disposition':"attachment; filename=\"paper.pdf\"; filename*=UTF-8''"+encodeURIComponent(ticket.filename)}});
    }
    if(request.method!=='POST')return respond({error:'Unknown API'},404);
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))return respond({error:'JSON required.'},415);
    const body=JSON.parse(await boundedText(request,16000));
    if(url.pathname==='/api/style-example') {
      const example=String(body.example||'').slice(0,6000),doi=example.match(/10\.\d{4,9}\/[^\s<>"']+/i)?.[0]?.replace(/[.,;)]*$/,'');
      let paper;if(doi)paper=await cached('metadata:'+doi,ctx,()=>resolve(normalizeIdentifier(doi)));
      else {const items=(await jsonURL('https://api.crossref.org/works?rows=1&query.bibliographic='+encodeURIComponent(example))).message.items;if(!items?.[0]?.DOI)throw Error('Include the example paper DOI for a reliable match.');paper=await resolve(items[0].DOI);}
      return respond(paper);
    }
    if(url.pathname==='/api/lookup') {
      const identifier=normalizeIdentifier(body.identifier||body.doi),paper=await cached('metadata:'+identifier,ctx,()=>resolve(identifier));
      const {pdf_candidates,...publicPaper}=paper;return respond({...publicPaper,key:await sign({purpose:'paper',identifier},env.SIGNING_KEY)});
    }
    if(['/api/search','/api/download'].includes(url.pathname)) {
      const ticket=await verify(body.key,env.SIGNING_KEY,'paper'),paper=await cached('metadata:'+ticket.identifier,ctx,()=>resolve(ticket.identifier)),found=await searchPaper(paper,ctx);
      const {url:pdfURL,...result}=found;
      if(found.ok){const name=filename(paper.csl.title);result.filename=name;result.download_url=url.origin+'/api/pdf?ticket='+await sign({purpose:'pdf',url:pdfURL,filename:name},env.SIGNING_KEY);}
      return respond(result);
    }
    return respond({error:'Unknown API'},404);
  }catch(e){return respond({error:e.message||'The cloud service could not complete this request.'},400);}
}};
