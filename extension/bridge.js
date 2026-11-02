/* Only the Citation Workflow page can initiate a visible, cancellable source tab. */
(() => {
  const channel='citation-workflow-connector-v1',jobs=new Map();
  const send=message=>window.postMessage({channel,direction:'extension',...message},location.origin);
  window.addEventListener('message',event=>{
    const m=event.data;
    if(event.source!==window||event.origin!==location.origin||m?.channel!==channel||m.direction!=='page')return;
    if(m.type==='ping'){send({type:'ready',version:'0.1.0'});return;}
    if(m.type==='cancel'){jobs.get(m.id)?.postMessage({type:'cancel'});return;}
    if(m.type!=='start'||typeof m.id!=='string')return;
    if(jobs.size){send({type:'error',id:m.id,message:'Another connector request is active. Finish or cancel it first.'});return;}
    const port=chrome.runtime.connect({name:'citation-workflow'});jobs.set(m.id,port);
    const keepAlive=setInterval(()=>{try{port.postMessage({type:'ping'});}catch{}},20000);
    port.onMessage.addListener(data=>{send({...data,id:m.id});if(['done','error'].includes(data.type)){clearInterval(keepAlive);jobs.delete(m.id);port.disconnect();}});
    port.onDisconnect.addListener(()=>{clearInterval(keepAlive);if(jobs.delete(m.id))send({id:m.id,type:'error',message:'Connector disconnected. Return to Citation Workflow and retry.'});});
    port.postMessage({type:'start',url:m.url,doi:m.doi,title:m.title});
  });
  send({type:'ready',version:'0.1.0'});
})();
