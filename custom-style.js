/* Learn a plain-text reference template from a metadata-verified journal article. */
(function(root) {
  const escapeRE=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const plain=s=>String(s||'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
  const pattern=s=>escapeRE(plain(s)).replace(/ /g,'\\s+').replace(/[-–—]/g,'[-–—]');
  const shortTitle=c=>plain(c['container-title-short']||c['journal-abbreviation']||c['short-container-title']||'');
  function authorName(author, options) {
    if(author.literal) return author.literal;
    const names=(author.given||'').split(/[\s.-]+/).filter(Boolean);
    const given=options.given==='full'?names.join(' '):names.map(n=>n[0]+(options.dots?'.':'')).join(options.spaced?' ':'');
    return options.order==='given-first'?[given,author.family].filter(Boolean).join(' '):[author.family,given].filter(Boolean).join(options.comma?', ':' ');
  }
  function authorList(authors, options) {
    const shown=options.etAl?authors.slice(0,options.limit):authors;
    const names=shown.map(a=>authorName(a,options));
    if(options.etAl && authors.length>options.limit) return names.join(options.separator)+options.etAl;
    return names.length>1 && options.last?names.slice(0,-1).join(options.separator)+options.last+names.at(-1):names.join(options.separator);
  }
  function infer(example, paper) {
    const c=paper.csl, input=plain(example).replace(/^\s*(?:\[\d+\]|\d+[.)])\s*/,''), spans=[];
    const overlaps=(start,end)=>spans.some(s=>start<s.end && end>s.start);
    function locate(value, key, expression) {
      if(!value) return null;
      const re=new RegExp(expression||pattern(value),'giu');let match;
      while((match=re.exec(input))) {
        if(!overlaps(match.index,match.index+match[0].length)) {
          const span={key,start:match.index,end:match.index+match[0].length,value:match[0]};spans.push(span);return span;
        }
      }
      return null;
    }
    const title=plain(c.title).replace(/[.]$/,''), titleSpan=locate(title,'title');
    locate(paper.doi,'doi');
    let journalSpan=locate(c['container-title'],'journal'), abbreviated=false;
    if(!journalSpan && shortTitle(c)) {
      const expr=shortTitle(c).split(/\s+/).map(w=>escapeRE(w.replace(/\.$/,''))+'\\.?').join('\\s+');
      journalSpan=locate(shortTitle(c),'journal',expr);abbreviated=!!journalSpan;
    }
    if(!journalSpan) throw Error('The journal name could not be matched. Use a complete reference example, preferably including its DOI.');
    const periods=abbreviated && journalSpan.value.replace(/\.$/,'').includes('.');
    // A lone final full stop is the field separator in undotted NLM abbreviations.
    if(abbreviated && !periods && journalSpan.value.endsWith('.')) {journalSpan.end--;journalSpan.value=journalSpan.value.slice(0,-1);}
    // Compare all supported name conventions to the example; prefer the longest match.
    let best=null;
    const authors=c.author||[];
    for(const order of ['family-first','given-first']) for(const given of ['initials','full'])
    for(const dots of [false,true]) for(const spaced of [false,true]) for(const comma of [false,true])
    for(const separator of [', ','; ',' ']) for(const last of ['', ' & ', ', & ', ' and ', ', and ']) {
      const base={order,given,dots,spaced,comma,separator,last};
      const options=[{...base,etAl:'',limit:0}];
      if(/et\s+al\.?/i.test(input)) for(let limit=1;limit<Math.min(authors.length,21);limit++) {
        for(const etAl of [' et al.', ', et al.', ' et al', ', et al']) options.push({...base,limit,etAl,last:''});
      }
      for(const option of options) {
        const names=authorList(authors,option);if(!names) continue;
        const match=new RegExp(pattern(names),'iu').exec(input);
        if(match && !overlaps(match.index,match.index+match[0].length) && (!best || match[0].length>best.value.length)) best={key:'authors',start:match.index,end:match.index+match[0].length,value:match[0],options:option};
      }
    }
    if(!best) throw Error('The author names could not be matched reliably. Include the author list and DOI in the example.');
    spans.push(best);
    const year=String(c.issued?.['date-parts']?.[0]?.[0]||'');
    // Parenthesised years distinguish publication dates from equal page/volume numbers.
    let yearSpan=null;
    if(year) {
      const re=new RegExp('\\(\\s*('+escapeRE(year)+')\\s*\\)','g');let match;
      while((match=re.exec(input))) {
        const start=match.index+match[0].indexOf(year);
        if(!overlaps(start,start+year.length)) {yearSpan={key:'year',start,end:start+year.length,value:year};spans.push(yearSpan);break;}
      }
      if(!yearSpan) yearSpan=locate(year,'year','(?<![\\d])'+escapeRE(year)+'(?![\\d])');
    }
    if(!yearSpan) throw Error('The publication year could not be matched. Include it in the example.');
    let page=plain(c.page||c['article-number']);
    if(page) {
      // Recognise shortened page ranges, e.g. 123-129 rendered as 123-9.
      const range=page.split(/[-–—]/);
      if(range.length===2) {
        const fullEnd=range[1], common=Array.from(fullEnd).findIndex((ch,i)=>ch!==range[0][i]);
        const shortened=common>0?fullEnd.slice(common):fullEnd;
        locate(page,'page',escapeRE(range[0])+'[-–—](?:'+escapeRE(fullEnd)+'|'+escapeRE(shortened)+')');
      } else locate(page,'page','(?<![\\w])'+pattern(page)+'(?![\\w])');
    }
    for(const key of ['volume','issue']) locate(c[key],key,'(?<![\\w])'+pattern(c[key]||'')+'(?![\\w])');
    spans.sort((a,b)=>a.start-b.start);
    let template='',position=0;
    for(const span of spans) {template+=input.slice(position,span.start)+'{'+span.key+'}';position=span.end;}
    template+=input.slice(position);
    const residual=template.replace(/\{\w+\}/g,'').replace(/https?:\/\/(?:dx\.)?doi\.org\//gi,'').replace(/\b(?:doi|vol|pp|p|no)\b/gi,'');
    if(/[\p{L}\p{N}]/u.test(residual)) throw Error('Some example fields could not be identified safely. Include its DOI and use a complete journal-article reference.');
    const smallWords=new Set(['a','an','the','of','and','or','to','in','for','on','by','with','at','as']);
    const substantive=titleSpan?titleSpan.value.split(/\s+/).slice(1).filter(word=>!smallWords.has(word.toLowerCase())):[];
    const titleCase=!titleSpan?'original':titleSpan.value===titleSpan.value.toUpperCase()?'upper':substantive.some(word=>/^[a-z]/.test(word))?'sentence':'title';
    return {version:1,template,authors:best.options,authorTerminalPeriod:best.value.endsWith('.'),abbreviated,periods,
      titleCase,
      pageDash:spans.find(s=>s.key==='page')?.value.includes('–')?'–':'-',
      shortenPages:!!page && !!spans.find(s=>s.key==='page') && spans.find(s=>s.key==='page').value.length<page.length,
      summary:`${best.options.order==='family-first'?'Surname first':'Given name first'}; ${best.options.given}; ${abbreviated?'abbreviated journals':'full journal names'}; example punctuation and field order.`};
  }
  function journal(c, definition) {
    const full=plain(c['container-title']);
    if(!definition.abbreviated) return {value:full,warning:''};
    const short=shortTitle(c);
    if(!short) return {value:full,warning:'No verified journal abbreviation was found; the full journal name is used. Check it against the journal requirements.'};
    const words=full.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
    const value=short.split(/\s+/).map(w=>{
      const bare=w.replace(/\./g,'');return bare+(definition.periods && !words.includes(bare.toLowerCase())?'.':'');
    }).join(' ');
    return {value,warning:''};
  }
  function format(paper, definition, title) {
    if(!definition?.template) throw Error('Paste an example below Custom and wait for format detection.');
    const c=paper.csl, j=journal(c,definition), rawTitle=plain(title??c.title).replace(/\.$/,'');
    let page=plain(c.page||c['article-number']);
    if(definition.shortenPages) page=page.replace(/^(\d+)[-–—](\d+)$/,(_,start,end)=>{
      let index=0;while(index<Math.min(start.length,end.length)-1 && start[index]===end[index])index++;
      return start+definition.pageDash+end.slice(index);
    });
    else page=page.replace(/[-–—]/g,definition.pageDash);
    const values={authors:authorList(c.author||[],definition.authors),title:definition.titleCase==='upper'?rawTitle.toUpperCase():rawTitle,journal:j.value,
      year:c.issued?.['date-parts']?.[0]?.[0]||'',volume:c.volume||'',issue:c.issue||'',page,doi:paper.doi||''};
    if(definition.authorTerminalPeriod && values.authors && !values.authors.endsWith('.')) values.authors+='.';
    let template=definition.template;
    if(!values.issue) template=template.replace(/\(\s*\{issue\}\s*\)/g,'');
    const missing=Object.entries(values).filter(([key,value])=>!value && template.includes('{'+key+'}')).map(([key])=>key);
    const text=template.replace(/\{(\w+)\}/g,(_,key)=>values[key]||'').replace(/\s+([,;:.])/g,'$1').trim();
    return {text,warning:[j.warning,missing.length?'Missing metadata: '+missing.join(', ')+'. Check the citation.':''].filter(Boolean).join(' ')};
  }
  const api={infer,format,authorList};
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  else root.CustomStyle=api;
})(typeof globalThis!=='undefined'?globalThis:this);
