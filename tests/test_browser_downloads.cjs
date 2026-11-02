const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {readPDF,zip}=require('../browser-downloads.js');
test('download rejects HTML and HTTP errors, and accepts PDF bytes',async()=>{
  await assert.rejects(()=>readPDF(new Response('<html>login</html>')));
  await assert.rejects(()=>readPDF(new Response('{"error":"Not available"}',{status:400})),/Not available/);
  assert.equal(await (await readPDF(new Response('%PDF-1.7\nexample'))).text(),'%PDF-1.7\nexample');
});
test('PDF transfer progress reports streamed bytes with and without a known total',async()=>{
  for(const known of [true,false]) {
    const chunks=['%PDF-1.7\n','example'],events=[];
    const response=new Response(new ReadableStream({start(controller){for(const text of chunks)controller.enqueue(new TextEncoder().encode(text));controller.close();}}),{headers:known?{'content-length':'16'}:{}});
    const blob=await readPDF(response,(received,total)=>events.push([received,total]));
    assert.equal(blob.size,16);
    assert.deepEqual(events,[[0,known?16:null],[9,known?16:null],[16,known?16:null]]);
  }
});
test('ZIP progress includes every file and reports completion after creating the archive',async()=>{
  const events=[],blob=new Blob(['%PDF-1.7\nexample']);
  const archive=await zip([{name:'paper.pdf',blob},{name:'report.txt',blob:new Blob(['done'])}],(done,total)=>events.push([done,total]));
  assert(archive.size>blob.size);
  assert.deepEqual(events,[[0,2],[1,2],[2,2]]);
});
test('ZIP is readable by an independent implementation, including duplicate UTF-8 names',async()=>{
  const blob=new Blob(['%PDF-1.7\nexample']),archive=await zip([{name:'论文.pdf',blob},{name:'论文.pdf',blob},{name:'download-report.txt',blob:new Blob(['One paper failed; others succeeded.'])}]);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'citation-zip-')),target=path.join(dir,'test.zip');
  try{fs.writeFileSync(target,Buffer.from(await archive.arrayBuffer()));execFileSync('python',['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert len(z.namelist()) == 3; assert len(set(z.namelist())) == 3; assert z.read(z.namelist()[0]).startswith(b'%PDF-')",target]);}finally{fs.rmSync(dir,{recursive:true});}
});
