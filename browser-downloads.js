/* Small, dependency-free browser downloads and UTF-8 ZIP (store method). */
(function(root){
  const MAX_PDF=80*1024*1024,MAX_ZIP=100*1024*1024;
  async function readPDF(response) {
    if(!response.ok){let message='PDF download failed (HTTP '+response.status+').';try{message=(await response.json()).error||message;}catch{}throw Error(message);}
    if(+response.headers.get('content-length')>MAX_PDF)throw Error('PDF exceeds 80 MB.');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_PDF)throw Error('PDF exceeds 80 MB.');chunks.push(value);}}
    catch(e){await reader.cancel();throw e;}
    const blob=new Blob(chunks,{type:'application/pdf'});
    if(await blob.slice(0,5).text()!=='%PDF-')throw Error('The source did not return a PDF.');
    return blob;
  }
  function save(blob,name) {
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.hidden=true;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  function crc32(bytes) {let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
  function header(size,fields) {const bytes=new Uint8Array(size),v=new DataView(bytes.buffer);for(const [at,n,length] of fields)length===2?v.setUint16(at,n,true):v.setUint32(at,n,true);return bytes;}
  async function zip(files) {
    if(!files.length)throw Error('No files to download.');
    if(files.reduce((n,f)=>n+f.blob.size,0)>MAX_ZIP)throw Error('Batch exceeds 100 MB. Download fewer papers together.');
    const parts=[],directory=[],names=new Set();let offset=0;
    for(const f of files){
      let name=f.name.replace(/[\\/\x00-\x1f]/g,'_'),counter=1;const base=name;
      while(names.has(name))name=base.replace(/(\.[^.]*)?$/,(_,ext)=>' ('+(++counter)+')'+(ext||''));names.add(name);
      const n=new TextEncoder().encode(name),bytes=new Uint8Array(await f.blob.arrayBuffer()),crc=crc32(bytes),size=bytes.length;
      const local=header(30,[[0,0x04034b50],[4,20,2],[6,0x800,2],[14,crc],[18,size],[22,size],[26,n.length,2]]);
      const central=header(46,[[0,0x02014b50],[4,20,2],[6,20,2],[8,0x800,2],[16,crc],[20,size],[24,size],[28,n.length,2],[42,offset]]);
      parts.push(local,n,f.blob);directory.push(central,n);offset+=local.length+n.length+size;
    }
    const dirSize=directory.reduce((n,b)=>n+b.length,0),end=header(22,[[0,0x06054b50],[8,files.length,2],[10,files.length,2],[12,dirSize],[16,offset]]);
    return new Blob([...parts,...directory,end],{type:'application/zip'});
  }
  const api={readPDF,save,zip,MAX_ZIP};if(typeof module!=='undefined')module.exports=api;else root.BrowserDownloads=api;
})(globalThis);
