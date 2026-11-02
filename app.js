/* Static frontend; downloads are delegated to the loopback-only companion. */
const $ = id => document.getElementById(id);
const API = 'http://127.0.0.1:8765';
let token = '', record = null, busy = false, pendingDownload = false;
let config = {folder:'', mirror:'', autoDownload:true};
try { Object.assign(config, JSON.parse(localStorage.getItem('citation-settings') || '{}')); } catch {}
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function normalizeDOI(value) {
  let s = value.trim().replace(/^["']+|["']+$/g,'').trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i,'');
  try { s = decodeURIComponent(s); } catch { throw Error('The DOI contains invalid URL encoding.'); }
  if (!/^10\.\d{4,9}\/[^\s<>"']+$/i.test(s)) throw Error('Enter a valid DOI or https://doi.org/ link.');
  return s;
}
function normalizeFolder(s) {
  s = s.trim().replace(/^["']+|["']+$/g,'').trim().replaceAll('/','\\');
  if (!/^[a-z]:\\/i.test(s) || /[<>"|?*\x00-\x1f]/.test(s) || s.slice(2).includes(':')) throw Error('Enter an absolute Windows path, e.g. D:\\Papers.');
  return s;
}
function sentenceCase(title, protectedText='') {
  const protectedWords = protectedText.split(',').map(s=>s.trim()).filter(Boolean);
  // Scientific abbreviations and mixed-case tokens retain their case. Human review is still needed.
  let first = true;
  let result = title.replace(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9'’.-]*/g, (word, offset) => {
    const head = first || /[:?!—–]\s*$/.test(title.slice(0,offset)) || /\s-\s*$/.test(title.slice(0,offset));
    first = false;
    if (word === 'I' || /^[A-Z0-9-]{2,}$/.test(word) || /[a-z][A-Z]/.test(word) || /[A-Z].*[A-Z]/.test(word)) return word;
    const lower = word.toLocaleLowerCase('en');
    return head ? lower[0].toLocaleUpperCase('en') + lower.slice(1) : lower;
  });
  for (const word of protectedWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    result = result.replace(new RegExp('(?<![\\p{L}\\p{N}])'+escaped+'(?![\\p{L}\\p{N}])','giu'),word);
  }
  return result;
}
function journalCase(title) {
  const small = new Set(['a','an','the','and','or','but','nor','for','yet','so','as','at','by','in','of','on','per','to','up','via']);
  let first = true;
  return title.replace(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9'’.-]*/g,(word,offset)=>{
    const head = first || /[:?!—–]\s*$/.test(title.slice(0,offset)); first=false;
    if (/^[A-Z0-9-]{2,}$/.test(word) || /[a-z][A-Z]/.test(word)) return word;
    const lower=word.toLowerCase();
    return !head && small.has(lower) ? lower : lower[0].toUpperCase()+lower.slice(1);
  });
}
function notice(message, error=false) { $('notice').textContent=message; $('notice').hidden=!message; $('notice').classList.toggle('error',error); }
function lock(value) { busy=value; $('search').disabled=value; $('download').disabled=value; $('doi').disabled=value; }
async function connect() {
  try {
    const r = await fetch(API+'/api/health',{signal:AbortSignal.timeout(3500)});
    if (!r.ok) throw Error();
    token=(await r.json()).token;
    return true;
  } catch {
    token=''; return false;
  }
}
async function api(route, payload) {
  if (!token && !await connect()) throw Error('Double-click start.bat to start the local assistant, then open http://127.0.0.1:8765. If it is already running, check that your browser allows local network access.');
  const response=await fetch(API+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Citation-Token':token},body:JSON.stringify(payload),signal:AbortSignal.timeout(600000)});
  const data=await response.json(); if (!response.ok) throw Error(data.error || 'The local assistant could not complete the request.'); return data;
}
function link(label,url,parent) {
  if (!/^https?:\/\//i.test(url)) return;
  const a=document.createElement('a'); a.textContent=label+' ↗'; a.href=url; a.target='_blank'; a.rel='noopener noreferrer'; parent.append(a);
}
function cleanPreview(markup) {
  const doc=new DOMParser().parseFromString(markup,'text/html');
  for(const element of [...doc.body.querySelectorAll('*')]) {
    if (!['DIV','SPAN','I','EM','B','STRONG','SUP','SUB','A'].includes(element.tagName)) { element.replaceWith(document.createTextNode(element.textContent)); continue; }
    for (const attr of [...element.attributes]) if (attr.name!=='class') element.removeAttribute(attr.name);
  }
  return doc.body.innerHTML;
}
function renderCitation() {
  if (!record) return;
  try {
    const style=$('style').value, csl=structuredClone(record.csl);
    csl.title=$('articleTitle').value.replace(/\.$/,'');
    if (style==='apa') csl['container-title']=journalCase(csl['container-title']||'');
    // citeproc's nocase span preserves the user-reviewed scientific title.
    if (!['bibtex','ris'].includes(style)) csl.title='<span class="nocase">'+escapeHTML(csl.title)+'</span>';
    const cite=new Cite(csl);
    if (style==='ris') {
      const lines=['TY  - JOUR','TI  - '+$('articleTitle').value];
      (csl.author||[]).forEach(a=>lines.push('AU  - '+(a.literal || [a.family,a.given].filter(Boolean).join(', '))));
      for (const [tag,value] of [['JO',csl['container-title']],['PY',csl.issued?.['date-parts']?.[0]?.[0]],['VL',csl.volume],['IS',csl.issue],['SP',csl.page?.split('-')[0]],['EP',csl.page?.split('-')[1]],['DO',record.doi],['UR',record.publisher]]) if(value) lines.push(tag+'  - '+String(value).replace(/[\r\n]/g,' '));
      lines.push('ER  -'); $('citationText').value=lines.join('\n'); $('preview').textContent='RIS format, ready to import into EndNote, Zotero and other reference managers.';
    } else if(style==='bibtex') {
      $('citationText').value=cite.format('bibtex'); $('preview').textContent='BibTeX format, ready for LaTeX and reference managers.';
    } else {
      const options={format:'html',template:style,lang:'en-US'};
      $('preview').innerHTML=cleanPreview(cite.format('bibliography',options));
      $('citationText').value=cite.format('bibliography',{...options,format:'text'}).trim();
    }
    $('copy').disabled=false; $('copyStatus').textContent='';
  } catch(e) { $('copy').disabled=true; notice('Unable to generate the reference: '+e.message,true); }
}
function displayRecord() {
  const c=record.csl;
  $('empty').hidden=true; $('paper').hidden=false;
  $('paperTitle').textContent=c.title;
  $('authors').textContent=(c.author||[]).map(a=>a.literal||[a.family,a.given].filter(Boolean).join(', ')).join('; ');
  $('journalMeta').textContent=[c['container-title'],c.issued?.['date-parts']?.[0]?.[0],c.volume && c.volume+(c.issue?'('+c.issue+')':''),c.page].filter(Boolean).join(' · ');
  $('identifiers').textContent='DOI: '+record.doi+(record.pmid?' · PMID: '+record.pmid:'')+(record.pmc?' · '+record.pmc:'');
  $('sourceLinks').replaceChildren();
  if(record.pmid) link('PubMed','https://pubmed.ncbi.nlm.nih.gov/'+record.pmid+'/', $('sourceLinks'));
  record.sources.forEach(s=>link(s.name,s.url,$('sourceLinks')));
  $('pubmedStatus').textContent=record.pmid?'Paper found with an exact DOI match':'No confirmed PubMed record; using DOI metadata';
  $('sourceStatus').textContent=record.pmc?'Search order: PMC → publisher → custom mirror':'Search order: publisher → custom mirror';
  $('downloadStatus').textContent='Ready to download'; $('attemptDetails').hidden=true;
  $('articleTitle').disabled=false;
  $('articleTitle').value=$('style').value==='apa'?sentenceCase(c.title,$('protected').value):c.title;
  renderCitation();
}
function showSettings() {
  $('folder').value=config.folder; $('mirror').value=config.mirror; $('autoDownload').checked=config.autoDownload;
  $('settingsError').textContent=''; $('settings').showModal();
}
function updateFolder() { $('folderLabel').textContent=config.folder || 'No Windows folder selected'; }
async function doDownload() {
  if(!record || busy) return;
  if(!config.folder) { pendingDownload=true; showSettings(); return; }
  lock(true); $('downloadStatus').textContent='Finding full text and downloading the PDF…'; notice('Checking PDF sources in order. Some websites may take a moment to respond.');
  try {
    const result=await api('download',{key:record.key,folder:config.folder,mirror:config.mirror});
    $('attempts').replaceChildren(); (result.attempts||[]).forEach(s=>{const li=document.createElement('li');li.textContent=s;$('attempts').append(li);}); $('attemptDetails').hidden=!(result.attempts?.length);
    if(result.ok) {
      $('downloadStatus').textContent=`PDF saved · ${(result.bytes/1024/1024).toFixed(2)} MB`;
      $('sourceStatus').textContent='Full text retrieved from '+result.source; notice([...record.warnings,'Saved to: '+result.path].join('\n'));
    } else {
      $('downloadStatus').textContent='Automatic download unavailable; sign-in or manual download required'; notice('Your reference is ready, but the PDF could not be downloaded. See the source search history for details.');
      $('loginLink').href=result.login; $('loginDialog').showModal();
    }
  } catch(e) { $('downloadStatus').textContent='Download failed'; notice(e.message,true); }
  finally {lock(false);}
}
$('lookupForm').addEventListener('submit',async e=>{
  e.preventDefault(); if(busy) return;
  try {
    const doi=normalizeDOI($('doi').value); $('doi').value=doi;
    // Clear old results so a failed lookup cannot download/copy an earlier paper accidentally.
    record=null; $('paper').hidden=true; $('empty').hidden=false; $('articleTitle').value=''; $('articleTitle').disabled=true; $('citationText').value=''; $('preview').textContent='Searching…'; $('copy').disabled=true;
    lock(true); notice('Searching PubMed and retrieving paper metadata…');
    record=await api('lookup',{doi}); displayRecord(); notice(record.warnings.join('\n'));
  } catch(e) { notice(e.message,true); }
  finally {lock(false);}
  if(record && config.autoDownload) await doDownload();
});
$('example').onclick=()=>{$('doi').value='10.1371/journal.pbio.3000117'; $('doi').focus();};
$('download').onclick=doDownload;
$('settingsOpen').onclick=showSettings;
$('settingsCancel').onclick=()=>{pendingDownload=false;$('settings').close();};
$('settings').addEventListener('cancel',()=>{pendingDownload=false;});
$('settingsForm').onsubmit=e=>{
  e.preventDefault();
  try {
    const folder=normalizeFolder($('folder').value), mirror=$('mirror').value.trim().replace(/\/$/,'');
    if(mirror && !/^https?:\/\/[^/]+(?:\/.*)?$/i.test(mirror)) throw Error('Enter a complete HTTP(S) mirror URL.');
    config={folder,mirror,autoDownload:$('autoDownload').checked};
    try {localStorage.setItem('citation-settings',JSON.stringify(config));} catch {}
    updateFolder(); $('settings').close();
    if(pendingDownload){pendingDownload=false;doDownload();}
  } catch(e) { $('settingsError').textContent=e.message; }
};
$('loginClose').onclick=()=>$('loginDialog').close();
$('articleTitle').addEventListener('input',renderCitation);
$('style').onchange=()=>{
  if(record) {
    $('articleTitle').value=$('style').value==='apa'?sentenceCase(record.csl.title,$('protected').value):record.csl.title;
    renderCitation();
  }
};
$('recase').onclick=()=>{if(record){$('articleTitle').value=sentenceCase(record.csl.title,$('protected').value);renderCitation();}};
$('copy').onclick=async()=>{
  try {await navigator.clipboard.writeText($('citationText').value);$('copyStatus').textContent='Plain text copied';}
  catch {$('citationText').focus();$('citationText').select();$('copyStatus').textContent='Press Ctrl+C to copy the selected text';}
};
updateFolder(); connect();
