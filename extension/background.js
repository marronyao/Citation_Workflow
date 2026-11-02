/* PDF bytes and website sessions stay in this browser. No cookie APIs or cloud uploads. */
const MAX_PDF=80*1024*1024,APP='https://marronyao.github.io/Citation_Workflow/';
const allowed=new Set(chrome.runtime.getManifest().host_permissions.map(pattern=>new URL(pattern).hostname));
let activeJob=null;
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  const job=activeJob;
  if(message?.channel!=='citation-workflow-source-pdf'||!job||job.finished||!job.transferToken||sender.tab?.id!==job.tabId||sender.frameId!==0||message.token!==job.transferToken)return;
  if(['transfer','chunk'].includes(message.type)){const {channel,token,...data}=message;job.send(data);respond({accepted:true});}
});
function approved(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!allowed.has(u.hostname))throw Error('This source host is not supported by the connector: '+u.hostname);return u.href;}
function trustedApp(value){try{const u=new URL(value);return u.origin==='https://marronyao.github.io'&&u.pathname.startsWith('/Citation_Workflow/');}catch{return false;}}
function encode(bytes){let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);}
function inspectPage(doi,title){
  const norm=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const words=document.body?.innerText||'',metadata=document.querySelector('meta[name="citation_doi"]')?.content||'';
  const challenge=/captcha|verify (?:you|that|your)|verifying your browser|just a moment|проверка.{0,30}робот/i.test(document.title+' '+words.slice(0,12000));
  if(challenge)return {challenge:true,candidates:[]};
  const actual=metadata.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase();
  if(actual&&doi&&actual!==doi.toLowerCase())return {mismatch:true,candidates:[]};
  const matching=(doi&&((actual===doi.toLowerCase())||words.toLowerCase().includes(doi.toLowerCase())))||(norm(title).length>=20&&norm(words).includes(norm(title)));
  if(!matching)return {candidates:[]};
  const links=[];const add=value=>{try{links.push(new URL(value,location.href).href);}catch{}};
  document.querySelectorAll('meta[name="citation_pdf_url"],meta[name="wkhealth_pdf_url"]').forEach(el=>add(el.content));
  document.querySelectorAll('iframe[src],embed[src],object[data]').forEach(el=>add(el.src||el.data));
  document.querySelectorAll('a[href]').forEach(el=>{if(/\.pdf(?:[?#]|$)|\/(?:pdf|download|dl)(?:[/?#]|$)|\/get\.php/i.test(el.href)||/^(?:GET|Download(?: PDF| full.?text)?)$/i.test(el.textContent.trim()))add(el.href);});
  return {matching:true,candidates:[...new Set(links)].slice(0,8)};
}
async function streamInSourceTab(url,token){
  const MAX=80*1024*1024,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),120000);
  const transfers=globalThis.__citationWorkflowTransfers||(globalThis.__citationWorkflowTransfers=Object.create(null));transfers[token]=controller;
  let reader;
  const send=async data=>{const reply=await chrome.runtime.sendMessage({channel:'citation-workflow-source-pdf',token,...data});if(!reply?.accepted)throw Error('Connector request ended.');};
  try{
    if(new URL(url).origin!==location.origin)throw Error('The PDF must be opened on its own source site.');
    const response=await fetch(url,{credentials:'include',redirect:'manual',signal:controller.signal});
    if(response.type==='opaqueredirect')throw Error('Open the PDF link in this source tab to complete its redirect.');
    if(!response.ok)throw Error('Source returned HTTP '+response.status+'. Complete verification or sign-in in this tab.');
    if(+response.headers.get('content-length')>MAX)throw Error('PDF exceeds 80 MB.');
    reader=response.body.getReader();let prefix=new Uint8Array(),size=0,sequence=0;
    while(prefix.length<5){const part=await reader.read();if(part.done)break;const next=new Uint8Array(prefix.length+part.value.length);next.set(prefix);next.set(part.value,prefix.length);prefix=next;}
    if(new TextDecoder().decode(prefix.slice(0,5))!=='%PDF-')throw Error('The source has not returned a PDF yet. Open its PDF in this tab.');
    await send({type:'transfer',total:+response.headers.get('content-length')||null});
    const emit=async bytes=>{
      size+=bytes.length;if(size>MAX)throw Error('PDF exceeds 80 MB.');
      for(let i=0;i<bytes.length;i+=196608){let text='';const part=bytes.subarray(i,i+196608);for(let k=0;k<part.length;k+=16384)text+=String.fromCharCode(...part.subarray(k,k+16384));await send({type:'chunk',sequence:sequence++,data:btoa(text)});}
    };
    await emit(prefix);while(true){const part=await reader.read();if(part.done)break;await emit(part.value);}
    return {size};
  }catch(error){await reader?.cancel().catch(()=>{});return {error:error.message};}
  finally{clearTimeout(timeout);delete transfers[token];}
}
async function fetchPDF(url,job){
  let current=approved(url);
  for(let redirect=0;redirect<5;redirect++){
    const response=await fetch(current,{credentials:'include',redirect:'manual',signal:AbortSignal.any([job.controller.signal,AbortSignal.timeout(120000)])});
    if(response.type==='opaqueredirect')throw Error('This download redirects in a way the connector cannot inspect. Open the PDF directly in the source tab.');
    if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel();if(!next)throw Error('Source redirect has no destination.');current=approved(new URL(next,current));continue;}
    if(!response.ok){await response.body?.cancel();throw Error('Source returned HTTP '+response.status+'. Complete verification or sign-in in the source tab.');}
    if(+response.headers.get('content-length')>MAX_PDF){await response.body.cancel();throw Error('PDF exceeds 80 MB.');}
    const reader=response.body.getReader();let prefix=new Uint8Array(),size=0,sequence=0;
    try{
      while(prefix.length<5){const part=await reader.read();if(part.done)break;const next=new Uint8Array(prefix.length+part.value.length);next.set(prefix);next.set(part.value,prefix.length);prefix=next;}
      if(new TextDecoder().decode(prefix.slice(0,5))!=='%PDF-')throw Error('The source has not returned a PDF yet. Open its PDF in the source tab.');
      job.send({type:'transfer',total:+response.headers.get('content-length')||null});
      const emit=bytes=>{size+=bytes.length;if(size>MAX_PDF)throw Error('PDF exceeds 80 MB.');for(let i=0;i<bytes.length;i+=196608)job.send({type:'chunk',sequence:sequence++,data:encode(bytes.subarray(i,i+196608))});};
      emit(prefix);while(true){const part=await reader.read();if(part.done)break;emit(part.value);}
      return size;
    }catch(error){await reader.cancel().catch(()=>{});throw error;}
  }
  throw Error('Too many source redirects.');
}
chrome.runtime.onConnect.addListener(port=>{
  if(port.name!=='citation-workflow'||!trustedApp(port.sender?.tab?.url)||port.sender?.frameId!==0){port.disconnect();return;}
  let job=null;
  const send=data=>{try{port.postMessage(data);}catch{}};
  const finish=(message,size)=>{
    if(!job||job.finished)return;job.finished=true;job.controller.abort();clearTimeout(job.timer);if(job.removed)chrome.tabs.onRemoved.removeListener(job.removed);
    if(job.transferToken&&job.tabId)chrome.scripting.executeScript({target:{tabId:job.tabId},func:token=>globalThis.__citationWorkflowTransfers?.[token]?.abort(),args:[job.transferToken]}).catch(()=>{});
    if(activeJob===job)activeJob=null;
    send(message?{type:'error',message}:{type:'done',size});
    if(!message)chrome.tabs.update(port.sender.tab.id,{active:true}).catch(()=>{});
  };
  port.onDisconnect.addListener(()=>finish('Connector request cancelled.'));
  port.onMessage.addListener(async message=>{
    if(message.type==='cancel'){finish('Verification cancelled.');return;}
    if(message.type!=='start')return;
    if(job||activeJob){send({type:'error',message:'Another connector request is active. Finish or cancel it first.'});return;}
    try{
      const url=approved(message.url),doi=String(message.doi||'').slice(0,300),title=String(message.title||'').slice(0,1000);
      if(!doi&&!title)throw Error('Paper identity is required.');
      job={controller:new AbortController(),finished:false,send,deadline:Date.now()+900000,last:new Map(),matching:false};activeJob=job;
      const tab=await chrome.tabs.create({url,active:true});job.tabId=tab.id;
      job.removed=id=>{if(id===job.tabId)finish('Source tab closed. You can retry from Citation Workflow.');};chrome.tabs.onRemoved.addListener(job.removed);
      send({type:'status',message:'Complete any verification or sign-in in the new source tab. Retrieval resumes when a matching PDF becomes available.'});
      const poll=async()=>{
        if(job.finished)return;
        if(Date.now()>job.deadline){finish('Verification timed out after 15 minutes. You can retry.');return;}
        try{
          const sourceTab=await chrome.tabs.get(job.tabId);if(!sourceTab.url||sourceTab.url==='about:blank')throw Error('Source tab is loading.');approved(sourceTab.url);
          let candidates=[];
          if(/\.pdf(?:[?#]|$)|\/pdf(?:[/?#]|$)/i.test(sourceTab.url))candidates=[sourceTab.url];
          else{
            const [result]=await chrome.scripting.executeScript({target:{tabId:job.tabId},func:inspectPage,args:[doi,title]});
            if(result?.result?.challenge)send({type:'status',message:'Complete any verification in the source tab. Citation Workflow is waiting.'});
            if(result?.result?.mismatch)throw Error('The source page identifies a different DOI.');
            if(result?.result?.matching)job.matching=true;
            candidates=result?.result?.candidates||[];
          }
          for(const candidate of candidates){
            if(job.finished)return;
            if(Date.now()-(job.last.get(candidate)||0)<15000)continue;job.last.set(candidate,Date.now());
            try{
              approved(candidate);let size;
              if(new URL(candidate).origin===new URL(sourceTab.url).origin){
                job.transferToken=crypto.randomUUID();
                const [transfer]=await chrome.scripting.executeScript({target:{tabId:job.tabId},func:streamInSourceTab,args:[candidate,job.transferToken]});
                if(transfer?.result?.error)throw Error(transfer.result.error);
                if(!Number.isFinite(transfer?.result?.size))throw Error('The source page could not complete PDF retrieval.');size=transfer.result.size;
              }else size=await fetchPDF(candidate,job);
              finish(null,size);return;
            }
            catch(error){if(job.finished)return;send({type:'status',message:error.message});}
          }
        }catch(error){if(!job.finished)send({type:'status',message:'Waiting for a readable source page. '+error.message});}
        if(!job.finished)job.timer=setTimeout(poll,2000);
      };
      await poll();
    }catch(error){if(job)finish(error.message);else send({type:'error',message:error.message});}
  });
});
