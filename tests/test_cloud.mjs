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
