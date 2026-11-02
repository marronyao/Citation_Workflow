import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSourcePage,searchThirdParty,sourceError} from '../cloud/third-party.mjs';
import {safeURL} from '../cloud/worker.mjs';
const paper={doi:'10.1234/test',csl:{title:'A sufficiently long and precise test paper title'}};
test('record parser requires matching paper identity and resolves PDF embeds',()=>{
  assert.deepEqual(parseSourcePage('<p>Unrelated paper</p><iframe src="/wrong.pdf"></iframe>','https://sci-hub.ru/',paper).links,[]);
  assert.deepEqual(parseSourcePage('<p>10.1234/test</p><iframe src="/correct.pdf"></iframe>','https://sci-hub.ru/',paper).links,[{url:'https://sci-hub.ru/correct.pdf',kind:'pdf'}]);
  assert.equal(parseSourcePage('<meta name="citation_doi" content="10.1234/wrong"><p>10.1234/test</p><a href="/wrong.pdf">Download</a>','https://sci-hub.ru/',paper).status,'no_match');
});
test('verification and login pages are never parsed as PDF download records',()=>{
  for(const html of ['<title>Sci-Hub: проверка на робота</title>','<title>Verifying your browser | DiamWall</title><iframe src="/check"></iframe>','<p>CAPTCHA</p>'])assert.equal(parseSourcePage(html,'https://sci-hub.ru/',paper).status,'verification_required');
  assert.equal(parseSourcePage('<p>Log in to download</p>','https://z-library.sk/',paper).status,'login_required');
});
test('every configured source is actually requested and records its restriction separately',async()=>{
  const visited=[];
  const result=await searchThirdParty(paper,{safeURL,pdfResponse:()=>{throw Error('Should not try a PDF');},boundedText:r=>r.text(),upstream:async url=>{
    visited.push(url);
    if(url.includes('sci-hub.'))return new Response('<title>проверка на робота</title>');
    if(url.includes('z-library.'))return new Response('Log in to download');
    return new Response('<p>No results</p>');
  }});
  assert.equal(result.ok,false);assert.equal(visited.length,6);
  assert.deepEqual(result.sources.map(s=>s.status),['verification_required','login_required','no_match']);
  assert.equal(result.publishers.length,6);
});
test('download candidates and source redirects remain restricted to approved HTTPS hosts',async()=>{
  for(const url of ['https://sci-hub.ru.evil.org/a','https://127.0.0.1/a','http://sci-hub.ru/a','https://user:pass@libgen.li/a'])assert.throws(()=>safeURL(url));
  const result=await searchThirdParty(paper,{safeURL,boundedText:r=>r.text(),upstream:async()=>new Response('<p>10.1234/test</p><iframe src="https://127.0.0.1/private.pdf"></iframe>'),pdfResponse:()=>{throw Error('Must not fetch an unapproved URL');}});
  assert.equal(result.ok,false);assert(result.attempts.some(s=>s.includes('Unsupported source URL')));
  assert.equal(sourceError(Error('Source returned HTTP 513')),'access_restricted');
});
test('a matching catalogue record can lead through an HTML download intermediary',async()=>{
  const result=await searchThirdParty(paper,{safeURL,boundedText:r=>r.text(),upstream:async url=>{
    if(url==='https://sci-hub.ru/intermediary')return new Response('<a href="/paper.pdf">GET</a>');
    return new Response('<p>10.1234/test</p><a href="/intermediary">Download</a>');
  },pdfResponse:async url=>{
    if(url.endsWith('/intermediary'))throw Error('Source did not return a PDF.');
    assert.equal(url,'https://sci-hub.ru/paper.pdf');return new Response('%PDF-1.7\nTest');
  }});
  assert.equal(result.ok,true);assert.equal(result.url,'https://sci-hub.ru/paper.pdf');
});
