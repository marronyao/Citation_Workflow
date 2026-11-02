/* Static frontend; downloads are delegated to the loopback-only companion. */
const $ = id => document.getElementById(id);
const API = 'http://127.0.0.1:8765';
let token = '', record = null, busy = false, pendingDownload = false;
let config = {folder:'', autoDownload:true};
try { Object.assign(config, JSON.parse(localStorage.getItem('citation-settings') || '{}')); } catch {}
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function normalizeDOI(value) {
  let s=value.trim().replace(/^["']+|["']+$/g,'').trim();
  try {s=decodeURIComponent(s);} catch {throw Error('The identifier contains invalid URL encoding.');}
  const arxiv=s.replace(/^(?:arxiv:\s*|https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf|html)\/)/i,'').split('?')[0].replace(/\.pdf$/i,'');
  if(/^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(arxiv)) return 'arxiv:'+arxiv;
  if(/^https?:\/\//i.test(s)) {
    const url=new URL(s),host=url.hostname;
    if(!url.username && !url.password && !url.port && (['arxiv.org','www.biorxiv.org','biorxiv.org','www.medrxiv.org','medrxiv.org','chemrxiv.org','www.chemrxiv.org','proceedings.neurips.cc','proceedings.mlr.press','openaccess.thecvf.com','aclanthology.org'].includes(host))) return 'https://'+host+url.pathname;
  }
  s=s.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i,'');
  if(!/^10\.\d{4,9}\/[^\s<>"']+$/i.test(s)) throw Error('Enter a DOI, arXiv ID, preprint link or supported conference paper link.');
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
  const data=await response.json();
  if(!response.ok && data.error==='Unknown API') throw Error('Update the local companion from GitHub, close the old companion and restart start.bat, then refresh this page.');
  if (!response.ok) throw Error(data.error || 'The local assistant could not complete the request.'); return data;
}
function link(label,url,parent) {
  if (!/^https?:\/\//i.test(url)) return;
  const a=document.createElement('a'); a.textContent=label+' ↗'; a.href=url; a.target='_blank'; a.rel='noopener noreferrer'; parent.append(a);
}
let customDefinition=null, customRevision=0, customTimer;
function initialTitle(title, style) {
  if(style==='custom' && customDefinition?.titleCase==='title') return journalCase(title);
  return style==='apa' || (style==='custom' && customDefinition?.titleCase==='sentence')?sentenceCase(title,$('protected').value):title;
}
function baseFormatReference(paper, style, title) {
  if(style==='custom') return CustomStyle.format(paper,customDefinition,title ?? initialTitle(paper.csl.title,style));
  const csl=structuredClone(paper.csl);
  if(paper.kind==='preprint') csl.genre='Preprint'+(paper.version?', version '+paper.version:'');
  csl.title=(title ?? (style==='apa'?sentenceCase(csl.title):csl.title)).replace(/\.$/,'');
  if(style==='apa') csl['container-title']=journalCase(csl['container-title']||'');
  if(style==='ris') {
    const kind=paper.kind || (csl.type==='paper-conference'?'conference':csl.genre==='Preprint'?'preprint':'journal');
    const lines=['TY  - '+(kind==='conference'?'CPAPER':kind==='preprint'?'UNPB':'JOUR'),'TI  - '+csl.title];
    (csl.author||[]).forEach(a=>lines.push('AU  - '+(a.literal || [a.family,a.given].filter(Boolean).join(', '))));
    for(const [tag,value] of [[(kind==='conference'?'T2':'JO'),csl['container-title']],['PY',csl.issued?.['date-parts']?.[0]?.[0]],['VL',csl.volume],['IS',csl.issue],['SP',csl.page?.split('-')[0]],['EP',csl.page?.split('-')[1]],['DO',paper.doi],['UR',paper.publisher],['PB',csl.publisher],['N1',kind==='preprint'?'Preprint; '+(paper.platform||csl.publisher||'')+(paper.version?'; version '+paper.version:''):'']]) if(value) lines.push(tag+'  - '+String(value).replace(/[\r\n]/g,' '));
    lines.push('ER  -'); return {text:lines.join('\n')};
  }
  if(style==='bibtex') {
    let text=new Cite(csl).format('bibtex');
    if(paper.kind==='preprint') {
      text=text.replace(/^@\w+/,'@misc');
      const extra=['note = {Preprint'+(paper.version?'; version '+paper.version:'')+'}'];
      if(paper.platform==='arXiv') extra.push('eprint = {'+paper.identifier.replace(/^arxiv:/,'')+'}','archivePrefix = {arXiv}');
      text=text.replace(/,?\s*}\s*$/,',\n  '+extra.join(',\n  ')+'\n}');
    }
    return {text};
  }
  csl.title='<span class="nocase">'+escapeHTML(csl.title)+'</span>';
  const cite=new Cite(csl), options={template:style,lang:'en-US'};
  let text=cite.format('bibliography',{...options,format:'text'}).trim();
  return {text};
}
function formatReference(paper,style,title) {
  const result=baseFormatReference(paper,style,title);
  if(paper.kind==='preprint' && !['bibtex','ris'].includes(style)) {
    const label='[Preprint'+(paper.platform?'; '+paper.platform:'')+(paper.version?'; version '+paper.version:'')+']';
    if(!/\bpreprint\b/i.test(result.text) || (paper.version && !result.text.includes('version '+paper.version))) result.text+=' '+label;
  }
  return result;
}
function renderCitation() {
  if(!record) return;
  try {
    const reference=formatReference(record,$('style').value,$('articleTitle').value);
    $('citationText').value=reference.text;
    $('citationWarning').textContent=reference.warning||'';
    $('copy').disabled=false; $('copyStatus').textContent='';
  } catch(e) { $('copy').disabled=true; $('citationText').value=''; $('citationWarning').textContent=e.message; }
}
function displayRecord() {
  const c=record.csl;
  $('empty').hidden=true; $('paper').hidden=false;
  $('paperTitle').textContent=c.title;
  $('authors').textContent=(c.author||[]).map(a=>a.literal||[a.family,a.given].filter(Boolean).join(', ')).join('; ');
  $('journalMeta').textContent=[c['container-title'],c.issued?.['date-parts']?.[0]?.[0],c.volume && c.volume+(c.issue?'('+c.issue+')':''),c.page].filter(Boolean).join(' · ');
  $('identifiers').textContent=[record.kind==='conference'?'Conference paper':record.kind==='preprint'?'Preprint':'Journal article',record.doi?'DOI: '+record.doi:record.identifier,record.platform,record.version?'Version '+record.version:''].filter(Boolean).join(' · ');
  $('sourceLinks').replaceChildren();
  record.sources.forEach(s=>link(s.name,s.url,$('sourceLinks')));
  $('metadataStatus').textContent='Reference data: '+(record.metadata_source||'DOI registration');
  $('sourceStatus').textContent='Search plan: '+(record.source_plan||[]).join(' → ');
  $('downloadStatus').textContent='Ready to download'; $('attemptDetails').hidden=true;
  $('articleTitle').disabled=false;
  $('articleTitle').value=initialTitle(c.title,$('style').value);
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
    const result=await api('download',{key:record.key,doi:record.doi,identifier:record.identifier,folder:config.folder});
    showAttempts(result);
    if(result.ok) {
      $('downloadStatus').textContent=`PDF saved · ${(result.bytes/1024/1024).toFixed(2)} MB`;
      $('sourceStatus').textContent='Full text retrieved from '+result.source+(result.version_note?' · '+result.version_note:''); notice([...record.warnings,'Saved to: '+result.path].join('\n'));
    } else {
      $('downloadStatus').textContent='Database search finished; publisher options available'; notice('Your reference is ready, but the PDF could not be downloaded. See the source search history for details.');
      offerPublishers(result);
    }
  } catch(e) { $('downloadStatus').textContent='Download failed'; notice(e.message,true); }
  finally {lock(false);}
}
function showAttempts(result) {
  $('attempts').replaceChildren();
  (result.attempts||[]).forEach(message=>{const li=document.createElement('li');li.textContent=message;$('attempts').append(li);});
  $('attemptDetails').hidden=!(result.attempts?.length);
}
function offerPublishers(result) {
  $('publisherChoices').replaceChildren();
  (result.publishers?.length?result.publishers:[{name:'Open official article',url:result.login}]).forEach(choice=>link(choice.name,choice.url,$('publisherChoices')));
  if(!$('loginDialog').open) $('loginDialog').showModal();
}
$('lookupForm').addEventListener('submit',async e=>{
  e.preventDefault();if(busy)return;let available=false;
  try {
    const identifier=normalizeDOI($('doi').value);$('doi').value=identifier;
    record=null;$('paper').hidden=true;$('empty').hidden=false;$('articleTitle').value='';$('articleTitle').disabled=true;$('citationText').value='';$('citationWarning').textContent='';$('copy').disabled=true;
    lock(true);notice('Reading reference data and selecting suitable full-text databases…');
    record=await api('lookup',{identifier});displayRecord();
    $('downloadStatus').textContent='Searching for a free full-text PDF…';
    const result=await api('search',{key:record.key});showAttempts(result);available=result.ok;
    $('sourceStatus').textContent=result.ok?'PDF found: '+result.source+(result.version_note?' · '+result.version_note:''):'Source search finished; see history for availability and verification details';
    $('downloadStatus').textContent=result.ok?'PDF found; ready to save':'No automatic PDF retrieved; official article options available';
    notice(record.warnings.join('\n'));
    if(!result.ok)offerPublishers(result);
  } catch(e) {notice(e.message,true);}
  finally {lock(false);}
  if(record && available && config.autoDownload)await doDownload();
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
  updateCustomVisibility();
  if(record) {
    $('articleTitle').value=initialTitle(record.csl.title,$('style').value);
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
  for(const id of ['batchFind','batchFolder','batchBrowse','batchStyle','batchDOIs','batchBack','batchCustomExample']) $(id).disabled=value;
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
    const status=document.createElement('p');status.className='row-status';status.setAttribute('role','status');status.textContent=reference.warning||'';
    button.onclick=async()=>{
      try {await navigator.clipboard.writeText(reference.text);status.textContent=['Copied',reference.warning].filter(Boolean).join('. ');}
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
$('batchStyle').onchange=()=>{updateCustomVisibility();for(const item of batchItems) if(item.paper) prepareBatchCitation(item);};
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
        item.doi=normalizeDOI(item.doi);item.paper=await api('lookup',{identifier:item.doi});
        const title=item.paper.csl.title, words=title.split(/\s+/);
        item.titleCell.textContent=words.length>9?words.slice(0,9).join(' ')+'…':title;item.titleCell.title=title;
        const type=document.createElement('small');type.className='row-kind';type.textContent=item.paper.kind==='conference'?'Conference paper':item.paper.kind==='preprint'?'Preprint'+(item.paper.version?' · v'+item.paper.version:''):'Journal article';item.titleCell.append(type);
        prepareBatchCitation(item);found++;
        item.status.textContent='Searching full-text sources…';
        try {
          const result=await api('search',{key:item.paper.key});
          item.status.textContent=result.ok?'PDF found · '+result.source+(result.version_note?' · '+result.version_note:''):'No PDF retrieved; official article options below';
          if(!result.ok)(result.publishers||[]).forEach(choice=>link(choice.name,choice.url,item.links));
          const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ul');summary.textContent='Source search history';details.append(summary,list);
          (result.attempts||[]).forEach(message=>{const li=document.createElement('li');li.textContent=message;list.append(li);});item.pdfCell.append(details);
        } catch(error) {item.status.textContent='Full-text search failed: '+error.message;}

      } catch(e) {item.titleCell.textContent='Lookup failed: '+e.message;item.status.textContent='Unavailable';}
    }
    $('batchStatus').textContent=`Found ${found} of ${batchItems.length} papers. Choose individual PDFs or download all below.`;
  } finally {batchLock(false);}
};
async function downloadBatchItem(item,folder) {
  item.status.textContent='Searching sources and saving PDF…';item.links.replaceChildren();
  try {
    const result=await api('download',{key:item.paper.key,doi:item.paper.doi,identifier:item.paper.identifier,folder});
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
function updateCustomVisibility() {
  $('singleCustom').hidden=$('style').value!=='custom';
  $('batchCustom').hidden=$('batchStyle').value!=='custom';
}
function refreshCustomCitations() {
  if(record && $('style').value==='custom') renderCitation();
  if($('batchStyle').value==='custom') for(const item of batchItems) if(item.paper) prepareBatchCitation(item);
}
function customStatus(message) {
  for(const id of ['singleCustomStatus','batchCustomStatus']) $(id).textContent=message;
}
async function detectCustomExample(example,revision) {
  customStatus('Identifying the example paper and detecting its reference format…');
  try {
    const sample=await api('style-example',{example});
    if(revision!==customRevision) return;
    customDefinition=CustomStyle.infer(example,sample);
    customStatus('Detected: '+customDefinition.summary);
    try {localStorage.setItem('citation-custom-style',JSON.stringify({example,definition:customDefinition}));} catch {}
    if(record && $('style').value==='custom') $('articleTitle').value=initialTitle(record.csl.title,'custom');
  } catch(e) {
    if(revision!==customRevision) return;
    customDefinition=null;customStatus('Unable to detect the format: '+e.message);
  }
  if(revision===customRevision) refreshCustomCitations();
}
function customExampleInput(event) {
  clearTimeout(customTimer);const example=event.target.value;
  for(const id of ['singleCustomExample','batchCustomExample']) if($(id)!==event.target) $(id).value=example;
  customDefinition=null;const revision=++customRevision;refreshCustomCitations();
  try {localStorage.removeItem('citation-custom-style');} catch {}
  if(example.trim().length<30) {customStatus('Paste one complete reference example (at least 30 characters), preferably including its DOI.');return;}
  customStatus('Waiting for you to finish the example…');
  customTimer=setTimeout(()=>detectCustomExample(example,revision),1000);
}
for(const id of ['singleCustomExample','batchCustomExample']) $(id).addEventListener('input',customExampleInput);
try {
  const saved=JSON.parse(localStorage.getItem('citation-custom-style')||'null');
  if(saved?.definition?.version===1 && typeof saved.definition.template==='string' && saved.definition.authors) {
    customDefinition=saved.definition;
    $('singleCustomExample').value=$('batchCustomExample').value=saved.example||'';
    customStatus('Detected: '+customDefinition.summary);
  }
} catch {}
updateCustomVisibility();updateFolder(); connect();
