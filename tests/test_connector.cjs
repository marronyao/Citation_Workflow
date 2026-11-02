const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const manifest=require('../extension/manifest.json');
const event=()=>{const listeners=[];return {listeners,addListener:f=>listeners.push(f),removeListener:f=>{const at=listeners.indexOf(f);if(at>=0)listeners.splice(at,1);}};};
function background(){
  const connect=event(),removed=event(),timers=new Map(),calls=[];let timer=0,inspection={challenge:true,candidates:[]};
  const chrome={runtime:{getManifest:()=>manifest,onConnect:connect,onMessage:event()},tabs:{onRemoved:removed,create:async options=>{calls.push(options);return {id:2};},get:async()=>({url:'https://www.cell.com/article'}),update:async()=>{}},scripting:{executeScript:async options=>{
    if(options.func.name!=='streamInSourceTab')return [{result:inspection}];
    const [url,token]=options.args;const result=await context.streamInSourceTab(url,token);return [{result}];
  }}};
  chrome.runtime.sendMessage=async message=>{let reply;chrome.runtime.onMessage.listeners[0](message,{tab:{id:2},frameId:0},value=>reply=value);return reply;};
  const context=vm.createContext({chrome,location:{origin:'https://www.cell.com'},crypto,URL,AbortController,AbortSignal,TextDecoder,Uint8Array,Date,btoa,setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),fetch:async(url,options)=>{assert.equal(options.credentials,'include');assert.equal(options.redirect,'manual');return new Response('%PDF-1.7\nverified session');}});
  vm.runInContext(fs.readFileSync('extension/background.js','utf8'),context);
  function port(url='https://marronyao.github.io/Citation_Workflow/'){
    const messages=event(),disconnect=event(),sent=[];let closed=false;
    const p={name:'citation-workflow',sender:{frameId:0,tab:{id:1,url}},onMessage:messages,onDisconnect:disconnect,postMessage:m=>sent.push(m),disconnect:()=>{closed=true;}};
    connect.listeners[0](p);return {sent,get closed(){return closed;},send:m=>messages.listeners[0]?.(m)};
  }
  return {port,calls,timers,removed,context,setInspection:value=>inspection=value};
}
test('connector waits for human verification, then transfers a PDF from the browser session',async()=>{
  const b=background(),p=b.port();
  await p.send({type:'start',url:'https://www.cell.com/article',doi:'10.1234/test',title:'Test paper'});
  assert.equal(b.calls.length,1);assert.equal(p.sent.some(m=>m.type==='done'),false);
  b.setInspection({matching:true,candidates:['https://www.cell.com/paper.pdf']});
  await [...b.timers.values()][0]();
  const chunks=p.sent.filter(m=>m.type==='chunk');assert(chunks.length>0);
  assert.equal(Buffer.concat(chunks.map(m=>Buffer.from(m.data,'base64'))).toString(),'%PDF-1.7\nverified session');
  assert.equal(p.sent.at(-1).type,'done');assert.equal(b.removed.listeners.length,0);
});
test('only the app path can initiate jobs and only approved HTTPS sources can be opened',async()=>{
  const b=background();assert(b.port('https://example.org/').closed);assert(b.port('https://marronyao.github.io/another-project/').closed);
  const p=b.port();await p.send({type:'start',url:'https://127.0.0.1/private',doi:'10.1234/test'});
  assert.equal(b.calls.length,0);assert.match(p.sent.at(-1).message,/not supported/);
});
test('cancellation and a closed verification tab end waiting without transferring bytes',async()=>{
  for(const closeTab of [false,true]){
    const b=background(),p=b.port();await p.send({type:'start',url:'https://www.cell.com/article',doi:'10.1234/test'});
    if(closeTab)b.removed.listeners[0](2);else await p.send({type:'cancel'});
    assert.equal(p.sent.at(-1).type,'error');assert.equal(p.sent.some(m=>m.type==='chunk'),false);
    assert.equal(b.timers.size,0);
  }
});
test('connector rejects concurrent jobs and never treats a conflicting DOI as a matching page',async()=>{
  const b=background(),p=b.port();await p.send({type:'start',url:'https://www.cell.com/article',doi:'10.1234/test'});
  const p2=b.port();await p2.send({type:'start',url:'https://www.cell.com/article',doi:'10.1234/test'});assert.match(p2.sent.at(-1).message,/Another connector/);
  b.context.document={title:'Article',body:{innerText:'10.1234/test'},querySelector:()=>({content:'10.1234/wrong'})};
  assert.equal(b.context.inspectPage('10.1234/test','Test paper').mismatch,true);
  await p.send({type:'cancel'});
});
test('source chunks without an active transfer token or from another tab are ignored',async()=>{
  const b=background(),p=b.port();await p.send({type:'start',url:'https://www.cell.com/article',doi:'10.1234/test'});
  let reply;const receive=b.context.chrome.runtime.onMessage.listeners[0],message={channel:'citation-workflow-source-pdf',type:'chunk',sequence:0,data:'bad'};
  receive(message,{tab:{id:2},frameId:0},value=>reply=value);
  receive({...message,token:'forged'},{tab:{id:999},frameId:0},value=>reply=value);
  assert.equal(reply,undefined);assert.equal(p.sent.some(m=>m.type==='chunk'),false);await p.send({type:'cancel'});
});
function client(){
  const listeners=[],posted=[],window={postMessage:m=>posted.push(m),addEventListener:(name,fn)=>{if(name==='message')listeners.push(fn);},dispatchEvent(){}};
  const context=vm.createContext({window,location:{origin:'https://marronyao.github.io'},Event,crypto,Uint8Array,Blob,atob,setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(fs.readFileSync('connector-client.js','utf8'),context);
  const send=async(data,origin='https://marronyao.github.io')=>listeners[0]({source:window,origin,data:{channel:'citation-workflow-connector-v1',direction:'extension',...data}});
  return {api:window.CitationConnector,posted,send};
}
test('page client validates ordered PDF chunks and rejects incomplete transfers',async()=>{
  const c=client();await c.send({type:'ready'},'https://evil.example');assert.equal(c.api.available,false);await c.send({type:'ready'});
  const job=c.api.download({url:'https://www.cell.com/article',paper:{doi:'10.1234/test',csl:{title:'Test'}}}),id=c.posted.at(-1).id;
  await c.send({id,type:'transfer'});const bytes=Buffer.from('%PDF-1.7\nverified');await c.send({id,type:'chunk',sequence:0,data:bytes.toString('base64')});await c.send({id,type:'done',size:bytes.length});assert.equal(await (await job.promise).text(),bytes.toString());
  const broken=c.api.download({url:'https://www.cell.com/article',paper:{csl:{title:'Test'}}}),badId=c.posted.at(-1).id;
  const rejection=assert.rejects(broken.promise,/Incomplete/);await c.send({id:badId,type:'done',size:20});await rejection;
});
test('ordinary cloud PDFs work without a connector or progress callback, and browser PDFs are reused',async()=>{
  const source=fs.readFileSync('app.js','utf8'),part=source.slice(source.indexOf('const browserPDFs='),source.indexOf('function link('));let calls=0;
  const context=vm.createContext({URL,AbortSignal,BrowserDownloads:require('../browser-downloads.js'),api:async()=>{calls++;return {ok:true,download_url:'https://citation-workflow-api.marronyao.workers.dev/api/pdf'};},fetch:async()=>new Response('%PDF-1.7\ncloud download')});
  vm.runInContext("const API='https://citation-workflow-api.marronyao.workers.dev';"+part,context);
  const paper={doi:'10.1234/test',identifier:'10.1234/test',csl:{title:'Test paper'}};
  assert.equal(await (await context.fetchPaperPDF(paper,null,true)).blob.text(),'%PDF-1.7\ncloud download');
  assert.equal(await (await context.fetchPaperPDF(paper,undefined,true)).blob.text(),'%PDF-1.7\ncloud download');
  context.rememberBrowserPDF(paper,new Blob(['%PDF-1.7\nbrowser download']));
  assert.equal(await (await context.fetchPaperPDF(paper)).blob.text(),'%PDF-1.7\nbrowser download');assert.equal(calls,2);
});
