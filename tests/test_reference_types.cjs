const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
// Exercise the actual browser bundle so missing style registration cannot fall back silently.
globalThis.window={};
vm.runInThisContext(fs.readFileSync('vendor/citation.js','utf8'));
const {Cite}=window;
const styles=['apa','vancouver','ama','harvard1','acs','chicago','ieee','mla9','oscola','bibtex','ris'];
const html=fs.readFileSync('index.html','utf8');
for(const id of ['style','batchStyle']) {
  const options=html.match(new RegExp('<select id="'+id+'">([\\s\\S]*?)</select>'))[1];
  assert.deepEqual([...options.matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]),[...styles,'custom']);
}
const source=fs.readFileSync('app.js','utf8').split('function renderCitation(')[0];
const context=vm.createContext({URL,structuredClone,Cite,CustomStyle:require('../custom-style.js'),localStorage:{getItem:()=>null},document:{getElementById:()=>({value:''})}});
vm.runInContext(source,context);
const preprint={kind:'preprint',platform:'arXiv',version:'1',identifier:'arxiv:1706.03762v1',doi:'10.48550/arXiv.1706.03762',publisher:'https://arxiv.org/abs/1706.03762v1',csl:{id:'arxiv:1706.03762v1',type:'article',genre:'Preprint',title:'Attention Is All You Need',author:[{given:'Ashish',family:'Vaswani'}],issued:{'date-parts':[[2017]]},publisher:'arXiv',URL:'https://arxiv.org/abs/1706.03762v1',DOI:'10.48550/arXiv.1706.03762',version:'1'}};
const conference={kind:'conference',identifier:'https://proceedings.mlr.press/v70/test.html',doi:'',publisher:'https://proceedings.mlr.press/v70/test.html',csl:{id:'conference-test',type:'paper-conference',title:'A conference paper',author:[{given:'Jane',family:'Doe'}],issued:{'date-parts':[[2026]]},'container-title':'Proceedings of ICML',publisher:'PMLR',page:'1-9',URL:'https://proceedings.mlr.press/v70/test.html'}};
const journal={kind:'journal',doi:'10.1234/biology',csl:{id:'journal-test',type:'article-journal',title:'DNA repair in Drosophila',author:[{given:'Jane',family:'Doe'},{given:'John',family:'Smith'}],issued:{'date-parts':[[2024]]},'container-title':'Journal of Biology','container-title-short':'J Biol',volume:'12',issue:'3',page:'101-109',DOI:'10.1234/biology'}};
const journalReferences=new Set();
for(const style of styles) {
  const reference=context.formatReference(journal,style,journal.csl.title).text;
  assert(reference.replace(/[{}]/g,'').includes('DNA repair in Drosophila'),style+' preserves scientific title');
  assert(reference.includes('2024'),style+' includes publication year');
  if(!['bibtex','ris'].includes(style))journalReferences.add(reference);
  const a=context.formatReference(preprint,style).text,b=context.formatReference(conference,style).text;
  assert(a.length>30);assert(b.length>30);
  if(style==='ris'){assert(a.startsWith('TY  - UNPB'));assert(a.includes('version 1'));assert(b.startsWith('TY  - CPAPER'));assert(b.includes('T2  - Proceedings of ICML'));assert(!b.includes('DO  - undefined'));}
  else if(style==='bibtex'){assert(a.startsWith('@misc'));assert(a.includes('eprint = {1706.03762v1}'));assert(b.startsWith('@inproceedings'));new Cite(a);new Cite(b);}
  else {assert(a.includes('Preprint'));assert(a.includes('version 1'));assert(b.includes('Proceedings of ICML'));}
}
assert.equal(journalReferences.size,9,'Every CSL style must produce its own journal reference');
console.log('Ordered single/batch selectors and journal/conference/versioned-preprint checks passed for all 11 formats');
