/* Page-side connector protocol. Only PDF bytes are returned; no sessions are uploaded. */
(() => {
  const channel='citation-workflow-connector-v1',pending=new Map();let available=false;
  const post=message=>window.postMessage({channel,direction:'page',...message},location.origin);
  const changed=()=>window.dispatchEvent(new Event('citation-connector-ready'));
  window.addEventListener('message',async event=>{
    const m=event.data;if(event.source!==window||event.origin!==location.origin||m?.channel!==channel||m.direction!=='extension')return;
    if(m.type==='ready'){available=true;changed();return;}
    const job=pending.get(m.id);if(!job)return;
    try{
      if(m.type==='status')job.onStatus(m.message);
      if(m.type==='transfer'){job.total=m.total;job.chunks=[];job.size=0;job.sequence=0;}
      if(m.type==='chunk'){
        if(m.sequence!==job.sequence++)throw Error('Connector PDF chunks arrived out of order.');
        const data=Uint8Array.from(atob(m.data),c=>c.charCodeAt(0));job.size+=data.length;if(job.size>80*1024*1024)throw Error('PDF exceeds 80 MB.');job.chunks.push(data);job.onProgress(job.size,job.total);
      }
      if(m.type==='error')throw Error(m.message);
      if(m.type==='done'){
        if(m.size!==job.size)throw Error('Incomplete connector PDF transfer.');
        const blob=new Blob(job.chunks,{type:'application/pdf'});if(await blob.slice(0,5).text()!=='%PDF-')throw Error('Connector did not return a PDF.');
        clearTimeout(job.timer);pending.delete(m.id);job.resolve(blob);
      }
    }catch(error){post({type:'cancel',id:m.id});clearTimeout(job.timer);pending.delete(m.id);job.reject(error);}
  });
  window.CitationConnector={get available(){return available;},
    download({url,paper,onStatus=()=>{},onProgress=()=>{}}){
      if(!available)return {promise:Promise.reject(Error('Install the optional connector and reload this page.')),cancel(){}};
      const id=crypto.randomUUID();let cancel;
      const promise=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{post({type:'cancel',id});pending.delete(id);reject(Error('Connector request timed out.'));},910000);
        pending.set(id,{resolve,reject,onStatus,onProgress,timer,chunks:[],size:0,sequence:0});
        cancel=()=>{post({type:'cancel',id});clearTimeout(timer);pending.delete(id);reject(Error('Verification cancelled.'));};
        post({type:'start',id,url,doi:paper.doi,title:paper.csl.title});
      });return {promise,cancel};
    }};
  post({type:'ping'});setTimeout(()=>post({type:'ping'}),1000);
})();
