import { shims } from './firebase-init.js';

const $ = s=>document.querySelector(s);
const $$ = s=>Array.from(document.querySelectorAll(s));

// ---------- state ----------
let db=null, sampleFn=null, uid=null, downloadsCap=null, myEmail=null;
// This account is the one super-admin: can create circles (independent
// groups, each with their own lists) and assign a moderator to each. A
// circle's moderator can add/edit/delete lists within their own circle;
// everyone else can read and practice the lists in whichever circle(s)
// they've joined, but can't change them. Matches firestore.rules, which
// enforces the same thing server-side.
const ADMIN_EMAIL='keshet85@gmail.com';
let isAdmin=false;
// ---------- circles ----------
let circles={};          // circleId -> {name, moderatorEmail}
let myCircles=[];        // [{id,name}] circles this account belongs to (admin: all of them)
let activeCircleId=null; // which circle's lists are currently loaded into decks/words
let unsubDecks=null, unsubWords=null;
function canEditCircle(circleId){
  if(isAdmin) return true;
  if(!circleId) return false;
  const c=circles[circleId];
  return !!(c && c.moderatorEmail && myEmail && c.moderatorEmail.toLowerCase()===myEmail);
}
function circleStorageKey(){ return 'vocabitash_active_circle_'+uid; }
function persistActiveCircle(){
  try{ localStorage.setItem(circleStorageKey(), activeCircleId||''); }catch(e){}
}
let decks={}, words={}, progress={}, acceptedAnswers={}, mnemonics={};
let currentView='home';
let shotFiles=[];
let sampleImageMax=null;
const MAX_SHOT_PHOTOS=6;
const LONG_LIST_THRESHOLD=100;
let reviewRows=[]; // {a,b,note,section}
// When a photo's extracted pairs carry printed section headers (e.g. "Part A", "Adjectives"),
// the review screen offers to save them as separate, correctly-named lists instead of one —
// but only once the viewer says yes, never automatically.
let splitBySections=false;
let sectionSuggestionDismissed=false;
let sectionGroupNames={}; // detected section text (or '' for the unlabeled bucket) -> editable list name
let quiz=null; // active session state
let hotData=null;
let homeSubject=''; // '' = showing the language picker (no language chosen yet)
let practiceSubject=''; // same idea, for the Oefenen tab's own language picker
let practiceGroupFilter=''; // '' = show every list in practiceSubject; otherwise only that group's lists
function setPracticeSubject(subj){ practiceSubject=subj; practiceGroupFilter=''; }
let homeShowArchived=false;

// Each signed-in viewer's own practice progress lives under their own private
// subtree (data/users/<their id>/...), never in a collection shared by everyone
// who can open this artifact — so sharing the lists never shares anyone's scores.
function progressCol(){
  return uid ? db.doc('data/users/'+uid+'/profile').collection('progress') : db.collection('progress');
}
// Answers a viewer has explicitly marked "also correct" for a word (e.g. a
// shorter but valid conjugation) — private per viewer, same place as progress,
// so accepting an alternative never changes what counts as right for anyone else.
function acceptedCol(){
  return uid ? db.doc('data/users/'+uid+'/profile').collection('accepted') : db.collection('accepted');
}
// Personal memory aids ("ezelsbruggetjes") a viewer writes for herself after a
// mistake — private per viewer, resurfaced the next time she gets that word wrong.
function mnemonicsCol(){
  return uid ? db.doc('data/users/'+uid+'/profile').collection('mnemonics') : db.collection('mnemonics');
}

function distinctSubjects(){
  const set=new Set();
  Object.values(decks).forEach(d=> set.add((d.subject||'').trim() || 'Overig'));
  return Array.from(set).sort((a,b)=> a==='Overig'?1:b==='Overig'?-1:a.localeCompare(b));
}
function deckIdsForSubject(subj){
  return Object.keys(decks).filter(id=> ((decks[id].subject||'').trim()||'Overig') === subj);
}
const sortByNew=(a,b)=> (decks[b].createdAt||'').localeCompare(decks[a].createdAt||'');
// optional umbrella a deck can be filed under, e.g. several Engels lists all tagged "Toetsen oktober" —
// always scoped to one subject/language, never shared across languages
function groupsForSubject(subj){
  const set=new Set();
  deckIdsForSubject(subj).forEach(id=>{ const g=(decks[id].group||'').trim(); if(g) set.add(g); });
  return Array.from(set).sort((a,b)=>a.localeCompare(b));
}

const BOX_INTERVAL_DAYS=[0,0,1,3,7,16]; // index by box 1..5
const now=()=>Date.now();
const iso=()=>new Date().toISOString();

// ---------- toast ----------
let toastT=null;
function toast(msg){
  const el=$('#toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),3200);
}

// ---------- normalize / matching ----------
function stripAccents(s){ return s.normalize('NFD').replace(/[̀-ͯ]/g,''); }
function normalize(s){
  return stripAccents(String(s||''))
    .toLowerCase().trim()
    .replace(/[.!?¡¿]+$/,'')
    .replace(/\s+/g,' ');
}
function stripLead(s){
  return s.replace(/^(de|het|een|to)\s+/,'');
}
function variantsOf(raw){
  const parts = String(raw||'').split(/[,;/]| of /i).map(p=>p.trim()).filter(Boolean);
  const out=new Set();
  for(const p of (parts.length?parts:[raw])){
    const n=normalize(p);
    if(n) out.add(n);
    const s=stripLead(n);
    if(s) out.add(s);
  }
  return out;
}
function levenshtein(a,b){
  if(a===b) return 0;
  const m=a.length,n=b.length;
  if(!m) return n; if(!n) return m;
  let prev=new Array(n+1).fill(0).map((_,i)=>i);
  for(let i=1;i<=m;i++){
    const cur=[i];
    for(let j=1;j<=n;j++){
      cur[j]=Math.min(prev[j]+1, cur[j-1]+1, prev[j-1]+(a[i-1]===b[j-1]?0:1));
    }
    prev=cur;
  }
  return prev[n];
}
// Expands grammar-style optional/alternative parentheses in an answer key into
// every concrete phrasing they could mean, e.g. "(hij, zij, het) (be)woont" ->
// "woont", "bewoont", "hij woont", "hij bewoont", "zij woont", ... — so a short,
// correct answer like just "woont" is recognized without listing it by hand.
function expandParens(raw){
  let results=[String(raw||'')];
  const re=/\(([^()]*)\)/;
  let guard=0;
  while(guard++<40){
    let changed=false;
    const next=[];
    for(const s of results){
      const m=s.match(re);
      if(!m){ next.push(s); continue; }
      changed=true;
      const inner=m[1];
      const before=s.slice(0, m.index);
      const after=s.slice(m.index+m[0].length);
      // touches a letter directly (no space) -> optional prefix/suffix glued to a word;
      // otherwise it's a standalone alternative/hint segment (e.g. a list of pronouns)
      const alts=inner.split(/[,/]| of /i).map(x=>x.trim()).filter(Boolean);
      const choices=Array.from(new Set(['', ...alts]));
      for(const c of choices) next.push(before+c+after);
    }
    results = Array.from(new Set(next.map(s=> s.replace(/\s+/g,' ').trim())));
    if(!changed) break;
    if(results.length>80) break; // safety cap
  }
  return results.filter(Boolean);
}
function checkAnswer(userInput, target, extraAccepted){
  const userSet = variantsOf(userInput);
  const targetSet = new Set();
  // the literal text as written (parentheses and all) stays accepted too — this is
  // what a multiple-choice button's value always is, since it's copied verbatim
  // from the word's own answer field, not retyped by hand
  variantsOf(target).forEach(v=> targetSet.add(v));
  expandParens(target).forEach(t=> variantsOf(t).forEach(v=> targetSet.add(v)));
  if(extraAccepted){
    extraAccepted.forEach(t=> variantsOf(t).forEach(v=> targetSet.add(v)));
  }
  for(const u of userSet){
    if(!u) continue;
    if(targetSet.has(u)) return {ok:true, close:false};
  }
  for(const u of userSet){
    for(const t of targetSet){
      if(u.length>=4 && t.length>=4 && levenshtein(u,t)<=1) return {ok:true, close:true};
    }
  }
  return {ok:false, close:false};
}

// ---------- db helpers ----------
function wordsForDeck(deckId){
  return Object.entries(words).filter(([id,w])=>!deckId||w.deckId===deckId).map(([id,w])=>({id,...w}));
}
function wordsForDeckIds(ids){
  if(!ids) return Object.entries(words).map(([id,w])=>({id,...w}));
  const set=new Set(ids);
  return Object.entries(words).filter(([id,w])=>set.has(w.deckId)).map(([id,w])=>({id,...w}));
}
function progOf(wordId){
  return progress[wordId] || {box:1, correctStreak:0, correctCount:0, wrongCount:0, nextDue:0, learned:false};
}
function isDue(wordId){
  const p=progress[wordId];
  if(!p) return true;
  return !p.nextDue || p.nextDue<=now();
}
function isMastered(wordId){
  const p=progress[wordId];
  return !!(p && p.box>=5);
}
async function saveProgress(wordId, correct, base){
  const p=base || progOf(wordId);
  let box=p.box||1, streak=p.correctStreak||0;
  let correctCount=p.correctCount||0, wrongCount=p.wrongCount||0;
  if(correct){
    box=Math.min(5, box+1); streak+=1; correctCount+=1;
  } else {
    box=1; streak=0; wrongCount+=1;
  }
  const w=words[wordId];
  const mult = w && deckStatus(w.deckId)==='maintain' ? 2.5 : 1;
  const days=(BOX_INTERVAL_DAYS[box-1]||0)*mult;
  const next={
    box, correctStreak:streak, correctCount, wrongCount,
    lastSeen:iso(), nextDue: now()+days*86400000, learned: box>=5,
  };
  progress[wordId]=next; // optimistic
  try{ await progressCol().doc(wordId).set(next); }
  catch(e){ /* keep optimistic local state; will resync on next snapshot */ }
}

// ---------- rendering: HOME ----------
function deckStatus(id){ return (decks[id] && decks[id].status) || 'active'; }
function openGroupEditor(id, chipEl){
  const d=decks[id];
  const subj=(d.subject||'').trim()||'Overig';
  const current=(d.group||'').trim();
  const groups=groupsForSubject(subj);
  const sel=document.createElement('select');
  sel.className='group-edit-select';
  sel.innerHTML = '<option value="">Geen groep</option>' +
    groups.map(g=>`<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('') +
    '<option value="__new__">+ Nieuwe groep…</option>';
  if(current && groups.includes(current)) sel.value=current;
  sel.onclick=e=>e.stopPropagation();
  const saveGroup=async (val)=>{
    try{ await db.doc('decks/'+id).update({group: val}); }
    catch(err){ toast('Bijwerken mislukt — probeer het opnieuw'); }
  };
  sel.onchange=(e)=>{
    e.stopPropagation();
    if(sel.value==='__new__'){
      const input=document.createElement('input');
      input.type='text'; input.className='group-edit-input'; input.placeholder='Naam van de groep';
      input.onclick=e2=>e2.stopPropagation();
      let done=false;
      const commit=()=>{ if(done) return; done=true; saveGroup(input.value.trim()); };
      input.onblur=commit;
      input.addEventListener('keydown', e2=>{ if(e2.key==='Enter') input.blur(); });
      sel.replaceWith(input);
      requestAnimationFrame(()=> requestAnimationFrame(()=> input.focus()));
      return;
    }
    saveGroup(sel.value);
  };
  chipEl.replaceWith(sel);
  requestAnimationFrame(()=> sel.focus());
}
function deckCardHtml(id){
  const d=decks[id];
  const canEdit=canEditCircle(d.circleId);
  const status=deckStatus(id);
  const archived=status==='archived';
  const ws=wordsForDeck(id);
  const m=ws.filter(w=>isMastered(w.id)).length;
  const dueN=ws.filter(w=>isDue(w.id)).length;
  const pct=ws.length? Math.round(100*m/ws.length):0;
  const card=document.createElement('div');
  card.className='deck'+(archived?' archived':'');
  card.innerHTML=`
    <div class="deck-head">
      <div>
        <h3>${escapeHtml(d.name||'Naamloze lijst')}</h3>
        <div class="deck-langs">${escapeHtml(trLang(d.langA))} ⇄ ${escapeHtml(trLang(d.langB))} · ${ws.length} woord${ws.length===1?'':'en'}</div>
      </div>
      <div class="deck-head-actions">
        ${canEdit? `<button class="deck-edit" data-id="${id}" title="Lijst bewerken">✏️</button>
        <button class="deck-del" data-id="${id}" title="Lijst verwijderen">🗑</button>` : ''}
      </div>
    </div>
    <div class="deck-meta">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <span class="chip">${m}/${ws.length} geleerd</span>
      ${dueN? `<span class="chip due">${dueN} te doen</span>`:''}
      ${canEdit
        ? `<button type="button" class="chip group-chip" data-id="${id}">${(d.group||'').trim() ? '📁 '+escapeHtml(d.group.trim()) : '+ groep'}</button>`
        : ((d.group||'').trim() ? `<span class="chip">📁 ${escapeHtml(d.group.trim())}</span>` : '')}
      ${canEdit
        ? `<select class="status-select" data-id="${id}">
            <option value="active" ${status==='active'?'selected':''}>Bezig</option>
            <option value="maintain" ${status==='maintain'?'selected':''}>Onderhouden (minder vaak)</option>
            <option value="archived" ${status==='archived'?'selected':''}>Gearchiveerd</option>
          </select>`
        : ''}
    </div>`;
  if(canEdit){
    const groupChip=card.querySelector('.group-chip');
    groupChip.onclick=(e)=>{ e.stopPropagation(); openGroupEditor(id, groupChip); };
    const editBtn=card.querySelector('.deck-edit');
    editBtn.onclick=(e)=>{ e.stopPropagation(); openEditDeck(id); };
    const delBtn=card.querySelector('.deck-del');
    delBtn.onclick=(e)=>{
      e.stopPropagation();
      if(delBtn.dataset.armed==='1'){ deleteDeck(id, d.name); return; }
      delBtn.dataset.armed='1'; delBtn.textContent='✓ zeker?'; delBtn.style.color='var(--wrong)';
      clearTimeout(delBtn._t);
      delBtn._t=setTimeout(()=>{ delBtn.dataset.armed='0'; delBtn.textContent='🗑'; delBtn.style.color=''; }, 2500);
    };
    const statusSel=card.querySelector('.status-select');
    statusSel.onclick=(e)=> e.stopPropagation();
    statusSel.onchange=async (e)=>{
      e.stopPropagation();
      const newStatus=statusSel.value;
      try{ await db.doc('decks/'+id).update({status:newStatus}); }
      catch(err){ toast('Bijwerken mislukt — probeer het opnieuw'); }
    };
  }
  if(!archived){
    card.onclick=()=>{
      setPracticeSubject((d.subject||'').trim()||'Overig');
      switchView('practice');
      selectOnlyDeck(id);
    };
  }
  return card;
}

function langTileHtml(subj, onPick){
  const ids=deckIdsForSubject(subj).filter(id=>deckStatus(id)!=='archived');
  const ws=wordsForDeckIds(ids);
  const dueN=ws.filter(w=>isDue(w.id)).length;
  const tile=document.createElement('button');
  tile.type='button'; tile.className='lang-tile';
  tile.innerHTML=`
    <div class="lt-name">${escapeHtml(subj)}</div>
    <div class="lt-meta">${ids.length} lijst${ids.length===1?'':'en'} · ${ws.length} woord${ws.length===1?'':'en'}${dueN? ` · <span class="lt-due">${dueN} te doen</span>`:''}</div>`;
  tile.onclick=onPick;
  return tile;
}

function renderHome(){
  const deckIds=Object.keys(decks);
  const bar=$('#subject-bar');
  const list=$('#deck-list'); list.innerHTML='';

  if(!deckIds.length){
    bar.hidden=true; $('#home-stats').hidden=true;
    list.innerHTML = '<div class="empty"><div class="big">Nog geen lijsten</div>'+
      '<p>Maak een foto van een pagina uit je boek en VocabiTash maakt er een oefenset van.</p>'+
      '<button class="btn btn-primary" id="empty-add-btn">Voeg je eerste lijst toe</button></div>';
    $('#empty-add-btn').onclick=()=>switchView('add');
    return;
  }

  const subjects=distinctSubjects();
  if(homeSubject && !subjects.includes(homeSubject)) homeSubject=''; // the chosen language's last list was removed/renamed

  // ---- no language chosen yet: always show the language picker first, even with just one language ----
  if(!homeSubject){
    bar.hidden=true; $('#home-stats').hidden=true;
    const grid=document.createElement('div'); grid.className='lang-grid';
    subjects.forEach(subj=> grid.appendChild(langTileHtml(subj, ()=>{ homeSubject=subj; homeShowArchived=false; renderHome(); })));
    list.appendChild(grid);
    return;
  }

  // ---- a language is chosen: show its lists, with a way back to the picker ----
  bar.hidden = false;
  bar.innerHTML = `<button class="back-chip" id="back-to-langs">← talen</button>`;
  $('#back-to-langs').onclick=()=>{ homeSubject=''; homeShowArchived=false; renderHome(); };

  const scopeIds = deckIdsForSubject(homeSubject);
  const visibleIds = scopeIds.filter(id=> deckStatus(id)!=='archived');
  const archivedIds = scopeIds.filter(id=> deckStatus(id)==='archived');

  const scopedWords = wordsForDeckIds(visibleIds).map(w=>w.id);
  $('#home-stats').hidden=false;
  $('#st-total').textContent=scopedWords.length;
  $('#st-mastered').textContent=scopedWords.filter(isMastered).length;
  $('#st-due').textContent=scopedWords.filter(isDue).length;

  // ---- cluster lists under their group (within this language); ungrouped lists stay flat, as before ----
  const groups=groupsForSubject(homeSubject);
  const grouped=new Set();
  groups.forEach(g=>{
    const idsInGroup = visibleIds.filter(id=> (decks[id].group||'').trim()===g);
    if(!idsInGroup.length) return;
    idsInGroup.forEach(id=> grouped.add(id));
    const section=document.createElement('div'); section.className='deck-group';
    section.innerHTML = `<div class="deck-group-head">
        <h4>📁 ${escapeHtml(g)}</h4>
        <button type="button" class="chip group-practice-chip">▸ oefen deze groep</button>
      </div>`;
    section.querySelector('.group-practice-chip').onclick=(e)=>{
      e.stopPropagation();
      setPracticeSubject(homeSubject);
      practiceGroupFilter=g;
      switchView('practice');
      selectOnlyDecks(idsInGroup);
    };
    idsInGroup.sort(sortByNew).forEach(id=> section.appendChild(deckCardHtml(id)));
    list.appendChild(section);
  });
  visibleIds.filter(id=>!grouped.has(id)).sort(sortByNew).forEach(id=> list.appendChild(deckCardHtml(id)));

  if(archivedIds.length){
    const toggle=document.createElement('button');
    toggle.className='archived-toggle';
    toggle.textContent=(homeShowArchived?'Verberg':'Toon')+' archief ('+archivedIds.length+')';
    toggle.onclick=()=>{ homeShowArchived=!homeShowArchived; renderHome(); };
    list.appendChild(toggle);
    if(homeShowArchived){
      archivedIds.sort(sortByNew).forEach(id=> list.appendChild(deckCardHtml(id)));
    }
  }
}
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const LANG_NL={English:'Engels', Dutch:'Nederlands', Latin:'Latijn'};
function trLang(s){ return LANG_NL[s] || s; }

async function deleteDeck(id, name){
  const ws=wordsForDeck(id);
  try{
    for(const w of ws){
      await db.doc('words/'+w.id).delete();
      await progressCol().doc(w.id).delete().catch(()=>{});
    }
    await db.doc('decks/'+id).delete();
    toast('Lijst verwijderd');
  }catch(e){ toast('Verwijderen mislukt — probeer het opnieuw'); }
}

// ---------- rendering: EDIT DECK ----------
let editDeckId=null;
let editRows=[];       // {id: wordId|null, a, b, note}
let editDeletedIds=[]; // wordIds removed during this edit session
function buildEditRowEl(r, i, langA, langB){
  const row=document.createElement('div'); row.className='row-edit-wrap';
  row.innerHTML=`
    <div class="row-edit">
      <input type="text" data-k="a" placeholder="${escapeHtml(trLang(langA))}" value="${escapeHtml(r.a)}">
      <input type="text" data-k="b" placeholder="${escapeHtml(trLang(langB))}" value="${escapeHtml(r.b)}">
      <button class="del" title="verwijder">✕</button>
    </div>`;
  row.querySelector('[data-k=a]').oninput=e=>{ editRows[i].a=e.target.value; };
  row.querySelector('[data-k=b]').oninput=e=>{ editRows[i].b=e.target.value; };
  row.querySelector('.del').onclick=()=>{
    const removed=editRows[i];
    if(removed.id) editDeletedIds.push(removed.id);
    editRows.splice(i,1);
    renderEditRows();
  };
  return row;
}
function renderEditRows(){
  const wrap=$('#edit-deck-rows'); wrap.innerHTML='';
  const d=decks[editDeckId]; if(!d) return;
  editRows.forEach((r,i)=> wrap.appendChild(buildEditRowEl(r, i, d.langA, d.langB)));
}
function openEditDeck(id){
  const d=decks[id]; if(!d) return;
  editDeckId=id;
  editDeletedIds=[];
  editRows = wordsForDeck(id)
    .sort((a,b)=> String(a.createdAt||'').localeCompare(String(b.createdAt||'')))
    .map(w=>({id:w.id, a:w.a||'', b:w.b||'', note:w.note||''}));
  $('#edit-deck-name').value = d.name || '';
  const subj=(d.subject||'').trim()||'Overig';
  const groups=groupsForSubject(subj);
  const sel=$('#edit-deck-group-select');
  sel.innerHTML = '<option value="">Geen groep</option>' +
    groups.map(g=>`<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('') +
    '<option value="__new__">+ Nieuwe groep…</option>';
  const current=(d.group||'').trim();
  sel.value = (current && groups.includes(current)) ? current : '';
  $('#edit-deck-group-new').hidden=true; $('#edit-deck-group-new').value='';
  $('#edit-deck-status').textContent='';
  $('#edit-deck-save-btn').disabled=false;
  renderEditRows();
  $('#edit-deck-wrap').hidden=false;
}
function closeEditDeck(){
  $('#edit-deck-wrap').hidden=true;
  editDeckId=null; editRows=[]; editDeletedIds=[];
}
function editDeckGroupValue(){
  const sel=$('#edit-deck-group-select');
  if(sel.value==='__new__') return $('#edit-deck-group-new').value.trim();
  return sel.value;
}
async function saveEditDeck(){
  if(!editDeckId) return;
  const d=decks[editDeckId]; if(!d) return;
  const name=$('#edit-deck-name').value.trim() || 'Naamloze lijst';
  const group=editDeckGroupValue();
  const rows=editRows.filter(r=> r.a.trim() && r.b.trim());
  if(!rows.length){ $('#edit-deck-status').textContent='Een lijst moet minstens één compleet woordpaar hebben.'; return; }
  $('#edit-deck-save-btn').disabled=true;
  $('#edit-deck-status').textContent='Bezig met opslaan…';
  try{
    await db.doc('decks/'+editDeckId).update({name, group});
    for(const delId of editDeletedIds){
      await db.doc('words/'+delId).delete();
      await progressCol().doc(delId).delete().catch(()=>{});
      await acceptedCol().doc(delId).delete().catch(()=>{});
      await mnemonicsCol().doc(delId).delete().catch(()=>{});
    }
    for(const r of rows){
      const at=r.a.trim(), bt=r.b.trim();
      if(r.id){
        const orig=words[r.id];
        if(!orig || orig.a!==at || orig.b!==bt){
          await db.doc('words/'+r.id).update({a:at, b:bt});
        }
      } else {
        await db.collection('words').add({deckId:editDeckId, circleId:d.circleId, a:at, b:bt, createdAt:iso()});
      }
    }
    toast('Lijst bijgewerkt');
    closeEditDeck();
  }catch(e){
    $('#edit-deck-status').textContent='Opslaan mislukt — probeer het opnieuw.';
  }finally{
    $('#edit-deck-save-btn').disabled=false;
  }
}

// ---------- rendering: ADD ----------
function renderShotThumbnails(){
  const wrap=$('#shot-thumbs');
  const hasFiles=shotFiles.length>0;
  $('#shot-empty').hidden=hasFiles;
  wrap.hidden=!hasFiles;
  wrap.innerHTML = shotFiles.map((f,i)=>`<div class="shot-thumb"><img src="${URL.createObjectURL(f)}"><button type="button" class="shot-thumb-del" data-i="${i}" title="verwijder">✕</button></div>`).join('');
  wrap.querySelectorAll('.shot-thumb-del').forEach(btn=>{
    btn.onclick=(e)=>{
      e.stopPropagation();
      shotFiles.splice(Number(btn.dataset.i), 1);
      renderShotThumbnails();
      $('#extract-btn').disabled = shotFiles.length===0;
    };
  });
}
function resetAddForm(){
  shotFiles=[]; reviewRows=[];
  splitBySections=false; sectionSuggestionDismissed=false; sectionGroupNames={};
  renderShotThumbnails();
  $('#deck-name').value=''; $('#extract-btn').disabled=true;
  $('#extract-status').textContent='';
  $('#review-panel').hidden=true;
  $('#review-rows').innerHTML='';
  $('#section-suggestion').hidden=true; $('#section-suggestion').innerHTML='';
  $('#split-suggestion').hidden=true;
  $('#save-deck-split-btn').hidden=true;
  $('#save-deck-btn').textContent='Lijst opslaan';
  populateLangOptions();
}
function setAddMode(mode){
  $('#add-mode-toggle').querySelectorAll('button').forEach(b=> b.classList.toggle('active', b.dataset.mode===mode));
  $('#add-mode-photo').hidden = mode!=='photo';
  $('#add-mode-import').hidden = mode!=='import';
  if(mode==='import'){ $('#import-status').textContent=''; resetImportUi(); }
}
function currentLearnLang(){
  const sel=$('#learn-lang-select').value;
  return sel==='__new__' ? $('#learn-lang-new').value.trim() : sel;
}
function currentLangPair(){
  const a=currentLearnLang() || 'Taal A';
  const b=$('#other-lang-input').value.trim() || 'Nederlands';
  return [a,b];
}
const BUILTIN_LEARN_LANGS=['Engels','Frans','Duits','Latijn','Grieks'];
function populateLangOptions(){
  const used=distinctSubjects().filter(s=>s!=='Overig');
  const all=Array.from(new Set(BUILTIN_LEARN_LANGS.concat(used))).sort((a,b)=>a.localeCompare(b));
  const sel=$('#learn-lang-select');
  const prev=sel.value;
  sel.innerHTML = '<option value="">Kies een taal...</option>' +
    all.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('') +
    '<option value="__new__">+ Nieuwe taal toevoegen…</option>';
  if(Array.from(sel.options).some(o=>o.value===prev)) sel.value=prev;
  // the "vertaald vanuit/naar" field stays free text — its presets include Nederlands
  // (the usual target) plus the built-in and already-used languages, as a starting point
  const dl=$('#lang-presets');
  const otherAll=Array.from(new Set(['Nederlands'].concat(BUILTIN_LEARN_LANGS).concat(used))).sort((a,b)=>a.localeCompare(b));
  dl.innerHTML = otherAll.map(s=>`<option value="${escapeHtml(s)}">`).join('');
}
// ---------- duplicate detection against already-saved lists ----------
function normWord(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,' '); }
function splitAlts(s){ return normWord(s).split(',').map(x=>x.trim()).filter(Boolean); }
function findDuplicateDeckName(a,b){
  const na=normWord(a);
  if(!na) return null;
  const bAlts=new Set(splitAlts(b));
  for(const id in words){
    const w=words[id];
    if(normWord(w.a)!==na) continue;
    const wAlts=splitAlts(w.b);
    const overlaps = !bAlts.size || !wAlts.length || wAlts.some(x=>bAlts.has(x));
    if(overlaps){
      const deck=decks[w.deckId];
      return (deck && deck.name) ? deck.name : 'een andere lijst';
    }
  }
  return null;
}
function markDuplicates(){
  reviewRows.forEach(r=>{ r.dupDeck = findDuplicateDeckName(r.a, r.b); });
}
function updateDupChip(rowEl, i){
  const r=reviewRows[i];
  r.dupDeck = findDuplicateDeckName(r.a, r.b);
  let chip = rowEl.querySelector('.dup-chip');
  if(r.dupDeck){
    if(!chip){ chip=document.createElement('div'); chip.className='chip dup-chip'; rowEl.appendChild(chip); }
    chip.textContent = `⚠️ staat mogelijk al in “${r.dupDeck}”`;
  } else if(chip){
    chip.remove();
  }
}
function buildRowEl(r, i, langA, langB){
  const row=document.createElement('div'); row.className='row-edit-wrap';
  row.innerHTML=`
    <div class="row-edit">
      <input type="text" data-k="a" placeholder="${escapeHtml(trLang(langA))}" value="${escapeHtml(r.a)}">
      <input type="text" data-k="b" placeholder="${escapeHtml(trLang(langB))}" value="${escapeHtml(r.b)}">
      <button class="del" title="verwijder">✕</button>
    </div>
    ${r.dupDeck ? `<div class="chip dup-chip">⚠️ staat mogelijk al in “${escapeHtml(r.dupDeck)}”</div>` : ''}`;
  row.querySelector('[data-k=a]').oninput=e=>{ reviewRows[i].a=e.target.value; updateDupChip(row,i); };
  row.querySelector('[data-k=b]').oninput=e=>{ reviewRows[i].b=e.target.value; updateDupChip(row,i); };
  row.querySelector('.del').onclick=()=>{ reviewRows.splice(i,1); renderReviewRows(); };
  return row;
}
// the distinct section headings the extraction found on the photo, in the order first seen
// (an empty/omitted section on a row means that row wasn't under any heading)
function detectedSections(){
  const keys=[]; const seen=new Set();
  reviewRows.forEach(r=>{ const k=(r.section||'').trim(); if(k && !seen.has(k)){ seen.add(k); keys.push(k); } });
  return keys;
}
function renderReviewRows(){
  const wrap=$('#review-rows'); wrap.innerHTML='';
  const [langA,langB]=currentLangPair();
  const secs=detectedSections();
  const canSplit = secs.length>=2;

  // ---- offer to split by the sections the photo itself seems to have — her choice, not automatic ----
  const sug=$('#section-suggestion');
  if(canSplit && !splitBySections){
    sug.hidden=false;
    sug.innerHTML = `Deze foto lijkt ${secs.length} delen te hebben: <b>${secs.map(escapeHtml).join('</b>, <b>')}</b>. `+
      `Opslaan als ${secs.length} losse lijsten, of toch als één lijst?`+
      `<div style="display:flex; gap:8px; margin-top:10px">`+
      `<button class="btn btn-primary btn-sm" id="section-split-yes" type="button">Ja, ${secs.length} lijsten</button>`+
      `<button class="btn btn-ghost btn-sm" id="section-split-no" type="button">Nee, één lijst</button>`+
      `</div>`;
    $('#section-split-yes').onclick=()=>{ splitBySections=true; renderReviewRows(); };
    $('#section-split-no').onclick=()=>{ sectionSuggestionDismissed=true; renderReviewRows(); };
  } else {
    sug.hidden=true; sug.innerHTML='';
  }

  if(splitBySections && canSplit){
    // ---- grouped mode: one editable, pre-named list per detected section ----
    $('#split-suggestion').hidden=true;
    $('#save-deck-split-btn').hidden=true;
    const hasUnlabeled = reviewRows.some(r=>!(r.section||'').trim());
    const groupKeys = hasUnlabeled ? secs.concat(['']) : secs;
    let groupCount=0;
    groupKeys.forEach(key=>{
      const idxs=[]; reviewRows.forEach((r,i)=>{ if((r.section||'').trim()===key) idxs.push(i); });
      if(!idxs.length) return;
      groupCount++;
      if(!(key in sectionGroupNames)) sectionGroupNames[key] = key || (langA+' – overig');
      const title=document.createElement('div'); title.className='section-group';
      title.innerHTML = `<label>Naam van deze lijst</label><input type="text" class="section-group-name" value="${escapeHtml(sectionGroupNames[key])}">`;
      title.querySelector('input').oninput=e=>{ sectionGroupNames[key]=e.target.value; };
      wrap.appendChild(title);
      idxs.forEach(i=> wrap.appendChild(buildRowEl(reviewRows[i], i, langA, langB)));
    });
    $('#save-deck-btn').textContent = `${groupCount} lijsten opslaan`;
  } else {
    // ---- flat mode: today's single-list behavior ----
    const long = reviewRows.length>LONG_LIST_THRESHOLD;
    $('#split-suggestion').hidden = !long;
    $('#save-deck-split-btn').hidden = !long;
    $('#save-deck-btn').textContent = 'Lijst opslaan';
    reviewRows.forEach((r,i)=> wrap.appendChild(buildRowEl(r, i, langA, langB)));
  }
}

async function extractFromPhoto(){
  if(!shotFiles.length){ return; }
  if(!sampleFn){ toast('Claude is niet beschikbaar in deze weergave'); return; }
  const [langA,langB]=currentLangPair();
  const multi = shotFiles.length>1;
  $('#extract-btn').disabled=true;
  $('#extract-status').textContent = multi ? `${shotFiles.length} foto's worden gelezen…` : 'Foto wordt gelezen…';
  const prompt = (multi
      ? `These ${shotFiles.length} photos all belong to the same page (or consecutive pages) from a Dutch student's school vocabulary list — read them together, in the order given, as ONE combined list, and skip any pair that is a clear duplicate appearing in more than one photo. `
      : `This photo shows a page from a Dutch student's school vocabulary list. `
    )+
    `They pair words in ${langA} and ${langB}. `+
    `Read every word pair you can make out, in the order printed. The two languages may appear in either column — `+
    `put each word in its correct language slot regardless of which side it was printed on. `+
    `The page may be split into clearly printed sections (e.g. "Part A - A Family Get-Together", "Part B - Hanging Out with Friends", "Adjectives") — if so, record for each pair exactly which section it was printed under. `+
    `Reply with ONLY a JSON array, one object per pair: `+
    `{"a": "<the ${langA} word or phrase, exactly as written>", "b": "<the ${langB} word or phrase, exactly as written; if the source lists more than one accepted translation, keep them together separated by commas>", "note": "<a short grammatical note ONLY if the source actually prints one next to the word, e.g. gender, genitive ending, principal parts, plural form — omit this field entirely if there is none>", "section": "<the exact printed heading of the section this pair belongs to, e.g. \\"Part A - A Family Get-Together\\" — omit this field entirely if the page has no clear section headings>"}. `+
    `Skip page numbers, chapter headers, and anything that is not a vocabulary pair.`;
  try{
    const data = await sampleFn.json(prompt, {images: shotFiles, cache:false});
    const arr = Array.isArray(data)? data : (Array.isArray(data?.items)? data.items : null);
    if(!arr || !arr.length) throw {code:'empty'};
    splitBySections=false; sectionSuggestionDismissed=false; sectionGroupNames={};
    reviewRows = arr.map(it=>({ a:String(it.a||'').trim(), b:String(it.b||'').trim(), note: it.note? String(it.note).trim(): '', section: it.section? String(it.section).trim(): '' }))
      .filter(r=>r.a || r.b);
    if(!reviewRows.length) throw {code:'empty'};
    markDuplicates();
    const dupCount = reviewRows.filter(r=>r.dupDeck).length;
    let status = `${reviewRows.length} woord${reviewRows.length===1?'':'en'} gevonden — controleer ze hieronder voor je opslaat.`;
    if(dupCount) status += ` ⚠️ ${dupCount} woord${dupCount===1?'':'en'} sta${dupCount===1?'at':'an'} mogelijk al in een andere lijst — zie de gemarkeerde regels hieronder.`;
    $('#extract-status').textContent=status;
    $('#review-panel').hidden=false;
    renderReviewRows();
    if(!$('#deck-name').value.trim()){
      $('#deck-name').value = trLang(langA)+' – '+trLang(langB)+' lijst';
    }
  }catch(e){
    const code=e&&e.code;
    const msg = code==='not_granted' ? "Je moet Claude toestaan om foto's te lezen voor deze app — probeer het opnieuw en accepteer de vraag."
      : code==='rate_limited' ? "Te veel aanvragen op dit moment — wacht even en probeer het opnieuw."
      : code==='image_rejected' ? (multi ? "Eén van die foto's kon niet gelezen worden — probeer scherpere foto's met goed licht, of wat minder foto's in één keer." : "Die foto kon niet gelezen worden — probeer een scherpere foto met goed licht.")
      : code==='empty' || code==='invalid_json' ? (multi ? "Kon geen woordenlijst herkennen op die foto's — probeer dichterbij te fotograferen of minder glans." : "Kon geen woordenlijst herkennen op die foto — probeer dichterbij te fotograferen of minder glans.")
      : multi ? "Er ging iets mis bij het lezen van de foto's — probeer het opnieuw."
      : "Er ging iets mis bij het lezen van de foto — probeer het opnieuw.";
    $('#extract-status').textContent=msg;
  }finally{
    $('#extract-btn').disabled = shotFiles.length===0;
  }
}

async function createDeckWithRows(name, subject, langA, langB, rows){
  const deckRef = await db.collection('decks').add({name, subject, langA, langB, status:'active', createdAt:iso(), circleId:activeCircleId});
  for(const r of rows){
    const body={deckId:deckRef.id, circleId:activeCircleId, a:r.a.trim(), b:r.b.trim(), createdAt:iso()};
    if(r.note && r.note.trim()) body.note=r.note.trim();
    await db.collection('words').add(body);
  }
  return deckRef;
}
async function saveDeck(){
  if(!activeCircleId){ toast('Kies of maak eerst een cirkel in Instellingen'); return; }
  const name=$('#deck-name').value.trim() || 'Naamloze lijst';
  const subject=currentLearnLang();
  const [langA,langB]=currentLangPair();
  const rows=reviewRows.filter(r=>r.a.trim() && r.b.trim());
  if(!rows.length){ toast('Voeg minstens één compleet woordpaar toe'); return; }
  $('#save-deck-btn').disabled=true; $('#save-deck-split-btn').disabled=true;
  try{
    await createDeckWithRows(name, subject, langA, langB, rows);
    toast('Opgeslagen — klaar om te oefenen');
    resetAddForm();
    switchView('home');
  }catch(e){
    toast('Opslaan mislukt — probeer het opnieuw');
  }finally{
    $('#save-deck-btn').disabled=false; $('#save-deck-split-btn').disabled=false;
  }
}
async function saveDeckSplit(){
  const name=$('#deck-name').value.trim() || 'Naamloze lijst';
  const subject=currentLearnLang();
  const [langA,langB]=currentLangPair();
  const rows=reviewRows.filter(r=>r.a.trim() && r.b.trim());
  if(!rows.length){ toast('Voeg minstens één compleet woordpaar toe'); return; }
  const mid=Math.ceil(rows.length/2);
  const partA=rows.slice(0,mid), partB=rows.slice(mid);
  $('#save-deck-btn').disabled=true; $('#save-deck-split-btn').disabled=true;
  try{
    await createDeckWithRows(name+' — deel A', subject, langA, langB, partA);
    await createDeckWithRows(name+' — deel B', subject, langA, langB, partB);
    toast('Opgeslagen als twee lijsten — deel A en deel B');
    resetAddForm();
    switchView('home');
  }catch(e){
    toast('Opslaan mislukt — probeer het opnieuw');
  }finally{
    $('#save-deck-btn').disabled=false; $('#save-deck-split-btn').disabled=false;
  }
}
async function saveDeckMultiSection(){
  const subject=currentLearnLang();
  const [langA,langB]=currentLangPair();
  const secs=detectedSections();
  const hasUnlabeled = reviewRows.some(r=>!(r.section||'').trim());
  const groupKeys = hasUnlabeled ? secs.concat(['']) : secs;
  const groups = groupKeys.map(key=>({
    name: (sectionGroupNames[key]||key||(langA+' – overig')).trim() || 'Naamloze lijst',
    rows: reviewRows.filter(r=>(r.section||'').trim()===key && r.a.trim() && r.b.trim()),
  })).filter(g=>g.rows.length);
  if(!groups.length){ toast('Voeg minstens één compleet woordpaar toe'); return; }
  $('#save-deck-btn').disabled=true;
  try{
    for(const g of groups){ await createDeckWithRows(g.name, subject, langA, langB, g.rows); }
    toast(`Opgeslagen als ${groups.length} lijsten`);
    resetAddForm();
    switchView('home');
  }catch(e){
    toast('Opslaan mislukt — probeer het opnieuw');
  }finally{
    $('#save-deck-btn').disabled=false;
  }
}
function saveDeckDispatch(){
  if(splitBySections && detectedSections().length>=2) return saveDeckMultiSection();
  return saveDeck();
}

// ---------- rendering: PRACTICE SETUP ----------
function renderPracticeSetup(){
  const has = Object.keys(words).length>0;
  $('#practice-empty').hidden = has;
  $('#practice-form').hidden = !has;
  if(!has) return;

  const subs=distinctSubjects();
  if(practiceSubject && !subs.includes(practiceSubject)) setPracticeSubject(''); // the chosen language's last list was removed/renamed

  const bar=$('#practice-subject-bar');
  const grid=$('#practice-lang-grid');
  const details=$('#practice-details');

  // ---- no language chosen yet: show the same language picker as the start screen ----
  if(!practiceSubject){
    bar.hidden=true;
    details.hidden=true;
    grid.hidden=false;
    grid.innerHTML='';
    subs.forEach(subj=> grid.appendChild(langTileHtml(subj, ()=>{ setPracticeSubject(subj); renderPracticeSetup(); })));
    return;
  }

  // ---- a language is chosen: show the practice menu for just that language ----
  grid.hidden=true;
  bar.hidden=false;
  bar.innerHTML = `<button class="back-chip" id="practice-back-to-langs">← talen</button>`;
  $('#practice-back-to-langs').onclick=()=>{ setPracticeSubject(''); renderPracticeSetup(); };
  details.hidden=false;
  populatePracticeDecks();
}
let practiceDeckSelection={}; // deckId -> boolean, lazily defaults to true (selected) the first time a deck is seen
function selectedDeckIdsRaw(){
  return Array.from($('#practice-deck-list').querySelectorAll('input[data-id]:checked')).map(cb=>cb.dataset.id);
}
function currentPracticeDeckIds(){
  const ids = selectedDeckIdsRaw();
  const includeMaintain = $('#include-maintain').checked;
  return includeMaintain ? ids : ids.filter(id=>deckStatus(id)!=='maintain');
}
function updateMaintainVisibility(){
  const hasMaintain = selectedDeckIdsRaw().some(id=>deckStatus(id)==='maintain');
  $('#maintain-field').hidden = !hasMaintain;
}
function selectOnlyDecks(ids){
  const set=new Set(ids);
  const wrap=$('#practice-deck-list');
  wrap.querySelectorAll('input[data-id]').forEach(cb=>{
    const on = set.has(cb.dataset.id);
    cb.checked=on; practiceDeckSelection[cb.dataset.id]=on;
    cb.closest('.check').classList.toggle('on', on);
  });
  updateMaintainVisibility(); updateDirectionHint();
}
function selectOnlyDeck(id){ selectOnlyDecks([id]); }
function populatePracticeDecks(){
  // ---- group filter: narrow which lists are even shown/selectable below, her own choice ----
  const groups=groupsForSubject(practiceSubject);
  if(practiceGroupFilter && !groups.includes(practiceGroupFilter)) practiceGroupFilter='';
  const chips=$('#practice-group-chips');
  if(groups.length){
    chips.hidden=false;
    const options=[''].concat(groups);
    chips.innerHTML = options.map(g=>{
      const label = g ? ('📁 '+escapeHtml(g)) : 'Alle lijsten';
      return `<button type="button" class="chip filter-chip${practiceGroupFilter===g?' active':''}" data-g="${escapeHtml(g)}">${label}</button>`;
    }).join('');
    chips.querySelectorAll('.filter-chip').forEach(btn=>{
      btn.onclick=()=>{ practiceGroupFilter=btn.dataset.g; populatePracticeDecks(); };
    });
  } else {
    chips.hidden=true; chips.innerHTML=''; practiceGroupFilter='';
  }

  const ids = deckIdsForSubject(practiceSubject)
    .filter(id=>deckStatus(id)!=='archived')
    .filter(id=> !practiceGroupFilter || (decks[id].group||'').trim()===practiceGroupFilter)
    .sort(sortByNew);
  const wrap=$('#practice-deck-list');
  wrap.innerHTML = ids.map(id=>{
    if(!(id in practiceDeckSelection)) practiceDeckSelection[id]=true;
    const checked=practiceDeckSelection[id];
    return `<label class="check${checked?' on':''}"><input type="checkbox" data-id="${id}" ${checked?'checked':''}> ${escapeHtml(decks[id].name||'Naamloze lijst')}${deckStatus(id)==='maintain'?' (onderhouden)':''}</label>`;
  }).join('') || `<p class="muted" style="font-size:.82rem">${practiceGroupFilter? 'Geen lijsten in deze groep.' : 'Nog geen lijsten in dit vak.'}</p>`;
  wrap.querySelectorAll('input[data-id]').forEach(cb=>{
    cb.onchange=()=>{
      practiceDeckSelection[cb.dataset.id]=cb.checked;
      cb.closest('.check').classList.toggle('on', cb.checked);
      updateMaintainVisibility(); updateDirectionHint();
    };
  });
  updateMaintainVisibility();
  updateDirectionHint();
}
function updateDirectionHint(){
  const ids=currentPracticeDeckIds();
  const relevant = ids.map(id=>decks[id]).filter(Boolean);
  let a='woord', b='vertaling';
  if(relevant.length){ a=trLang(relevant[0].langA); b=trLang(relevant[0].langB); }
  const dir=$('#practice-direction').querySelector('.active')?.dataset.v || 'ab';
  const hint = dir==='ab' ? `Toont ${a}, jij antwoordt in het ${b}.`
    : dir==='ba' ? `Toont ${b}, jij antwoordt in het ${a}.`
    : `Wisselt beide richtingen af.`;
  const mixedPairs = new Set(relevant.map(r=>r.langA+'|'+r.langB)).size>1;
  $('#direction-hint').textContent = mixedPairs ? hint+' (dit vak combineert verschillende taalparen)' : hint;
}

// ---------- rendering: SETTINGS ----------
function renderSettings(){
  applyActiveCircleUI();
  $('#settings-reset-confirm').hidden=true;
  $('#settings-reset-status').textContent='';
  const sel=$('#settings-subject');
  const prev=sel.value;
  const subs=distinctSubjects();
  sel.innerHTML = '<option value="">Alles (alle talen)</option>' +
    subs.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  if(Array.from(sel.options).some(o=>o.value===prev)) sel.value=prev;
  populateSettingsDecks();
  populateExportScope();
  $('#export-btn').disabled = !downloadsCap;
  if(!downloadsCap) $('#export-status').textContent='Exporteren is in deze weergave niet beschikbaar.';
}
function populateSettingsDecks(){
  const vak=$('#settings-subject').value;
  const field=$('#settings-deck-field');
  const sel=$('#settings-deck');
  if(!vak){ field.hidden=true; sel.innerHTML=''; return; }
  field.hidden=false;
  const prev=sel.value;
  const ids=deckIdsForSubject(vak).sort(sortByNew);
  sel.innerHTML = '<option value="">Alle lijsten in dit vak</option>' +
    ids.map(id=>`<option value="${id}">${escapeHtml(decks[id].name||'Naamloze lijst')}</option>`).join('');
  if(Array.from(sel.options).some(o=>o.value===prev)) sel.value=prev;
}
function settingsScopeWordIds(){
  const vak=$('#settings-subject').value;
  const deckId=$('#settings-deck').value;
  if(!vak) return Object.keys(words);
  const ids = deckId ? [deckId] : deckIdsForSubject(vak);
  return wordsForDeckIds(ids).map(w=>w.id);
}
function settingsScopeLabel(){
  const vak=$('#settings-subject').value;
  const deckId=$('#settings-deck').value;
  if(!vak) return 'alle talen';
  if(deckId) return `“${decks[deckId]?.name||'deze lijst'}”`;
  return `“${vak}”`;
}
async function performProgressReset(){
  const ids=settingsScopeWordIds().filter(id=> progress[id]); // only words that actually have progress to clear
  $('#settings-reset-confirm-btn').disabled=true;
  $('#settings-reset-status').textContent='Bezig met resetten…';
  try{
    for(const id of ids){
      delete progress[id]; // optimistic
      await progressCol().doc(id).delete().catch(()=>{});
    }
    $('#settings-reset-status').textContent = ids.length
      ? `Klaar — voortgang van ${ids.length} woord${ids.length===1?'':'en'} in ${settingsScopeLabel()} is gereset.`
      : `Er was nog geen voortgang om te resetten in ${settingsScopeLabel()}.`;
    $('#settings-reset-confirm').hidden=true;
    if(currentView==='home') renderHome();
  }catch(e){
    $('#settings-reset-status').textContent='Er ging iets mis — probeer het opnieuw.';
  }finally{
    $('#settings-reset-confirm-btn').disabled=false;
  }
}

// ---------- export / import ----------
function populateExportScope(){
  const sel=$('#export-subject');
  const prev=sel.value;
  const subs=distinctSubjects();
  sel.innerHTML = '<option value="">Alle talen</option>' + subs.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  if(Array.from(sel.options).some(o=>o.value===prev)) sel.value=prev;
  populateExportDeckOptions();
}
function populateExportDeckOptions(){
  const vak=$('#export-subject').value;
  const dsel=$('#export-deck');
  const prev=dsel.value;
  if(!vak){
    dsel.innerHTML = '<option value="all">Alle lijsten (alle talen)</option>';
    dsel.disabled=true;
    return;
  }
  dsel.disabled=false;
  const groups=groupsForSubject(vak);
  const ids=deckIdsForSubject(vak).sort(sortByNew);
  let html = `<option value="all">Alle lijsten in ${escapeHtml(vak)}</option>`;
  if(groups.length) html += groups.map(g=>`<option value="group:${escapeHtml(g)}">📁 ${escapeHtml(g)}</option>`).join('');
  html += ids.map(id=>`<option value="deck:${id}">${escapeHtml(decks[id].name||'Naamloze lijst')}</option>`).join('');
  dsel.innerHTML = html;
  if(Array.from(dsel.options).some(o=>o.value===prev)) dsel.value=prev;
}
function exportScopeDeckIds(){
  const vak=$('#export-subject').value;
  const val=$('#export-deck').value;
  if(!vak) return Object.keys(decks);
  if(val.startsWith('group:')){
    const g=val.slice(6);
    return deckIdsForSubject(vak).filter(id=>(decks[id].group||'').trim()===g);
  }
  if(val.startsWith('deck:')) return [val.slice(5)];
  return deckIdsForSubject(vak);
}
function exportScopeSlug(){
  const vak=$('#export-subject').value;
  const val=$('#export-deck').value;
  let label='lijsten';
  if(vak){
    if(val.startsWith('group:')) label=val.slice(6);
    else if(val.startsWith('deck:')) label=(decks[val.slice(5)]||{}).name || 'lijst';
    else label=vak;
  }
  return 'vocabitash-'+(label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'lijsten')+'.json';
}
async function exportSelectedScope(){
  const ids=exportScopeDeckIds();
  if(!ids.length){ $('#export-status').textContent='Geen lijsten gevonden om te exporteren.'; return; }
  if(!downloadsCap){ $('#export-status').textContent='Exporteren is in deze weergave niet beschikbaar.'; return; }
  const payload = {
    app:'vocabitash', version:1, exportedAt:iso(),
    decks: ids.map(id=>{
      const d=decks[id]||{};
      return {
        name: d.name||'Naamloze lijst', subject: d.subject||'', langA: d.langA||'', langB: d.langB||'',
        group: (d.group||'').trim(),
        words: wordsForDeck(id).map(w=>{ const o={a:w.a||'', b:w.b||''}; if(w.note) o.note=w.note; return o; })
      };
    })
  };
  $('#export-btn').disabled=true;
  $('#export-status').textContent='Bestand maken…';
  try{
    await downloadsCap.save({filename: exportScopeSlug(), data: JSON.stringify(payload, null, 2)});
    const n=payload.decks.length, wc=payload.decks.reduce((s,d)=>s+d.words.length,0);
    $('#export-status').textContent = `Opgeslagen — ${n} lijst${n===1?'':'en'}, ${wc} woord${wc===1?'':'en'}. Je kunt dit bestand nu versturen.`;
  }catch(e){
    const code=e&&e.code;
    $('#export-status').textContent = code==='declined' ? 'Niet opgeslagen.' : 'Opslaan mislukt — probeer het opnieuw.';
  }finally{
    $('#export-btn').disabled=false;
  }
}
let importPayload=null;
function validateImportPayload(payload){
  if(!payload || typeof payload!=='object') return 'Dit bestand is geen geldig VocabiTash-bestand.';
  if(!Array.isArray(payload.decks) || !payload.decks.length) return 'Dit bestand bevat geen lijsten.';
  for(const d of payload.decks){ if(!d || typeof d!=='object' || !Array.isArray(d.words)) return 'Dit bestand bevat geen lijsten.'; }
  return null;
}
function resetImportUi(){
  importPayload=null;
  $('#import-preview').hidden=true; $('#import-preview').innerHTML='';
  $('#import-confirm-btn').hidden=true;
}
function handleImportFile(file){
  resetImportUi();
  $('#import-status').textContent='Bestand wordt gelezen…';
  const reader=new FileReader();
  reader.onload=()=>{
    let payload;
    try{ payload=JSON.parse(String(reader.result||'')); }
    catch(e){ $('#import-status').textContent='Dit bestand kon niet gelezen worden — is het een VocabiTash-bestand (.json)?'; return; }
    const err=validateImportPayload(payload);
    if(err){ $('#import-status').textContent=err; return; }
    importPayload=payload;
    const n=payload.decks.length;
    const wc=payload.decks.reduce((s,d)=>s+(d.words?d.words.length:0),0);
    $('#import-status').textContent=`${n} lijst${n===1?'':'en'}, ${wc} woord${wc===1?'':'en'} gevonden:`;
    $('#import-preview').hidden=false;
    $('#import-preview').innerHTML = '<ul style="margin:0; padding-left:18px">' +
      payload.decks.map(d=>`<li>${escapeHtml(d.name||'Naamloze lijst')} <span class="muted">(${escapeHtml(trLang(d.subject||'')||'onbekende taal')}, ${(d.words||[]).length} woord${(d.words||[]).length===1?'':'en'})</span></li>`).join('') +
      '</ul>';
    $('#import-confirm-btn').hidden=false;
  };
  reader.onerror=()=>{ $('#import-status').textContent='Bestand lezen mislukt — probeer het opnieuw.'; };
  reader.readAsText(file);
}
async function confirmImport(){
  if(!importPayload) return;
  if(!activeCircleId){ $('#import-status').textContent='Kies of maak eerst een cirkel in Instellingen.'; return; }
  $('#import-confirm-btn').disabled=true;
  $('#import-status').textContent='Bezig met importeren…';
  try{
    let deckCount=0, wordCount=0;
    for(const d of importPayload.decks){
      const rows=(d.words||[]).filter(w=> w && String(w.a||'').trim() && String(w.b||'').trim());
      if(!rows.length) continue;
      const deckRef=await db.collection('decks').add({
        name: String(d.name||'Geïmporteerde lijst').trim() || 'Geïmporteerde lijst',
        subject: String(d.subject||'').trim(),
        langA: String(d.langA||'').trim(),
        langB: String(d.langB||'').trim(),
        group: String(d.group||'').trim(),
        status:'active', createdAt: iso(), circleId: activeCircleId
      });
      for(const w of rows){
        const body={deckId:deckRef.id, circleId:activeCircleId, a:String(w.a).trim(), b:String(w.b).trim(), createdAt: iso()};
        if(w.note && String(w.note).trim()) body.note=String(w.note).trim();
        await db.collection('words').add(body);
      }
      deckCount++; wordCount+=rows.length;
    }
    toast(`Geïmporteerd — ${deckCount} lijst${deckCount===1?'':'en'}, ${wordCount} woord${wordCount===1?'':'en'}`);
    $('#import-status').textContent='';
    resetImportUi();
    $('#import-file-input').value='';
  }catch(e){
    $('#import-status').textContent='Importeren mislukt — probeer het opnieuw.';
  }finally{
    $('#import-confirm-btn').disabled=false;
  }
}

// ---------- QUIZ ----------
function capMaintain(list){
  // when a session mixes actively-practiced words with "maintaining" ones, let the
  // maintained words show up, but don't let them crowd out the active material
  const activeItems = list.filter(w=> deckStatus(w.deckId)!=='maintain');
  const maintainItems = list.filter(w=> deckStatus(w.deckId)==='maintain');
  if(!activeItems.length || !maintainItems.length) return list;
  const cap = Math.max(2, Math.ceil(activeItems.length*0.35));
  shuffle(maintainItems);
  return activeItems.concat(maintainItems.slice(0, cap));
}
function newestDeckId(){
  let best=null;
  for(const id in decks){
    if(!best || (decks[id].createdAt||'') > (decks[best].createdAt||'')) best=id;
  }
  return best;
}
function buildQueue(deckIds, direction){
  let pool = wordsForDeckIds(deckIds);
  if(!pool.length) return [];
  const due = pool.filter(w=>isDue(w.id));
  const notDue = pool.filter(w=>!isDue(w.id))
    .sort((x,y)=> (progress[x.id]?.lastSeen||'').localeCompare(progress[y.id]?.lastSeen||''));
  let chosen = due.slice();
  const target = Math.min(20, Math.max(8, pool.length));
  if(chosen.length < target) chosen = chosen.concat(notDue.slice(0, target-chosen.length));
  if(!chosen.length) chosen = pool.slice(0, Math.min(20,pool.length));
  chosen = capMaintain(chosen);

  // the list most recently added gets a guaranteed second pass this session,
  // spaced apart from the first so it's real repetition, not a repeat question
  const round1 = shuffle(chosen.slice());
  const newId = newestDeckId();
  const newestWords = newId ? chosen.filter(w=>w.deckId===newId) : [];
  const finalWords = newestWords.length ? round1.concat(shuffle(newestWords.slice())) : round1;

  return finalWords.map(w=>{
    let dir = direction;
    if(direction==='mix') dir = Math.random()<0.5?'ab':'ba';
    return {wordId:w.id, dir, extraTries:0};
  });
}
function shuffle(arr){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }

function startQuiz(){
  const deckIds=currentPracticeDeckIds();
  const direction=$('#practice-direction').querySelector('.active')?.dataset.v || 'ab';
  const modes=[];
  if($('#mode-type').checked) modes.push('type');
  if($('#mode-choice').checked) modes.push('choice');
  if(!modes.length){ toast('Kies minstens één manier van antwoorden'); return; }
  if(!deckIds.length){ toast('Kies minstens één lijst om te oefenen'); return; }
  const queue=buildQueue(deckIds, direction);
  if(!queue.length){ toast('Geen woorden om te oefenen'); return; }
  quiz={
    deckIds, direction, modes, queue, pos:0, total:queue.length,
    totalWords: new Set(queue.map(q=>q.wordId)).size,
    firstTryCorrect:0, answeredIds:new Set(), wrongWords:new Map(), masteredBefore:new Set(Object.keys(words).filter(isMastered)),
    leaveConfirm:false, confusables:{},
  };
  $('#quiz-wrap').hidden=false;
  $('#tabbar').hidden=true;
  renderQuizQuestion();
  computeConfusables(quiz); // runs in the background; sharpens multiple-choice options for later questions once it's back
}
function currentWord(){
  if(!quiz) return null;
  const item=quiz.queue[quiz.pos];
  if(!item) return null;
  return {item, word:words[item.wordId]};
}
function pickMode(box){
  const has=m=>quiz.modes.includes(m);
  if(box<=1){
    // easy mode on a brand-new word, or right after a mistake: recognize it before recalling it
    if(has('choice')) return 'choice';
    return 'type';
  }
  // word is getting familiar: ask for real recall
  const harder=quiz.modes.filter(m=>m!=='choice');
  if(harder.length) return harder[Math.floor(Math.random()*harder.length)];
  return 'choice';
}
function buildChoices(correctText, excludeWordId, side){
  const pool = wordsForDeckIds(quiz.deckIds).filter(w=>w.id!==excludeWordId);
  const texts = Array.from(new Set(pool.map(w=> side==='a'? w.a : w.b))).filter(t=>t && normalize(t)!==normalize(correctText));
  // prefer the trickiest wrong answers first — words flagged as easily confused with
  // this one (close synonyms, or similar spelling/sound in the original language)
  const picked=[];
  const confusableIds=(quiz.confusables && quiz.confusables[excludeWordId]) || [];
  for(const cid of confusableIds){
    if(picked.length>=3) break;
    const w=words[cid];
    if(!w) continue;
    const t=side==='a'? w.a : w.b;
    if(t && normalize(t)!==normalize(correctText) && !picked.some(p=>normalize(p)===normalize(t))) picked.push(t);
  }
  const rest=shuffle(texts.filter(t=> !picked.some(p=>normalize(p)===normalize(t))));
  while(picked.length<3 && rest.length) picked.push(rest.shift());
  const opts=picked.slice(0,3);
  opts.push(correctText);
  return shuffle(opts);
}
async function computeConfusables(quizRef){
  if(!sampleFn) return;
  const pool = wordsForDeckIds(quizRef.deckIds);
  const uniq=[]; const seen=new Set();
  pool.forEach(w=>{ if(!seen.has(w.id)){ seen.add(w.id); uniq.push(w); } });
  if(uniq.length<5) return; // too few words for this to be worth asking about
  const listing = uniq.map(w=>`${w.id}: "${w.a}" = "${w.b}"`).join('\n');
  const prompt = `This is a vocabulary list a student is studying (original-language word = Dutch translation), one per line as "id: \"word\" = \"translation\"":\n${listing}\n\n`+
    `For each id, name up to 2 OTHER ids from this same list that would make the TRICKIEST multiple-choice wrong answers for it — because their Dutch translation is a close synonym or commonly confused with it (e.g. "altijd" vs "meestal"), or because the original-language word looks or sounds similar to another word in this list (e.g. similar spelling, same ending). `+
    `Only include another id when it is genuinely confusable — if nothing in the list is a good match for an id, give it an empty array. `+
    `Reply with ONLY a JSON array, one entry per id given above: [{"id":"<id>","confusables":["<id>", ...]}, ...]`;
  try{
    const data = await sampleFn.json(prompt, {cache:{gcTime:86400000}});
    const map={};
    (Array.isArray(data)?data:[]).forEach(entry=>{
      if(entry && entry.id!=null) map[String(entry.id)] = Array.isArray(entry.confusables) ? entry.confusables.map(String) : [];
    });
    if(quiz===quizRef) quiz.confusables = map;
  }catch(e){ /* best-effort enhancement only — quiz just keeps using random distractors */ }
}
function renderQuizQuestion(){
  const cur=currentWord();
  $('#quiz-leave').hidden=true;
  if(!cur){ finishQuiz(); return; }
  $('#quiz-progress-bar').style.width = Math.round(100*quiz.pos/quiz.total)+'%';
  const {item,word}=cur;
  const deck=decks[word.deckId]||{};
  const showSide = item.dir==='ab' ? 'a':'b';
  const askSide = item.dir==='ab' ? 'b':'a';
  const promptLang = item.dir==='ab' ? deck.langA : deck.langB;
  const answerLang = item.dir==='ab' ? deck.langB : deck.langA;
  const promptText = showSide==='a'? word.a : word.b;
  const answerText = askSide==='a'? word.a : word.b;
  const p=progOf(item.wordId);
  let mode = item.mode || (item.mode = pickMode(p.box));
  if(mode==='choice'){
    const pool = wordsForDeckIds(quiz.deckIds);
    const altCount = new Set(pool.map(w=> askSide==='a'? w.a:w.b)).size;
    if(altCount<4) mode='type';
  }
  const dots=Array.from({length:5}).map((_,i)=>`<span class="dot ${i<p.box?'on':''}"></span>`).join('');

  const body=$('#quiz-body');
  body.innerHTML = `
    <div class="prompt-card">
      <div class="prompt-lang">${escapeHtml(trLang(promptLang))}</div>
      <div class="prompt-word mono">${escapeHtml(promptText)}</div>
      ${word.note? `<div class="prompt-note">${escapeHtml(word.note)}</div>`:''}
      <div class="dots">${dots}</div>
    </div>
    <div id="answer-zone"></div>
    <div id="feedback-zone" aria-live="polite"></div>
  `;
  const zone=$('#answer-zone');
  if(mode==='type'){
    zone.innerHTML = `<div class="answer-type">
      <input type="text" id="type-input" placeholder="Typ het woord in het ${escapeHtml(trLang(answerLang))}" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus>
      <button class="btn btn-primary" id="type-submit">Controleer</button>
    </div>`;
    const inp=$('#type-input');
    requestAnimationFrame(()=> requestAnimationFrame(()=> inp.focus()));
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter') submitAnswer(inp.value); });
    $('#type-submit').onclick=()=>submitAnswer(inp.value);
  } else if(mode==='choice'){
    const opts = buildChoices(answerText, item.wordId, askSide);
    zone.innerHTML = `<div class="choices">${opts.map(o=>`<button class="choice-btn" data-v="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div>`;
    $$('.choice-btn').forEach(b=> b.onclick=()=> submitAnswer(b.dataset.v, b));
  }
}

// ---------- mnemonics ("ezelsbruggetjes") ----------
function mnemoZoneHtml(wordId){
  const text=mnemonics[wordId];
  return `<div class="mnemo-zone" id="mnemo-zone">
    ${text? `<div class="mnemo-hint">🌉 <b>Ezelsbruggetje:</b> ${escapeHtml(text)}</div>` : ''}
    <button class="btn btn-ghost btn-block" id="mnemo-btn" type="button">🌉 ${text?'Ezelsbruggetje bewerken':'Ezelsbruggetje toevoegen'}</button>
  </div>`;
}
function wireMnemoZone(wordId){
  const btn=$('#mnemo-btn');
  if(!btn) return;
  btn.onclick=()=>{
    const zone=$('#mnemo-zone');
    if(!zone) return;
    const current=mnemonics[wordId]||'';
    zone.innerHTML = `
      <textarea id="mnemo-text" rows="2" placeholder="Bijv. een grappige zin of associatie om dit woord te onthouden">${escapeHtml(current)}</textarea>
      <div class="mnemo-edit-actions">
        <button class="btn btn-ghost" id="mnemo-cancel" type="button">Annuleer</button>
        <button class="btn btn-primary" id="mnemo-save" type="button">Opslaan</button>
      </div>`;
    const ta=$('#mnemo-text');
    requestAnimationFrame(()=> requestAnimationFrame(()=> ta.focus()));
    $('#mnemo-cancel').onclick=()=>{
      const z=$('#mnemo-zone'); if(!z) return;
      z.outerHTML=mnemoZoneHtml(wordId); wireMnemoZone(wordId);
    };
    $('#mnemo-save').onclick=async ()=>{
      const text=ta.value.trim();
      mnemonics[wordId]=text; // optimistic
      try{ await mnemonicsCol().doc(wordId).set({text}); }catch(e){ /* best effort */ }
      const z=$('#mnemo-zone'); if(!z) return;
      z.outerHTML=mnemoZoneHtml(wordId); wireMnemoZone(wordId);
    };
  };
}

async function acceptWrongAnswer(item, typedRaw, btn){
  if(btn) btn.disabled=true;
  const wordId=item.wordId;
  const list = Array.from(new Set([...(acceptedAnswers[wordId]||[]), typedRaw]));
  acceptedAnswers[wordId]=list; // optimistic, so it's honored right away this session
  try{ await acceptedCol().doc(wordId).set({variants:list}); }catch(e){ /* best effort */ }
  if(item.requeueEntry && quiz){
    const idx=quiz.queue.indexOf(item.requeueEntry);
    if(idx>=0){ quiz.queue.splice(idx,1); quiz.total=Math.max(quiz.pos+1, quiz.total-1); }
    item.requeueEntry=null;
  }
  if(quiz){
    const prevCount=quiz.wrongWords.get(wordId)||0;
    if(prevCount<=1) quiz.wrongWords.delete(wordId); else quiz.wrongWords.set(wordId, prevCount-1);
    if(item.wasFirstAttempt) quiz.firstTryCorrect++;
  }
  await saveProgress(wordId, true, item.baseBeforeAnswer);
  const fz=$('#feedback-zone');
  if(fz){
    fz.innerHTML = `<div class="feedback good">Toch goed! "${escapeHtml(typedRaw)}" wordt vanaf nu ook geaccepteerd voor dit woord.</div>` +
      mnemoZoneHtml(wordId) +
      `<button class="btn btn-primary btn-block" id="next-btn" style="margin-top:8px">Volgende</button>`;
    $('#next-btn').onclick=advanceQuiz;
    wireMnemoZone(wordId);
  }
}

async function submitAnswer(raw, btnEl){
  if(!quiz || quiz.locked) return;
  const cur=currentWord(); if(!cur) return;
  quiz.locked=true;
  const {item,word}=cur;
  const askSide = item.dir==='ab' ? 'b':'a';
  const answerText = askSide==='a'? word.a : word.b;
  const result=checkAnswer(raw, answerText, acceptedAnswers[item.wordId]);
  const firstAttempt = !quiz.answeredIds.has(item.wordId);
  if(firstAttempt) quiz.answeredIds.add(item.wordId);
  item.wasFirstAttempt = firstAttempt;

  $$('.choice-btn').forEach(b=>{
    b.disabled=true;
    if(normalize(b.dataset.v)===normalize(answerText)) b.classList.add('correct');
    else if(b===btnEl) b.classList.add('wrong');
  });
  const fz=$('#feedback-zone');
  if(result.ok){
    if(firstAttempt) quiz.firstTryCorrect++;
    await saveProgress(item.wordId, true);
    fz.innerHTML = `<div class="feedback good">Goed!${result.close?' (kleine typefout, telt als goed)':''}</div>`;
    setTimeout(advanceQuiz, result.close?1100:650);
  } else {
    const baseBeforeAnswer=progOf(item.wordId);
    item.baseBeforeAnswer=baseBeforeAnswer;
    await saveProgress(item.wordId, false, baseBeforeAnswer);
    quiz.wrongWords.set(item.wordId, (quiz.wrongWords.get(item.wordId)||0)+1);
    // Typed/spoken answers can be right in a way the auto-checker doesn't catch
    // (a shorter but valid conjugation, a synonym she's allowed to use). Let her
    // say so herself — it fixes this question and teaches the app for next time.
    const typedRaw = (item.mode==='type') ? String(raw||'').trim() : '';
    const hasTyped = !!(typedRaw && normalize(typedRaw));
    let html = `<div class="feedback bad">Niet helemaal<div class="ans">Juiste antwoord: <strong>${escapeHtml(answerText)}</strong></div></div>`;
    html += mnemoZoneHtml(item.wordId);
    if(hasTyped){
      html += `<button class="btn btn-ghost btn-block" id="accept-btn" type="button" style="margin-top:8px">✓ "${escapeHtml(typedRaw)}" is ook goed — accepteer dit antwoord</button>`;
    }
    html += `<button class="btn btn-primary btn-block" id="next-btn" style="margin-top:8px">Volgende</button>`;
    fz.innerHTML = html;
    $('#next-btn').onclick=advanceQuiz;
    if(hasTyped){
      $('#accept-btn').onclick=(e)=> acceptWrongAnswer(item, typedRaw, e.currentTarget);
    }
    wireMnemoZone(item.wordId);
    // requeue soon, a few cards later, capped tries
    if(item.extraTries<2){
      const reinsertAt = Math.min(quiz.queue.length, quiz.pos + 1 + Math.floor(Math.random()*3)+2);
      const requeueEntry={wordId:item.wordId, dir: quiz.direction==='mix'?(Math.random()<0.5?'ab':'ba'):quiz.direction, extraTries:item.extraTries+1};
      quiz.queue.splice(reinsertAt, 0, requeueEntry);
      quiz.total++;
      item.requeueEntry=requeueEntry;
    }
  }
}
function advanceQuiz(){
  quiz.locked=false;
  quiz.pos++;
  renderQuizQuestion();
}
function ringSvg(pct){
  const r=52, c=2*Math.PI*r;
  const off = c*(1-pct/100);
  return `<svg viewBox="0 0 120 120">
    <defs><linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:var(--accent)"/>
      <stop offset="100%" style="stop-color:var(--pop)"/>
    </linearGradient></defs>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--line)" stroke-width="10"></circle>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="url(#ringGrad)" stroke-width="10"
      stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"></circle>
  </svg>`;
}
function finishQuiz(){
  const masteredAfter = Object.keys(words).filter(isMastered);
  const newlyMastered = masteredAfter.filter(id=>!quiz.masteredBefore.has(id));
  $('#quiz-wrap').hidden=true;
  $('#tabbar').hidden=false;

  const total=quiz.answeredIds.size;
  const correct=quiz.firstTryCorrect;
  const pct = total? Math.round(100*correct/total) : 0;
  let emoji='🌱', headline='Sessie klaar';
  if(total){
    if(pct===100){ emoji='🏆'; headline='Perfecte score!'; }
    else if(pct>=80){ emoji='🌟'; headline='Goed gedaan!'; }
    else if(pct>=50){ emoji='💪'; headline='Mooie vooruitgang'; }
    else { emoji='🌿'; headline='Op de goede weg'; }
  }
  $('#summary-ring').innerHTML = `<div class="ring-wrap">${ringSvg(pct)}<div class="ring-pct">${pct}%</div></div>`;
  $('#summary-stamp').innerHTML = `${emoji} ${escapeHtml(headline)}`;
  $('#sum-correct').textContent=correct;
  $('#sum-total').textContent=total;
  $('#sum-mastered').textContent=newlyMastered.length;

  const rl=$('#retry-list');
  if(quiz.wrongWords.size){
    const weakest = Array.from(quiz.wrongWords.entries())
      .sort((a,b)=> b[1]-a[1])
      .slice(0,5);
    rl.hidden=false;
    rl.innerHTML = '<h4>Woorden om te oefenen</h4>' + weakest.map(([id,count])=>{
      const w=words[id]||{};
      return `<div class="ri"><div class="w"><b>${escapeHtml(w.a||'')}</b><span>${escapeHtml(w.b||'')}</span></div><span class="miss">${count}× mis</span></div>`;
    }).join('');
  } else { rl.hidden=true; rl.innerHTML=''; }
  $('#summary-wrap').hidden=false;
  quiz=null;
}
function abandonQuiz(){
  const done=quiz? quiz.answeredIds.size : 0;
  const total=quiz? quiz.totalWords : 0;
  const left=Math.max(0, total-done);
  $('#quiz-wrap').hidden=true;
  $('#tabbar').hidden=false;
  quiz=null;
  switchView('home');
  toast(total
    ? `Gestopt — ${done} van de ${total} woord${total===1?'':'en'} gedaan (nog ${left}). Je voortgang is bewaard.`
    : 'Gestopt. Je voortgang is bewaard.');
}

// ---------- nav ----------
function switchView(name){
  if(name==='add' && !canEditCircle(activeCircleId)) name='home';
  currentView=name;
  $$('.view').forEach(v=>v.hidden=true);
  $('#view-'+name).hidden=false;
  $$('.tab').forEach(t=> t.classList.toggle('active', t.dataset.view===name));
  if(name==='home') renderHome();
  if(name==='practice') renderPracticeSetup();
  if(name==='add'){ populateLangOptions(); setAddMode('photo'); }
  if(name==='settings') renderSettings();
}

function wireStatic(){
  $$('.tab').forEach(t=> t.onclick=()=>switchView(t.dataset.view));

  $('#shot-wrap').onclick=()=> $('#shot-input-library').click();
  $('#shot-camera-btn').onclick=(e)=>{ e.stopPropagation(); $('#shot-input-camera').click(); };
  $('#shot-library-btn').onclick=(e)=>{ e.stopPropagation(); $('#shot-input-library').click(); };
  const onShotChosen=(e)=>{
    const files=Array.from(e.target.files||[]).filter(f=>f && f.type && f.type.startsWith('image/'));
    e.target.value=''; // allow picking/shooting the same file again later
    if(!files.length) return;
    let combined=shotFiles.concat(files);
    const effectiveMax = sampleImageMax ? Math.min(MAX_SHOT_PHOTOS, sampleImageMax) : MAX_SHOT_PHOTOS;
    if(combined.length>effectiveMax){
      combined=combined.slice(0, effectiveMax);
      toast(`Je kunt maximaal ${effectiveMax} foto's per lijst gebruiken`);
    }
    shotFiles=combined;
    renderShotThumbnails();
    $('#extract-btn').disabled=false;
    $('#review-panel').hidden=true; reviewRows=[];
  };
  $('#shot-input-camera').onchange=onShotChosen;
  $('#shot-input-library').onchange=onShotChosen;
  $('#extract-btn').onclick=extractFromPhoto;
  $('#add-mode-toggle').querySelectorAll('button').forEach(b=>{
    b.onclick=()=> setAddMode(b.dataset.mode);
  });
  $('#learn-lang-select').onchange=()=>{
    const isNew = $('#learn-lang-select').value==='__new__';
    $('#learn-lang-new').hidden=!isNew;
    if(isNew) requestAnimationFrame(()=> requestAnimationFrame(()=> $('#learn-lang-new').focus()));
    if(reviewRows.length) renderReviewRows();
  };
  $('#learn-lang-new').oninput=()=>{ if(reviewRows.length) renderReviewRows(); };
  $('#other-lang-input').oninput=()=>{ if(reviewRows.length) renderReviewRows(); };
  $('#add-row-btn').onclick=()=>{
    reviewRows.push({a:'',b:'',note:''}); renderReviewRows();
    const rows=$('#review-rows').querySelectorAll('[data-k=a]');
    const last=rows[rows.length-1];
    if(last) requestAnimationFrame(()=> requestAnimationFrame(()=> last.focus()));
  };
  $('#save-deck-btn').onclick=saveDeckDispatch;
  $('#save-deck-split-btn').onclick=saveDeckSplit;

  $('#deck-select-toggle').onclick=()=>{
    const boxes=Array.from($('#practice-deck-list').querySelectorAll('input[data-id]'));
    const allOn=boxes.length && boxes.every(cb=>cb.checked);
    boxes.forEach(cb=>{
      cb.checked=!allOn; practiceDeckSelection[cb.dataset.id]=!allOn;
      cb.closest('.check').classList.toggle('on', !allOn);
    });
    updateMaintainVisibility(); updateDirectionHint();
  };
  $('#include-maintain').onchange=(e)=>{
    $('#maintain-check-wrap').classList.toggle('on', e.target.checked);
    updateDirectionHint();
  };
  $('#practice-direction').querySelectorAll('button').forEach(b=>{
    b.onclick=()=>{ $('#practice-direction').querySelectorAll('button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); updateDirectionHint(); };
  });
  ['mode-type','mode-choice'].forEach(id=>{
    $('#'+id).onchange=(e)=> $('#'+id+'-wrap').classList.toggle('on', e.target.checked);
  });

  $('#circle-select').onchange=()=>{
    activeCircleId=$('#circle-select').value;
    persistActiveCircle();
    applyActiveCircleUI();
    subscribeCircleScoped();
    if(currentView==='add') switchView('home');
  };
  $('#new-circle-btn').onclick=async ()=>{
    const name=$('#new-circle-name').value.trim();
    const mod=$('#new-circle-moderator').value.trim().toLowerCase();
    if(!name || !mod){ $('#admin-circles-status').textContent='Vul een naam en moderator-e-mail in.'; return; }
    $('#new-circle-btn').disabled=true;
    $('#admin-circles-status').textContent='Bezig…';
    try{
      const ref=await db.collection('circles').add({name, moderatorEmail:mod, createdAt:iso()});
      circles[ref.id]={name, moderatorEmail:mod};
      myCircles.push({id:ref.id, name});
      activeCircleId=ref.id;
      persistActiveCircle();
      $('#new-circle-name').value=''; $('#new-circle-moderator').value='';
      $('#admin-circles-status').textContent=`Cirkel "${name}" aangemaakt en actief.`;
      applyActiveCircleUI();
      subscribeCircleScoped();
    }catch(e){
      $('#admin-circles-status').textContent='Aanmaken mislukt — probeer het opnieuw.';
    }finally{
      $('#new-circle-btn').disabled=false;
    }
  };
  $('#migrate-legacy-btn').onclick=async ()=>{
    if(!activeCircleId){ $('#migrate-legacy-status').textContent='Kies of maak eerst een cirkel.'; return; }
    $('#migrate-legacy-btn').disabled=true;
    $('#migrate-legacy-status').textContent='Bezig…';
    try{
      const decksSnap=await db.collection('decks').get();
      let n=0;
      for(const d of decksSnap.docs){
        if(!d.data().circleId){ await db.doc('decks/'+d.id).update({circleId:activeCircleId}); n++; }
      }
      const wordsSnap=await db.collection('words').get();
      let wn=0;
      for(const w of wordsSnap.docs){
        if(!w.data().circleId){ await db.doc('words/'+w.id).update({circleId:activeCircleId}); wn++; }
      }
      $('#migrate-legacy-status').textContent = (n||wn) ? `Klaar — ${n} lijst${n===1?'':'en'} en ${wn} woord${wn===1?'':'en'} toegewezen.` : 'Niets om toe te wijzen — alles heeft al een cirkel.';
      subscribeCircleScoped();
    }catch(e){
      $('#migrate-legacy-status').textContent='Mislukt — probeer het opnieuw.';
    }finally{
      $('#migrate-legacy-btn').disabled=false;
    }
  };

  $('#settings-subject').onchange=()=>{
    populateSettingsDecks();
    $('#settings-reset-confirm').hidden=true; $('#settings-reset-status').textContent='';
  };
  $('#settings-deck').onchange=()=>{ $('#settings-reset-confirm').hidden=true; $('#settings-reset-status').textContent=''; };
  $('#settings-reset-btn').onclick=()=>{
    const n=settingsScopeWordIds().length;
    $('#settings-reset-msg').textContent = `Weet je zeker dat je de voortgang van ${n} woord${n===1?'':'en'} in ${settingsScopeLabel()} wilt resetten? Dit kan niet ongedaan worden gemaakt.`;
    $('#settings-reset-confirm').hidden=false;
    $('#settings-reset-status').textContent='';
  };
  $('#settings-reset-cancel').onclick=()=>{ $('#settings-reset-confirm').hidden=true; };
  $('#settings-reset-confirm-btn').onclick=performProgressReset;

  $('#export-subject').onchange=()=>{ populateExportDeckOptions(); $('#export-status').textContent=''; };
  $('#export-deck').onchange=()=>{ $('#export-status').textContent=''; };
  $('#export-btn').onclick=exportSelectedScope;
  $('#import-choose-btn').onclick=()=>$('#import-file-input').click();
  $('#import-file-input').onchange=(e)=>{
    const f=(e.target.files||[])[0];
    if(f) handleImportFile(f);
  };
  $('#import-confirm-btn').onclick=confirmImport;
  $('#start-btn').onclick=startQuiz;

  $('#quiz-close').onclick=()=>{
    if(quiz){
      const done=quiz.answeredIds.size, total=quiz.totalWords, left=Math.max(0,total-done);
      $('#quiz-leave-msg').textContent = total
        ? `Stoppen met oefenen? Je hebt ${done} van de ${total} woord${total===1?'':'en'} gedaan (nog ${left}). Je voortgang blijft bewaard.`
        : 'Stoppen met oefenen? Je voortgang blijft bewaard.';
    }
    $('#quiz-leave').hidden=false;
  };
  $('#quiz-leave-cancel').onclick=()=>{ $('#quiz-leave').hidden=true; };
  $('#quiz-leave-confirm').onclick=abandonQuiz;

  $('#summary-home').onclick=()=>{ $('#summary-wrap').hidden=true; switchView('home'); };
  $('#summary-again').onclick=()=>{ $('#summary-wrap').hidden=true; switchView('practice'); };

  $('#edit-deck-close').onclick=closeEditDeck;
  $('#edit-deck-group-select').onchange=()=>{
    const isNew = $('#edit-deck-group-select').value==='__new__';
    $('#edit-deck-group-new').hidden=!isNew;
    if(isNew) requestAnimationFrame(()=> requestAnimationFrame(()=> $('#edit-deck-group-new').focus()));
  };
  $('#edit-deck-add-row-btn').onclick=()=>{
    editRows.push({id:null, a:'', b:'', note:''});
    renderEditRows();
    const inputs=$('#edit-deck-rows').querySelectorAll('[data-k=a]');
    const last=inputs[inputs.length-1];
    if(last) requestAnimationFrame(()=> requestAnimationFrame(()=> last.focus()));
  };
  $('#edit-deck-save-btn').onclick=saveEditDeck;
}

// ---------- db subscriptions ----------
// Decks/words are scoped to the active circle (re-subscribed whenever the
// person switches circles); progress/accepted/mnemonics are private to this
// account and only need subscribing once per sign-in.
function subscribeCircleScoped(){
  if(unsubDecks){ unsubDecks(); unsubDecks=null; }
  if(unsubWords){ unsubWords(); unsubWords=null; }
  decks={}; words={};
  if(!activeCircleId){
    if(currentView==='home') renderHome();
    if(currentView==='practice') renderPracticeSetup();
    return;
  }
  unsubDecks = db.collection('decks').where('circleId','==',activeCircleId).onSnapshot(snap=>{
    decks={}; snap.docs.forEach(d=> decks[d.id]=d.data());
    if(currentView==='home') renderHome();
    if(currentView==='practice') renderPracticeSetup();
  }, ()=>{});
  unsubWords = db.collection('words').where('circleId','==',activeCircleId).onSnapshot(snap=>{
    words={}; snap.docs.forEach(d=> words[d.id]=d.data());
    if(currentView==='home') renderHome();
    if(currentView==='practice') renderPracticeSetup();
  }, ()=>{});
}
function subscribeUserPrivateData(){
  progressCol().onSnapshot(snap=>{
    progress={}; snap.docs.forEach(d=> progress[d.id]=d.data());
    if(currentView==='home') renderHome();
  }, ()=>{});
  acceptedCol().onSnapshot(snap=>{
    acceptedAnswers={}; snap.docs.forEach(d=> acceptedAnswers[d.id]=(d.data()||{}).variants||[]);
  }, ()=>{});
  mnemonicsCol().onSnapshot(snap=>{
    mnemonics={}; snap.docs.forEach(d=> mnemonics[d.id]=(d.data()||{}).text||'');
  }, ()=>{});
}

// ---------- sign-in / boot ----------
// Replaces the Claude Artifact capabilities (db/sample/downloads/user) with the
// real Firebase + API shims from firebase-init.js. Everything ABOVE this point
// in the file is unchanged from the original app — it still just calls
// db.doc()/db.collection()/sampleFn.json()/downloadsCap.save(), exactly as before.
function showSignedOut(){
  $('#nodb').hidden=false;
  $('#main').hidden=true; $('#tabbar').hidden=true;
}

// ---------- circles: load / join / UI ----------
// Admin sees every circle (needed to manage them); everyone else only sees
// the circles listed in their own private profile doc (written when they
// join via an invite link).
async function loadMyCircles(){
  circles={}; myCircles=[];
  if(isAdmin){
    const snap=await db.collection('circles').get();
    snap.docs.forEach(d=> circles[d.id]=d.data());
    myCircles=Object.keys(circles).map(id=>({id, name:(circles[id]||{}).name||'Naamloze cirkel'}));
  } else {
    const profSnap=await db.doc('data/users/'+uid+'/profile').get();
    const ids=(profSnap.exists() && profSnap.data().circles) || [];
    for(const id of ids){
      try{
        const cSnap=await db.doc('circles/'+id).get();
        if(cSnap.exists()) circles[id]=cSnap.data();
      }catch(e){ /* a circle that got deleted, or no longer readable — skip it */ }
    }
    myCircles=ids.filter(id=>circles[id]).map(id=>({id, name:(circles[id]||{}).name||'Naamloze cirkel'}));
  }
}
function pickActiveCircle(){
  let saved=null;
  try{ saved=localStorage.getItem(circleStorageKey()); }catch(e){}
  if(saved && circles[saved]) return saved;
  return myCircles[0] ? myCircles[0].id : null;
}
// If the URL is an invite link (#join-<circleId>), offer to join that circle.
async function maybeHandleJoinLink(){
  const m=location.hash.match(/^#join-(.+)$/);
  if(!m) return;
  const circleId=m[1];
  history.replaceState(null, '', location.pathname+location.search);
  if(circles[circleId]){ activeCircleId=circleId; persistActiveCircle(); return; } // already a member
  try{
    const cSnap=await db.doc('circles/'+circleId).get();
    if(!cSnap.exists()){ toast('Deze uitnodigingslink is niet (meer) geldig'); return; }
    const name=(cSnap.data()||{}).name || 'deze cirkel';
    if(!confirm('Wil je lid worden van de cirkel "'+name+'"?')) return;
    await db.doc('circles/'+circleId).collection('members').doc(uid).set({email:myEmail, joinedAt:iso()});
    const profRef=db.doc('data/users/'+uid+'/profile');
    const profSnap=await profRef.get();
    const existingIds=(profSnap.exists() && profSnap.data().circles) || [];
    if(!existingIds.includes(circleId)){
      await profRef.set({circles:existingIds.concat([circleId])}, {merge:true});
    }
    circles[circleId]=cSnap.data();
    myCircles.push({id:circleId, name});
    activeCircleId=circleId;
    persistActiveCircle();
    toast('Je bent lid geworden van "'+name+'"');
  }catch(e){
    toast('Lid worden mislukt — probeer het opnieuw');
  }
}
function applyActiveCircleUI(){
  document.body.classList.toggle('can-edit-circle', canEditCircle(activeCircleId));
  const sel=$('#circle-select'), field=$('#circle-switch-field'), single=$('#circle-single-label');
  if(myCircles.length>1){
    field.hidden=false; single.hidden=true;
    sel.innerHTML=myCircles.map(c=>`<option value="${c.id}" ${c.id===activeCircleId?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
  } else if(myCircles.length===1){
    field.hidden=true; single.hidden=false;
    single.textContent='Cirkel: '+myCircles[0].name;
  } else {
    field.hidden=true; single.hidden=false;
    single.textContent=isAdmin ? 'Nog geen cirkels — maak er hieronder een aan.' : 'Je bent nog geen lid van een cirkel. Vraag iemand om een uitnodigingslink.';
  }
  renderAdminCirclesList();
}
function renderAdminCirclesList(){
  const panel=$('#admin-circles-panel');
  panel.hidden=!isAdmin;
  if(!isAdmin) return;
  const list=$('#admin-circles-list');
  const ids=Object.keys(circles);
  if(!ids.length){
    list.innerHTML='<p class="muted" style="font-size:.85rem; margin:0">Nog geen cirkels.</p>';
    return;
  }
  list.innerHTML=ids.map(id=>{
    const c=circles[id]||{};
    return `<div class="panel" style="padding:10px 12px; margin:0">
      <div style="display:flex; justify-content:space-between; gap:8px; align-items:baseline">
        <b>${escapeHtml(c.name||'Naamloze cirkel')}</b>
        <button type="button" class="btn btn-ghost btn-sm circle-copy-link" data-id="${id}">🔗 Link</button>
      </div>
      <p class="muted" style="font-size:.8rem; margin:4px 0 0">Moderator: ${escapeHtml(c.moderatorEmail||'—')} <button type="button" class="circle-edit-mod" data-id="${id}" style="background:none; border:none; color:var(--accent); font-size:.8rem; cursor:pointer; padding:0; margin-left:4px">wijzigen</button></p>
    </div>`;
  }).join('');
  list.querySelectorAll('.circle-copy-link').forEach(btn=>{
    btn.onclick=async ()=>{
      const link=location.origin+location.pathname+'#join-'+btn.dataset.id;
      try{ await navigator.clipboard.writeText(link); toast('Uitnodigingslink gekopieerd'); }
      catch(e){ prompt('Kopieer deze link handmatig:', link); }
    };
  });
  list.querySelectorAll('.circle-edit-mod').forEach(btn=>{
    btn.onclick=async ()=>{
      const id=btn.dataset.id;
      const current=(circles[id]||{}).moderatorEmail||'';
      const next=prompt('E-mail van de moderator voor "'+((circles[id]||{}).name||'')+'":', current);
      if(next===null) return;
      const email=next.trim().toLowerCase();
      if(!email) return;
      try{
        await db.doc('circles/'+id).update({moderatorEmail:email});
        circles[id]={...(circles[id]||{}), moderatorEmail:email};
        applyActiveCircleUI();
        toast('Moderator bijgewerkt');
      }catch(e){ toast('Bijwerken mislukt — probeer het opnieuw'); }
    };
  });
}

async function startAppForUser(user){
  uid = user.uid;
  myEmail = (user.email||'').toLowerCase();
  isAdmin = myEmail === ADMIN_EMAIL;
  db = shims.db;
  sampleFn = shims.sample;
  downloadsCap = shims.downloads;
  sampleFn.limits().then(l=>{ sampleImageMax = (l && l.images && l.images.maxCount) || null; }).catch(()=>{});
  $('#nodb').hidden=true;
  $('#main').hidden=false; $('#tabbar').hidden=false;
  wireStatic();
  resetAddForm();
  await loadMyCircles();
  await maybeHandleJoinLink();
  if(!activeCircleId) activeCircleId=pickActiveCircle();
  persistActiveCircle();
  applyActiveCircleUI();
  subscribeCircleScoped();
  subscribeUserPrivateData();
  switchView('home');
}
function boot(){
  const btn=$('#google-signin-btn');
  if(btn) btn.onclick=()=>{
    btn.disabled=true;
    shims.signIn().catch(()=> toast('Inloggen mislukt — probeer het opnieuw')).finally(()=> btn.disabled=false);
  };
  const outBtn=$('#signout-btn');
  if(outBtn) outBtn.onclick=()=> shims.signOut();
  shims.onAuthChange((user)=>{
    if(user) startAppForUser(user);
    else showSignedOut();
  });
}

boot();
