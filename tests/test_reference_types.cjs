const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {Cite}=require('@citation-js/core');require('@citation-js/plugin-csl');require('@citation-js/plugin-bibtex');
const source=fs.readFileSync('app.js','utf8').split('function renderCitation(')[0];
const context=vm.createContext({URL,structuredClone,Cite,CustomStyle:require('../custom-style.js'),localStorage:{getItem:()=>null},document:{getElementById:()=>({value:''})}});
vm.runInContext(source,context);
const preprint={kind:'preprint',platform:'arXiv',version:'1',identifier:'arxiv:1706.03762v1',doi:'10.48550/arXiv.1706.03762',publisher:'https://arxiv.org/abs/1706.03762v1',csl:{id:'arxiv:1706.03762v1',type:'article',genre:'Preprint',title:'Attention Is All You Need',author:[{given:'Ashish',family:'Vaswani'}],issued:{'date-parts':[[2017]]},publisher:'arXiv',URL:'https://arxiv.org/abs/1706.03762v1',DOI:'10.48550/arXiv.1706.03762',version:'1'}};
const conference={kind:'conference',identifier:'https://proceedings.mlr.press/v70/test.html',doi:'',publisher:'https://proceedings.mlr.press/v70/test.html',csl:{id:'conference-test',type:'paper-conference',title:'A conference paper',author:[{given:'Jane',family:'Doe'}],issued:{'date-parts':[[2026]]},'container-title':'Proceedings of ICML',publisher:'PMLR',page:'1-9',URL:'https://proceedings.mlr.press/v70/test.html'}};
for(const style of ['apa','vancouver','harvard1','bibtex','ris']) {
  const a=context.formatReference(preprint,style).text,b=context.formatReference(conference,style).text;
  assert(a.length>30);assert(b.length>30);
  if(style==='ris'){assert(a.startsWith('TY  - UNPB'));assert(a.includes('version 1'));assert(b.startsWith('TY  - CPAPER'));assert(b.includes('T2  - Proceedings of ICML'));assert(!b.includes('DO  - undefined'));}
  else if(style==='bibtex'){assert(a.startsWith('@misc'));assert(a.includes('eprint = {1706.03762v1}'));assert(b.startsWith('@inproceedings'));new Cite(a);new Cite(b);}
  else {assert(a.includes('Preprint'));assert(a.includes('version 1'));assert(b.includes('Proceedings of ICML'));}
}
console.log('Conference and versioned-preprint APA/Vancouver/Harvard/BibTeX/RIS checks passed');
