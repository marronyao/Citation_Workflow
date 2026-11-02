/* Public source adapters. No credentials, challenge solving or arbitrary URL proxy. */
export const THIRD_PARTY_HOSTS=['sci-hub.ru','sci-hub.st','sci-hub.se','z-library.sk','z-library.im','libgen.li','libgen.gs'];
export const THIRD_PARTY_NAMES=['Sci-Hub','Z-Library','Library Genesis'];
const providers=[
  {name:'Sci-Hub',origins:['https://sci-hub.ru','https://sci-hub.st'],path:doi=>'/'+encodeURIComponent(doi).replace(/%2F/gi,'/')},
  {name:'Z-Library',origins:['https://z-library.sk','https://z-library.im'],path:doi=>'/s/'+encodeURIComponent(doi)+'?type=articles'},
  {name:'Library Genesis',origins:['https://libgen.li','https://libgen.gs'],path:(doi,origin)=>origin.endsWith('.gs')?'/scimag/?q='+encodeURIComponent(doi):'/index.php?req='+encodeURIComponent(doi)+'&res=25&column=identifier&objects%5B%5D=a'}
];
const decode=s=>String(s||'').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n));
const text=s=>decode(s.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const normal=s=>text(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function attrs(tag) {const a={};for(const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))a[m[1].toLowerCase()]=decode(m[2]??m[3]);return a;}
export function parseSourcePage(html,base,paper,matchedRecord=false) {
  if(/captcha|verify (?:you|that|your)|verifying your browser|just a moment|ddos.guard|diamwall|cf-chl-|проверка.{0,30}робот/i.test(html))return {status:'verification_required',links:[]};
  if(/log\s*in to download|sign\s*in to download|login required|authorization required/i.test(text(html)))return {status:'login_required',links:[]};
  const doi=paper.doi.toLowerCase(),title=normal(paper.csl.title),body=text(html).toLowerCase();
  const metadata={};for(const tag of html.match(/<meta\b[^>]*>/gi)||[]){const a=attrs(tag);if(a.name)metadata[a.name.toLowerCase()]=a.content;}
  const advertisedDOI=metadata.citation_doi?.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//,'');
  if(advertisedDOI&&advertisedDOI!==doi)return {status:'no_match',links:[]};
  const matches=matchedRecord||advertisedDOI===doi||body.includes(doi)||(title.length>=20&&normal(html).includes(title));
  const links=[];
  function add(url,kind) {try{const target=new URL(url,base);if(target.protocol==='https:')links.push({url:target.href,kind});}catch{}}
  if(matches) {
    if(metadata.citation_pdf_url)add(metadata.citation_pdf_url,'pdf');
    for(const tag of html.match(/<(?:iframe|embed|object)\b[^>]*>/gi)||[]){const a=attrs(tag);if(a.src||a.data)add(a.src||a.data,'pdf');}
  }
  for(const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a=attrs(m[1]);if(!a.href)continue;
    const label=text(m[2]),matchingLink=(a.href+' '+label).toLowerCase().includes(doi)||(title.length>=20&&normal(label).includes(title));
    const download=/\.pdf(?:[?#]|$)|\/(?:pdf|download|dl)(?:[/?#]|$)|\/get\.php/i.test(a.href)||/^(?:get|download(?: pdf| full.?text)?)$/i.test(label);
    if((matches&&download)||matchingLink)add(a.href,download?'pdf':'record');
  }
  return {status:links.length?'candidates':'no_match',links:[...new Map(links.map(l=>[l.url,l])).values()].slice(0,5)};
}
export function sourceError(error) {
  const message=error?.message||String(error);
  return /HTTP (?:401)|login|sign.in/i.test(message)?'login_required':/HTTP (?:403|429|503|513)|verification|captcha|challenge/i.test(message)?'access_restricted':/timeout|abort/i.test(message)?'timeout':'unavailable';
}
export async function searchThirdParty(paper,io) {
  const attempts=[],sources=[],publishers=[];
  if(!paper.doi)return {attempts:['Third-party DOI search skipped: this record has no DOI.'],sources,publishers};
  const deadline=Date.now()+60000;
  for(const provider of providers) {
    const source={name:provider.name,status:'unavailable',attempts:[]};sources.push(source);
    const sourceDeadline=Math.min(deadline,Date.now()+20000);
    for(const origin of provider.origins) {
      const entry=origin+provider.path(paper.doi,origin);publishers.push({name:'Open '+provider.name+' · '+new URL(origin).hostname,url:entry});
      if(Date.now()>=sourceDeadline){source.attempts.push('Time budget reached.');break;}
      const queue=[{url:entry,kind:'record',matched:false}],seen=new Set();let requests=0;
      while(queue.length&&requests++<4&&Date.now()<sourceDeadline) {
        const candidate=queue.shift(),visit=candidate.kind+':'+candidate.url;if(seen.has(visit))continue;seen.add(visit);
        try {
          io.safeURL(candidate.url);
          const signal=AbortSignal.timeout(Math.max(1,Math.min(9000,sourceDeadline-Date.now())));
          if(candidate.kind==='pdf') {
            let pdf;
            try{pdf=await io.pdfResponse(candidate.url,{signal});}
            catch(error){
              if(/Source did not return a PDF/.test(error.message)&&new URL(candidate.url).origin===origin){queue.unshift({...candidate,kind:'record',matched:true});continue;}
              throw error;
            }
            await pdf.body.cancel();
            source.status='pdf_verified';source.attempts.push('Matching record found; PDF bytes verified.');
            attempts.push(...source.attempts.map(s=>provider.name+': '+s));
            return {ok:true,url:candidate.url,source:provider.name,attempts,sources,publishers};
          }
          const response=await io.upstream(candidate.url,{signal,headers:{Accept:'text/html'}});
          const parsed=parseSourcePage(await io.boundedText(response),response.url||candidate.url,paper,candidate.matched);
          source.status=parsed.status;
          if(parsed.status==='verification_required'||parsed.status==='login_required') {source.attempts.push(new URL(candidate.url).hostname+': '+(parsed.status==='verification_required'?'manual browser verification required.':'sign-in required.'));break;}
          if(parsed.status==='no_match')source.attempts.push(new URL(candidate.url).hostname+': no matching downloadable record found.');
          for(const link of parsed.links) {
            try{io.safeURL(link.url);queue.push(link);}
            catch(error){source.attempts.push(error.message);}
          }
        }catch(error){source.status=sourceError(error);source.attempts.push(new URL(candidate.url).hostname+': '+(error.message||String(error)));}
      }
      if(source.status==='candidates')source.status='unavailable';
    }
    if(source.attempts.some(s=>s.includes('manual browser verification')))source.status='verification_required';
    else if(source.attempts.some(s=>s.includes('sign-in required')))source.status='login_required';
    attempts.push(...source.attempts.map(s=>provider.name+': '+s));
  }
  return {ok:false,attempts,sources,publishers};
}
