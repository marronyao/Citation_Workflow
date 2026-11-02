/* Static frontend; downloads are delegated to the loopback-only companion. */
const $ = id => document.getElementById(id);
const API = 'http://127.0.0.1:8765';
let token = '', record = null, busy = false, pendingDownload = false;
let config = {folder:'', autoDownload:true};
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
function lock(value) { busy=value; $('search').disabled=value; $('download').disabled=value; $('doi').disabled=value; $('batchOpen').disabled=value; $('settingsOpen').disabled=value; }
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
function formatReference(paper, style, title) {
  const csl=structuredClone(paper.csl);
  csl.title=(title ?? (style==='apa'?sentenceCase(csl.title):csl.title)).replace(/\.$/,'');
  if(style==='apa') csl['container-title']=journalCase(csl['container-title']||'');
  if(style==='ris') {
    const lines=['TY  - JOUR','TI  - '+csl.title];
    (csl.author||[]).forEach(a=>lines.push('AU  - '+(a.literal || [a.family,a.given].filter(Boolean).join(', '))));
    for(const [tag,value] of [['JO',csl['container-title']],['PY',csl.issued?.['date-parts']?.[0]?.[0]],['VL',csl.volume],['IS',csl.issue],['SP',csl.page?.split('-')[0]],['EP',csl.page?.split('-')[1]],['DO',paper.doi],['UR',paper.publisher]]) if(value) lines.push(tag+'  - '+String(value).replace(/[\r\n]/g,' '));
    lines.push('ER  -'); return {text:lines.join('\n'),message:'RIS format, ready to import into EndNote, Zotero and other reference managers.'};
  }
  if(style==='bibtex') return {text:new Cite(csl).format('bibtex'),message:'BibTeX format, ready for LaTeX and reference managers.'};
  csl.title='<span class="nocase">'+escapeHTML(csl.title)+'</span>';
  const cite=new Cite(csl), options={template:style,lang:'en-US'};
  return {text:cite.format('bibliography',{...options,format:'text'}).trim(),html:cite.format('bibliography',{...options,format:'html'})};
}
function renderCitation() {
  if(!record) return;
  try {
    const reference=formatReference(record,$('style').value,$('articleTitle').value);
    $('citationText').value=reference.text;
    if(reference.html) $('preview').innerHTML=cleanPreview(reference.html);
    else $('preview').textContent=reference.message;
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
  $('sourceStatus').textContent=record.pmc?'Search order: PMC → Sci-Hub → offer publisher':'Search order: Sci-Hub → offer publisher';
  $('downloadStatus').textContent='Ready to download'; $('attemptDetails').hidden=true;
  $('articleTitle').disabled=false;
  $('articleTitle').value=$('style').value==='apa'?sentenceCase(c.title,$('protected').value):c.title;
  renderCitation();
}
function showSettings() {
  $('folder').value=config.folder; $('autoDownload').checked=config.autoDownload;
  $('settingsError').textContent=''; $('settings').showModal();
}
function updateFolder() { $('folderLabel').textContent=config.folder || 'No Windows folder selected'; }
async function doDownload() {
  if(!record || busy) return;
  if(!config.folder) { pendingDownload=true; showSettings(); return; }
  lock(true); $('downloadStatus').textContent='Finding full text and downloading the PDF…'; notice('Checking PDF sources in order. Some websites may take a moment to respond.');
  try {
    const result=await api('download',{key:record.key,doi:record.doi,folder:config.folder});
    $('attempts').replaceChildren(); (result.attempts||[]).forEach(s=>{const li=document.createElement('li');li.textContent=s;$('attempts').append(li);}); $('attemptDetails').hidden=!(result.attempts?.length);
    if(result.ok) {
      $('downloadStatus').textContent=`PDF saved · ${(result.bytes/1024/1024).toFixed(2)} MB`;
      $('sourceStatus').textContent='Full text retrieved from '+result.source; notice([...record.warnings,'Saved to: '+result.path].join('\n'));
    } else {
      $('downloadStatus').textContent='Database search finished; publisher options available'; notice('Your reference is ready, but the PDF could not be downloaded. See the source search history for details.');
      $('publisherChoices').replaceChildren();
      const choices=result.publishers?.length?result.publishers:[{name:'Open publisher',url:result.login}];
      choices.forEach(choice=>link(choice.name,choice.url,$('publisherChoices')));
      $('loginDialog').showModal();
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
    const folder=normalizeFolder($('folder').value);
    config={folder,autoDownload:$('autoDownload').checked};
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
async function browseFolder(input, button, status) {
  button.disabled=true; const label=button.textContent; button.textContent='Choose in Windows…'; status.textContent='';
  try {
    const result=await api('folder',{initial:input.value});
    if(result.folder) { input.value=result.folder; input.dispatchEvent(new Event('change')); }
  } catch(e) { status.textContent=e.message; }
  finally {button.disabled=false;button.textContent=label;}
}
$('folderBrowse').onclick=()=>browseFolder($('folder'),$('folderBrowse'),$('settingsError'));
$('batchBrowse').onclick=()=>browseFolder($('batchFolder'),$('batchBrowse'),$('batchStatus'));

let batchItems=[], batchBusy=false;
function openBatch(show) {
  if(busy || batchBusy) return;
  $('singleWorkspace').hidden=show; $('batchWorkspace').hidden=!show;
  $('batchOpen').hidden=show;
  if(show) { $('batchFolder').value=config.folder; refreshBatchActions(); $('batchFolder').focus(); }
  else $('doi').focus();
}
$('batchOpen').onclick=()=>openBatch(true);
$('batchBack').onclick=()=>openBatch(false);
function batchLock(value) {
  batchBusy=value;
  for(const id of ['batchFind','batchFolder','batchBrowse','batchStyle','batchDOIs','batchBack']) $(id).disabled=value;
  refreshBatchActions();
}
function refreshBatchActions() {
  const folder=$('batchFolder').value.trim();
  for(const item of batchItems) if(item.downloadButton) {
    item.downloadButton.disabled=batchBusy || !item.paper || item.savedFolder===folder;
    item.downloadButton.textContent=item.savedFolder===folder?'Downloaded':'Download PDF';
  }
  $('batchDownloadAll').disabled=batchBusy || !batchItems.some(item=>item.paper && item.savedFolder!==folder);
  const saved=batchItems.filter(item=>item.savedFolder===folder).length;
  $('batchSummary').textContent=`${saved} of ${batchItems.length} PDFs saved`;
}
function saveBatchFolder() {
  const folder=normalizeFolder($('batchFolder').value);
  $('batchFolder').value=folder; config.folder=folder; updateFolder();
  try {localStorage.setItem('citation-settings',JSON.stringify(config));} catch {}
  refreshBatchActions();return folder;
}
$('batchFolder').onchange=()=>{try {saveBatchFolder();} catch(e) {$('batchStatus').textContent=e.message;}};
function createBatchRow(doi) {
  const item={doi,paper:null,savedFolder:''}, row=document.createElement('tr');
  const cells=Array.from({length:4},()=>{const cell=document.createElement('td');row.append(cell);return cell;});
  cells[0].textContent=doi;cells[1].textContent='Waiting…';
  item.titleCell=cells[1];item.pdfCell=cells[2];item.citationCell=cells[3];
  const downloadButton=document.createElement('button');downloadButton.type='button';downloadButton.className='secondary';downloadButton.textContent='Download PDF';downloadButton.disabled=true;
  downloadButton.onclick=async()=>{
    if(batchBusy) return;
    let folder;try {folder=saveBatchFolder();} catch(e) {$('batchStatus').textContent=e.message;return;}
    batchLock(true);
    try {await downloadBatchItem(item,folder);} finally {
      batchLock(false); $('batchStatus').textContent=$('batchSummary').textContent+'. Failed papers can be retried individually.';
    }
  };
  item.downloadButton=downloadButton;cells[2].append(downloadButton);
  item.status=document.createElement('p');item.status.className='row-status';item.status.setAttribute('role','status');cells[2].append(item.status);
  item.links=document.createElement('div');item.links.className='row-links';cells[2].append(item.links);
  $('batchRows').append(row);return item;
}
function prepareBatchCitation(item) {
  try {
    const reference=formatReference(item.paper,$('batchStyle').value);
    const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Copy citation';
    const status=document.createElement('p');status.className='row-status';status.setAttribute('role','status');
    button.onclick=async()=>{
      try {await navigator.clipboard.writeText(reference.text);status.textContent='Copied';}
      catch {
        status.textContent='Select the reference below and press Ctrl+C.';
        let field=item.citationCell.querySelector('textarea');
        if(!field) {field=document.createElement('textarea');field.readOnly=true;field.setAttribute('aria-label','Citation to copy');item.citationCell.append(field);}
        field.value=reference.text;field.focus();field.select();
      }
    };
    item.citationCell.replaceChildren(button,status);
  } catch(e) {item.citationCell.textContent='Citation unavailable: '+e.message;}
}
$('batchStyle').onchange=()=>{for(const item of batchItems) if(item.paper) prepareBatchCitation(item);};
$('batchForm').onsubmit=async e=>{
  e.preventDefault();if(batchBusy) return;
  let dois;
  try {saveBatchFolder();dois=$('batchDOIs').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(!dois.length) throw Error('Enter at least one DOI, one per line.');}
  catch(e) {$('batchStatus').textContent=e.message;return;}
  $('batchRows').replaceChildren();batchItems=dois.map(createBatchRow);$('batchResults').hidden=false;batchLock(true);
  let found=0;
  try {
    for(const [index,item] of batchItems.entries()) {
      $('batchStatus').textContent=`Finding paper ${index+1} of ${batchItems.length}…`;
      try {
        item.doi=normalizeDOI(item.doi);item.paper=await api('lookup',{doi:item.doi});
        const title=item.paper.csl.title, words=title.split(/\s+/);
        item.titleCell.textContent=words.length>9?words.slice(0,9).join(' ')+'…':title;item.titleCell.title=title;
        prepareBatchCitation(item);found++;
      } catch(e) {item.titleCell.textContent='Lookup failed: '+e.message;item.status.textContent='Unavailable';}
    }
    $('batchStatus').textContent=`Found ${found} of ${batchItems.length} papers. Choose individual PDFs or download all below.`;
  } finally {batchLock(false);}
};
async function downloadBatchItem(item,folder) {
  item.status.textContent='Searching sources and saving PDF…';item.links.replaceChildren();
  try {
    const result=await api('download',{key:item.paper.key,doi:item.paper.doi,folder});
    if(result.ok) {item.savedFolder=folder;item.status.textContent='Saved to '+result.path;}
    else {
      item.status.textContent='PDF unavailable. Choose a publisher link or retry.';
      (result.publishers||[{name:'Open publisher',url:result.login}]).forEach(choice=>link(choice.name,choice.url,item.links));
    }
    item.status.title=(result.attempts||[]).join('\n');
  } catch(e) {item.status.textContent='Download failed: '+e.message;}
}
$('batchDownloadAll').onclick=async()=>{
  if(batchBusy) return;
  let folder;try {folder=saveBatchFolder();} catch(e) {$('batchStatus').textContent=e.message;return;}
  const pending=batchItems.filter(item=>item.paper && item.savedFolder!==folder);batchLock(true);
  try {
    for(const [index,item] of pending.entries()) {
      $('batchStatus').textContent=`Downloading PDF ${index+1} of ${pending.length}…`;
      await downloadBatchItem(item,folder);refreshBatchActions();
    }
    const saved=batchItems.filter(item=>item.savedFolder===folder).length;
    $('batchStatus').textContent=`Finished: ${saved} PDFs saved. Any failed papers can be retried individually.`;
  } finally {batchLock(false);}
};
updateFolder(); connect();
