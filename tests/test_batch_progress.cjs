const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup() {
  const nodes=new Map(),timers=new Set();let now=1000;
  function element(){return {textContent:'',value:0,max:1,hidden:true,disabled:false,children:[],classList:{add(){},remove(){}},setAttribute(){},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;}};}
  const $=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const context=vm.createContext({$,document:{createElement:element},Date:{now:()=>now},setInterval:fn=>{timers.add(fn);return fn;},clearInterval:fn=>timers.delete(fn),normalizeDOI:value=>{if(value==='invalid')throw Error('Invalid identifier');return value;},formatReference:()=>({text:'Reference'}),link(){}});
  const source=fs.readFileSync('app.js','utf8');
  vm.runInContext(source.slice(source.indexOf('let batchItems='),source.indexOf('function updateCustomVisibility')),context);
  return {$,context,timers,tick:ms=>{now+=ms;for(const fn of timers)fn();}};
}
test('batch shows slow lookup and source-search stages, continues after failure, then resets on retry',async()=>{
  const {$,context,timers,tick}=setup();let releaseLookup,releaseSearch;
  context.api=route=>new Promise(resolve=>{if(route==='lookup')releaseLookup=resolve;else releaseSearch=resolve;});
  $('batchDOIs').value='10.1234/paper\ninvalid';
  const run=$('batchForm').onsubmit({preventDefault(){}});
  assert.equal($('batchProgressPanel').hidden,false);
  assert.equal($('batchProgress').value,0);
  assert.equal($('batchProgress').max,4);
  assert.match($('batchStatus').textContent,/Reading reference data/);
  assert.equal($('batchCurrent').textContent,'10.1234/paper');
  tick(16000);
  assert.match($('batchElapsed').textContent,/0:16/);
  assert.match($('batchActivity').textContent,/Still working/);
  releaseLookup({key:'key',csl:{title:'Test paper'}});
  await new Promise(setImmediate);
  assert.equal($('batchProgress').value,1);
  assert.match($('batchStatus').textContent,/Searching full-text/);
  releaseSearch({ok:false,attempts:[]});await run;
  assert.equal($('batchProgress').value,4);
  assert.match($('batchStatus').textContent,/1 references; 1 lookups failed/);
  assert.equal($('batchFind').disabled,false);
  assert.equal(timers.size,0);
  assert.equal($('batchActivity').textContent,'Task finished');
  $('batchDOIs').value='10.1234/retry';
  const retry=$('batchForm').onsubmit({preventDefault(){}});
  assert.equal($('batchProgress').value,0);
  assert.equal($('batchProgress').max,2);
  assert.match($('batchElapsed').textContent,/0:00/);
  releaseLookup({key:'retry',csl:{title:'Retry'}});await new Promise(setImmediate);
  releaseSearch({ok:true,source:'Repository'});await retry;
  assert.equal(timers.size,0);
});
test('failed download preserves incomplete progress, stops timer and unlocks controls',async()=>{
  const {$,context,timers}=setup();
  context.fetchPaperPDF=async()=>{throw Error('Connection lost');};
  const item=context.createBatchRow('10.1234/paper');item.paper={};
  await item.downloadButton.onclick();
  assert.equal($('batchProgress').value,0);
  assert.match($('batchStatus').textContent,/Connection lost/);
  assert.equal($('batchActivity').textContent,'Task failed · you can retry.');
  assert.equal($('batchFind').disabled,false);
  assert.equal(timers.size,0);
});
