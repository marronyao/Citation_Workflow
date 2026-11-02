const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('app.js','utf8').split('function notice(')[0];
const context=vm.createContext({URL,localStorage:{getItem:()=>null},document:{getElementById:()=>null}});
vm.runInContext(source,context);
assert.equal(context.normalizeDOI(' https://doi.org/10.1234/Test '),'10.1234/Test');
assert.equal(context.normalizeFolder('"D:/Papers"'),'D:\\Papers');
assert.throws(()=>context.normalizeFolder('Papers'));
assert.equal(context.normalizeFolder('/Users/test/Research papers','macos'),'/Users/test/Research papers');
assert.equal(context.normalizeFolder('/home/test/Papers','linux'),'/home/test/Papers');
assert.equal(context.normalizeFolder('"~/Downloads"','linux'),'~/Downloads');
assert.throws(()=>context.normalizeFolder('D:/Papers','macos'));
assert.throws(()=>context.normalizeFolder('/home/test/Papers','windows'));
assert.throws(()=>context.normalizeFolder('relative/path','linux'));
assert.throws(()=>context.normalizeFolder('/tmp/a\0b','linux'));
assert.throws(()=>context.normalizeFolder('/tmp/Papers','unknown'));
assert.equal(context.sentenceCase('The Role of DNA in Repair: Evidence From mRNA'),'The role of DNA in repair: Evidence from mRNA');
assert.equal(context.sentenceCase('Studies in Parkinson Disease and Drosophila','Parkinson, Drosophila'),'Studies in Parkinson disease and Drosophila');
assert.equal(context.journalCase('the journal of biology and medicine'),'The Journal of Biology and Medicine');
assert.equal(context.normalizeDOI('https://arxiv.org/pdf/1706.03762v1.pdf'),'arxiv:1706.03762v1');
assert.equal(context.normalizeDOI('https://proceedings.mlr.press/v70/test.html'),'https://proceedings.mlr.press/v70/test.html');
assert.throws(()=>context.normalizeDOI('https://arxiv.org.evil.example/abs/1706.03762'));
// Exercise the stored-system migration and switch destinations with unsaved batch input.
const elements=new Map();
const getElement=id=>{
  if(!elements.has(id)) elements.set(id,{value:'',textContent:'',hidden:true});
  return elements.get(id);
};
let savedSettings;
const settingsContext=vm.createContext({URL,document:{getElementById:getElement},localStorage:{
  getItem:()=>JSON.stringify({folder:'D:\\Research papers',autoDownload:false}),
  setItem:(_key,value)=>{savedSettings=JSON.parse(value);}
}});
vm.runInContext(fs.readFileSync('app.js','utf8').split('async function doDownload(')[0]+'\nfunction refreshBatchActions() {}',settingsContext);
settingsContext.updateFolder();
assert.equal(getElement('downloadSystem').value,'windows');
settingsContext.changeSystem('macos');
assert.equal(getElement('folder').placeholder,'e.g. /Users/yourname/Downloads');
getElement('batchWorkspace').hidden=false;
getElement('batchFolder').value='/Users/test/Papers';
settingsContext.changeSystem('linux');
getElement('batchFolder').value='~/Downloads';
settingsContext.changeSystem('macos');
assert.equal(getElement('batchFolder').value,'/Users/test/Papers');
settingsContext.changeSystem('linux');
assert.equal(getElement('batchFolder').value,'~/Downloads');
settingsContext.changeSystem('windows');
assert.equal(getElement('batchFolder').value,'D:\\Research papers');
assert.equal(savedSettings.autoDownload,false);
console.log('Frontend identifier, cross-platform path and biology case checks passed');
