import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{normalizeIdentifier,safeURL,filename,sign,verify} from '../cloud/worker.mjs';
test('cloud validates identifiers and every upstream host',()=>{
  assert.equal(normalizeIdentifier('https://arxiv.org/pdf/1706.03762v1.pdf'),'arxiv:1706.03762v1');
  assert.equal(normalizeIdentifier('https://doi.org/10.1234/test'),'10.1234/test');
  for(const u of ['http://arxiv.org/pdf/a','https://localhost/a','https://127.0.0.1/a','https://arxiv.org.evil.org/a','https://user@arxiv.org/a','https://arxiv.org:8443/a','https://example.org/a'])assert.throws(()=>safeURL(u));
  assert.equal(filename('A / paper: title?'),'A paper title.pdf');
});
test('download tickets cannot be altered, reused for another purpose or expired',async()=>{
  const key='test-only-signing-key',token=await sign({purpose:'paper',identifier:'10.1234/test'},key);
  assert.equal((await verify(token,key,'paper')).identifier,'10.1234/test');
  await assert.rejects(()=>verify(token+'x',key,'paper'));
  await assert.rejects(()=>verify(token,key+'x','paper'));
  await assert.rejects(()=>verify(token,key,'pdf'));
  const original=Date.now;try{Date.now=()=>original()+7200000;await assert.rejects(()=>verify(token,key,'paper'));}finally{Date.now=original;}
});
test('cloud health, CORS, invalid input and rate limit responses',async()=>{
  const env={SIGNING_KEY:'test',ALLOWED_ORIGINS:'https://marronyao.github.io'},ctx={waitUntil(){}};
  const health=await worker.fetch(new Request('https://test/api/health'),env,ctx);
  assert.equal((await health.json()).mode,'cloud');
  const forbidden=await worker.fetch(new Request('https://test/api/health',{headers:{Origin:'https://evil.example'}}),env,ctx);assert.equal(forbidden.status,403);
  const invalid=await worker.fetch(new Request('https://test/api/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:'https://127.0.0.1/'})}),env,ctx);assert.equal(invalid.status,400);
  const limited=await worker.fetch(new Request('https://test/api/lookup',{method:'POST'}),{...env,RATE_LIMITER:{limit:async()=>({success:false})}},ctx);assert.equal(limited.status,429);
});

async function retrievalFixture(landing) {
  const original=globalThis.fetch,visited=[];
  globalThis.fetch=async input=>{
    const url=String(input);visited.push(url);let response;
    if(url.startsWith('https://api.crossref.org/works/'))response=Response.json({message:{DOI:'10.1016/j.cell.2012.11.001',title:['Syntaxin 17'],type:'journal-article',link:[{'content-type':'application/pdf',URL:'https://www.cell.com/blocked.pdf'}]}});
    else if(url.startsWith('https://pmc.ncbi.nlm.nih.gov/tools/idconv/'))response=Response.json({records:[]});
    else if(url==='https://www.cell.com/blocked.pdf')response=new Response('Denied',{status:403});
    else if(url.startsWith('https://doi.org/'))response=new Response(null,{status:302,headers:{location:'https://linkinghub.elsevier.com/retrieve/pii/test'}});
    else response=await landing(url);
    Object.defineProperty(response,'url',{value:url});return response;
  };
  try {
    const env={SIGNING_KEY:'test'},ctx={waitUntil(){}},key=await sign({purpose:'paper',identifier:'10.1016/j.cell.2012.11.001'},env.SIGNING_KEY);
    const response=await worker.fetch(new Request('https://test/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})}),env,ctx);
    return {data:await response.json(),visited};
  }finally{globalThis.fetch=original;}
}
test('publisher fallback follows allowlisted HTTP and HTML redirects after a failed registered PDF',async()=>{
  const {data,visited}=await retrievalFixture(url=>{
    if(url==='https://linkinghub.elsevier.com/retrieve/pii/test')return new Response('<meta content="2; url=\'/next?x=1&amp;y=2\'" HTTP-EQUIV="REFRESH">');
    if(url==='https://linkinghub.elsevier.com/next?x=1&y=2')return new Response(null,{status:302,headers:{location:'https://cell.com/cell/article/test'}});
    if(url==='https://cell.com/cell/article/test')return new Response('<meta name="citation_pdf_url" content="/paper.pdf">');
    if(url==='https://cell.com/paper.pdf')return new Response('%PDF-1.7\nTest');
    throw Error('Unexpected URL '+url);
  });
  assert.equal(data.ok,true);
  assert(data.attempts.some(s=>s.includes('HTTP 403')&&s.includes('access was denied')));
  assert(data.attempts.some(s=>s.includes('PMC: no matching')));
  assert(visited.includes('https://cell.com/paper.pdf'));
});
test('publisher HTML redirects cannot escape the source allowlist',async()=>{
  const {data,visited}=await retrievalFixture(()=>new Response('<meta http-equiv="refresh" content="0; url=https://127.0.0.1/private">'));
  assert.equal(data.ok,false);
  assert(data.attempts.some(s=>s.includes('Unsupported source URL (host: 127.0.0.1)')));
  assert(!visited.some(url=>url.includes('127.0.0.1')));
});
test('verification pages, connected source attempts and unconnected sources are distinct',async()=>{
  const {data}=await retrievalFixture(()=>new Response('<title>Just a moment</title><p>Verify you are human</p>'));
  assert.equal(data.ok,false);
  assert(data.attempts.some(s=>s.includes('verification page')));
  assert(data.verification_requests.some(v=>v.source==='Official article'&&v.url.startsWith('https://doi.org/')));
  assert(data.attempts.some(s=>s.startsWith('Not searched: ResearchGate')));
  assert.deepEqual(data.source_results.map(s=>s.name),['Sci-Hub','Z-Library','Library Genesis']);
  assert(data.attempts.some(s=>s.startsWith('Sci-Hub:')));
});

test('third-party matching record can return a signed cloud PDF download',async()=>{
  const {data}=await retrievalFixture(url=>{
    if(url.startsWith('https://linkinghub.elsevier.com/'))return new Response('No PDF');
    if(url==='https://sci-hub.ru/10.1016/j.cell.2012.11.001')return new Response('<p>10.1016/j.cell.2012.11.001</p><iframe src="/paper.pdf"></iframe>');
    if(url==='https://sci-hub.ru/paper.pdf')return new Response('%PDF-1.7\nTest');
    throw Error('Unexpected URL '+url);
  });
  assert.equal(data.ok,true);assert.equal(data.source,'Sci-Hub');
  const ticket=new URL(data.download_url).searchParams.get('ticket');
  assert.equal((await verify(ticket,'test','pdf')).url,'https://sci-hub.ru/paper.pdf');
});
