/* Static frontend backed by the public cloud API. */
const $ = id => document.getElementById(id);
const API = 'https://citation-workflow-api.marronyao.workers.dev';
let record=null, busy=false;
let config={autoDownload:false};
try { const saved=JSON.parse(localStorage.getItem('citation-cloud-settings')||'{}');config.autoDownload=saved.autoDownload===true; } catch {}
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
function lock(value) { busy=value; for(const id of ['search','download','doi','batchOpen','settingsOpen']) $(id).disabled=value; }
async function api(route, payload) {
  let response;
  try {response=await fetch(API+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(180000)});}
  catch {throw Error('The cloud service could not be reached. Check your connection and try again.');}
  let data;try {data=await response.json();}catch {throw Error('The cloud service returned an unexpected response. Please try again.');}
  if(!response.ok)throw Error(data.error||'The cloud service could not complete the request.');return data;
}
async function fetchPaperPDF(paper,onProgress) {
  const result=await api('download',{key:paper.key});
  if(!result.ok) return {result};
  const downloadURL=new URL(result.download_url);
  if(downloadURL.origin!==API || downloadURL.pathname!=='/api/pdf')throw Error('Invalid cloud download URL.');
  const blob=await BrowserDownloads.readPDF(await fetch(downloadURL,{signal:AbortSignal.timeout(180000)}),onProgress);
  return {result,blob};
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
  $('autoDownload').checked=config.autoDownload;$('settings').showModal();
}
async function doDownload() {
  if(!record || busy)return;
  lock(true);$('downloadStatus').textContent='Downloading PDF from the cloud…';notice('Preparing your browser download…');
  try {
    const {result,blob}=await fetchPaperPDF(record);showAttempts(result);
    if(blob) {
      BrowserDownloads.save(blob,result.filename);
      $('downloadStatus').textContent=`Download started · ${(blob.size/1024/1024).toFixed(2)} MB`;
      $('sourceStatus').textContent='Full text retrieved from '+result.source+(result.version_note?' · '+result.version_note:'');
      notice([...record.warnings,'Your browser controls the save location. Check its downloads list.'].join('\n'));
    } else {$('downloadStatus').textContent='No accessible PDF retrieved';notice('Your reference is ready. Open the official article for other access options.');offerPublishers(result);}
  }catch(e){$('downloadStatus').textContent='Download failed';notice(e.message,true);}
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
$('settingsCancel').onclick=()=>$('settings').close();
$('settingsForm').onsubmit=e=>{
  e.preventDefault();config.autoDownload=$('autoDownload').checked;
  try {localStorage.setItem('citation-cloud-settings',JSON.stringify(config));}catch{}
  $('settings').close();
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
let batchItems=[], batchBusy=false;
let batchProgressTimer=null, batchStarted=0, batchStageStarted=0;
function updateBatchElapsed() {
  const seconds=Math.floor((Date.now()-batchStarted)/1000);
  $('batchElapsed').textContent=`Elapsed ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  if(batchProgressTimer!==null && Date.now()-batchStageStarted>=15000) $('batchActivity').textContent='Still working · waiting for the current task. Some sources can be slow.';
}
function startBatchProgress(title,total) {
  clearInterval(batchProgressTimer);
  batchStarted=Date.now();batchStageStarted=batchStarted;
  $('batchProgressPanel').hidden=false;
  $('batchProgress').hidden=false;
  $('batchProgressPanel').classList.add('is-active');
  $('batchProgressTitle').textContent=title;
  $('batchProgress').max=total;
  setBatchProgress(0,'Starting…');
  updateBatchElapsed();
  batchProgressTimer=setInterval(updateBatchElapsed,1000);
}
function setBatchProgress(completed,message,identifier='') {
  batchStageStarted=Date.now();
  $('batchProgress').value=completed;
  $('batchProgressCount').textContent=`${Math.round(completed/$('batchProgress').max*100)}% · ${completed} / ${$('batchProgress').max} steps`;
  $('batchStatus').textContent=message;
  $('batchCurrent').textContent=identifier;
  $('batchActivity').textContent='Working…';
}
function finishBatchProgress(message,failed=false) {
  clearInterval(batchProgressTimer);batchProgressTimer=null;
  $('batchProgressPanel').classList.remove('is-active');
  if(!failed) {
    $('batchProgress').value=$('batchProgress').max;
    $('batchProgressCount').textContent='100% · Finished';
  }
  $('batchStatus').textContent=message;
  $('batchCurrent').textContent='';
  $('batchActivity').textContent=failed?'Task failed · you can retry.':'Task finished';
  updateBatchElapsed();
}
function showBatchBytes(received,total) {
  batchStageStarted=Date.now();
  const size=(received/1024/1024).toFixed(2)+' MB';
  $('batchActivity').textContent=total?`${size} / ${(total/1024/1024).toFixed(2)} MB received`:`${size} received`;
}
function openBatch(show) {
  if(busy || batchBusy) return;
  $('singleWorkspace').hidden=show; $('batchWorkspace').hidden=!show;
  $('batchOpen').hidden=show;
  if(show) {refreshBatchActions();$('batchDOIs').focus();}
  else $('doi').focus();
}
$('batchOpen').onclick=()=>openBatch(true);
$('batchBack').onclick=()=>openBatch(false);
function batchLock(value) {
  batchBusy=value;
  $('batchResults').setAttribute('aria-busy',String(value));
  for(const id of ['batchFind','batchStyle','batchDOIs','batchBack','batchCustomExample','settingsOpen']) $(id).disabled=value;
  refreshBatchActions();
}
function refreshBatchActions() {
  for(const item of batchItems)if(item.downloadButton)item.downloadButton.disabled=batchBusy||!item.paper;
  $('batchDownloadAll').disabled=batchBusy||!batchItems.some(item=>item.paper);
  $('batchSummary').textContent=`${batchItems.filter(item=>item.downloaded).length} of ${batchItems.length} PDFs prepared for download`;
}
function createBatchRow(doi) {
  const item={doi,paper:null,downloaded:false}, row=document.createElement('tr');
  const cells=Array.from({length:4},()=>{const cell=document.createElement('td');row.append(cell);return cell;});
  cells[0].textContent=doi;cells[1].textContent='Waiting…';
  item.titleCell=cells[1];item.pdfCell=cells[2];item.citationCell=cells[3];
  const downloadButton=document.createElement('button');downloadButton.type='button';downloadButton.className='secondary';downloadButton.textContent='Download PDF';downloadButton.disabled=true;
  downloadButton.onclick=async()=>{
    if(batchBusy) return;
    batchLock(true);
    startBatchProgress('Downloading PDF',1);
    setBatchProgress(0,'Retrieving PDF…',item.doi);
    try {
      const file=await downloadBatchItem(item);
      finishBatchProgress(file?'Browser download started. Check your browser downloads.':item.status.textContent,!file);
    } finally {
      batchLock(false);
    }
  };
  item.downloadButton=downloadButton;cells[2].append(downloadButton);
  item.status=document.createElement('p');item.status.className='row-status';item.status.setAttribute('role','status');item.status.textContent='Queued';cells[2].append(item.status);
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
  try {dois=$('batchDOIs').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(!dois.length) throw Error('Enter at least one DOI, one per line.');if(dois.length>20)throw Error('Use up to 20 papers per batch.');}
  catch(e) {
    $('batchProgressPanel').hidden=false;$('batchProgress').hidden=true;
    $('batchProgressTitle').textContent='Check paper identifiers';
    for(const id of ['batchProgressCount','batchCurrent','batchActivity','batchElapsed']) $(id).textContent='';
    $('batchStatus').textContent=e.message;return;
  }
  $('batchRows').replaceChildren();batchItems=dois.map(createBatchRow);$('batchResults').hidden=false;batchLock(true);
  startBatchProgress('Finding papers',batchItems.length*2);
  let found=0;
  try {
    for(const [index,item] of batchItems.entries()) {
      setBatchProgress(index*2,`Paper ${index+1} of ${batchItems.length} · Reading reference data…`,item.doi);
      item.status.textContent='Reading reference data…';
      try {
        item.doi=normalizeDOI(item.doi);item.paper=await api('lookup',{identifier:item.doi});
        const title=item.paper.csl.title, words=title.split(/\s+/);
        item.titleCell.textContent=words.length>9?words.slice(0,9).join(' ')+'…':title;item.titleCell.title=title;
        const type=document.createElement('small');type.className='row-kind';type.textContent=item.paper.kind==='conference'?'Conference paper':item.paper.kind==='preprint'?'Preprint'+(item.paper.version?' · v'+item.paper.version:''):'Journal article';item.titleCell.append(type);
        prepareBatchCitation(item);found++;
        setBatchProgress(index*2+1,`Paper ${index+1} of ${batchItems.length} · Searching full-text sources…`,item.doi);
        item.status.textContent='Searching full-text sources…';
        try {
          const result=await api('search',{key:item.paper.key});
          item.status.textContent=result.ok?'PDF found · '+result.source+(result.version_note?' · '+result.version_note:''):'No PDF retrieved; official article options below';
          if(!result.ok)(result.publishers||[]).forEach(choice=>link(choice.name,choice.url,item.links));
          const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ul');summary.textContent='Source search history';details.append(summary,list);
          (result.attempts||[]).forEach(message=>{const li=document.createElement('li');li.textContent=message;list.append(li);});item.pdfCell.append(details);
        } catch(error) {item.status.textContent='Full-text search failed: '+error.message;}

      } catch(e) {item.titleCell.textContent='Lookup failed: '+e.message;item.status.textContent='Unavailable';}
      setBatchProgress((index+1)*2,`Processed ${index+1} of ${batchItems.length} papers · ${found} references found`);
    }
    finishBatchProgress(`Processed ${batchItems.length} papers · Found ${found} references; ${batchItems.length-found} lookups failed. Choose individual PDFs or download all below.`);
  } catch(e) {
    finishBatchProgress('Batch search failed: '+e.message,true);
  } finally {batchLock(false);}
};
async function downloadBatchItem(item, forZip=false) {
  item.status.textContent='Downloading PDF…';item.links.replaceChildren();
  try {
    const {result,blob}=await fetchPaperPDF(item.paper,showBatchBytes);
    if(blob) {
      if(!forZip){BrowserDownloads.save(blob,result.filename);item.downloaded=true;}
      item.status.textContent=forZip?'PDF ready for ZIP':'Browser download started';
      return {name:result.filename,blob,item};
    }
    item.status.textContent='PDF unavailable. Open the official article or retry.';
    (result.publishers||[]).forEach(choice=>link(choice.name,choice.url,item.links));
  }catch(e){item.status.textContent='Download failed: '+e.message;}
  return null;
}
$('batchDownloadAll').onclick=async()=>{
  if(batchBusy)return;
  const pending=batchItems.filter(item=>item.paper),files=[];let total=0;
  batchLock(true);
  startBatchProgress('Preparing ZIP download',pending.length+1);
  try {
    for(const [index,item]of pending.entries()) {
      setBatchProgress(index,`PDF ${index+1} of ${pending.length} · Retrieving PDF for ZIP…`,item.doi);
      const file=await downloadBatchItem(item,true);
      if(file){if(total+file.blob.size>BrowserDownloads.MAX_ZIP-65536){item.status.textContent='Skipped: ZIP limit is 100 MB. Download this PDF individually.';}else{files.push(file);total+=file.blob.size;}}
    }
    const report=batchItems.map(item=>item.doi+'\n'+item.status.textContent).join('\n\n');
    if(files.length) {
      setBatchProgress(pending.length,'Creating ZIP archive…');
      const zip=await BrowserDownloads.zip([...files,{name:'download-report.txt',blob:new Blob([report])}],(done,total)=>{
        batchStageStarted=Date.now();
        $('batchActivity').textContent=`Packing ${done} of ${total} files`;
      });
      BrowserDownloads.save(zip,'Citation-Workflow-'+new Date().toISOString().slice(0,10)+'.zip');
      for(const file of files){file.item.downloaded=true;file.item.status.textContent='Included in ZIP download';}
    }
    finishBatchProgress(files.length?`ZIP download started: ${files.length} PDFs. ${batchItems.length-files.length} unavailable or skipped. Check your browser downloads.`:'No PDFs could be retrieved. See each paper for details.');
  }catch(e){finishBatchProgress('ZIP download failed: '+e.message,true);}
  finally{batchLock(false);}
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
updateCustomVisibility();
