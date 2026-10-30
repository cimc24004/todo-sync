'use strict';
const $=s=>document.querySelector(s);let tasks=[],filter='all',editing=null,busy=false;
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const titles={all:'すべてのタスク',today:'今日のタスク',upcoming:'これからのタスク',completed:'完了したタスク',trash:'ごみ箱'};
const soundKey='michi-feedback-sound-v1';
let soundEnabled=true;try{soundEnabled=localStorage.getItem(soundKey)!=='off';}catch{}
const sounds={};
function playSound(name){
 if(!soundEnabled)return;
 try{
  let clip=sounds[name];
  if(!clip){clip=new Audio(`assets/sounds/${name}.ogg`);if(!clip.canPlayType('audio/ogg; codecs="vorbis"'))return;clip.volume=name==='complete'?.24:.18;clip.preload='auto';sounds[name]=clip;}
  clip.pause();clip.currentTime=0;const playing=clip.play();if(playing?.catch)playing.catch(()=>{});
 }catch{} // Unsupported or blocked audio must never interrupt a task action.
}
function updateSoundButton(){const b=$('#sound-toggle');b.textContent=soundEnabled?'♪ 操作音オン':'♪ 操作音オフ';b.setAttribute('aria-pressed',String(soundEnabled));const label=soundEnabled?'操作音をオフにする':'操作音をオンにする';b.setAttribute('aria-label',label);b.title=label;}
$('#sound-toggle').onclick=()=>{soundEnabled=!soundEnabled;try{localStorage.setItem(soundKey,soundEnabled?'on':'off');}catch{}if(!soundEnabled)Object.values(sounds).forEach(clip=>clip.pause());updateSoundButton();if(soundEnabled)playSound('click');};
updateSoundButton();
function animate(element,name){if(!element||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;element.classList.remove(name);void element.offsetWidth;element.classList.add(name);element.addEventListener('animationend',()=>element.classList.remove(name),{once:true});}
function animateTask(id){const row=Array.from(document.querySelectorAll('.task')).find(item=>item.dataset.taskId===id);animate(row,'task-enter');}
function matches(t,f){if(f==='trash')return !!t.deletedAt;if(t.deletedAt)return false;if(f==='completed')return t.done;if(t.done)return false;if(f==='today')return t.due&&t.due<=today();if(f==='upcoming')return t.due>today();return true;}
async function request(action,payload){const result=await window.todoClient.request(action,payload);if(!result.ok)throw Error(result.error);tasks=result.data.tasks;$('#warning').hidden=!result.data.warning;$('#warning').textContent=result.data.warning;render();}
function toast(text,complete=false){$('#toast').textContent=text;$('#toast').classList.toggle('completion-toast',complete);$('#toast').hidden=false;animate($('#toast'),'toast-enter');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,3500);}
function button(text,cls,handler,label){const b=document.createElement('button');b.textContent=text;b.className=cls;b.type='button';if(label)b.setAttribute('aria-label',label);b.onclick=handler;return b;}
async function change(action,id){if(busy)return;busy=true;const completing=action==='toggle'&&!tasks.find(t=>t.id===id)?.done;try{await request(action,{id});if(completing){playSound('complete');animate($('#done-count'),'count-bump');toast('✓ ひとつ完了。いい調子！',true);}else{playSound('click');if(action==='restore'||action==='toggle')animateTask(id);}if(action==='trash')toast('ごみ箱に移動しました。いつでも復元できます。');}catch(e){toast(e.message);}finally{busy=false;}}
function render(){
 $('#date').textContent=new Intl.DateTimeFormat('ja-JP',{month:'long',day:'numeric',weekday:'long'}).format(new Date());$('#heading').textContent=titles[filter];
 const live=tasks.filter(t=>!t.deletedAt);$('#remaining').textContent=live.filter(t=>!t.done).length;$('#today-count').textContent=live.filter(t=>!t.done&&t.due===today()).length;$('#done-count').textContent=live.filter(t=>t.done).length;
 document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('active',b.dataset.filter===filter);b.setAttribute('aria-current',b.dataset.filter===filter?'page':'false');b.querySelector('b').textContent=tasks.filter(t=>matches(t,b.dataset.filter)).length;});
 let shown=tasks.filter(t=>matches(t,filter)&&`${t.title}\n${t.notes}`.toLocaleLowerCase().includes($('#search').value.toLocaleLowerCase()));
 const rank={high:0,normal:1,low:2};shown.sort((a,b)=>$('#sort').value==='new'?b.createdAt.localeCompare(a.createdAt):$('#sort').value==='priority'?rank[a.priority]-rank[b.priority]||a.createdAt.localeCompare(b.createdAt):(a.due||'9999').localeCompare(b.due||'9999')||rank[a.priority]-rank[b.priority]);
 $('#subtitle').textContent=filter==='today'?'期限を過ぎたタスクも、ここで確認できます。':filter==='trash'?'削除したタスクは、ここから復元できます。':`${shown.length}件のタスク。自分のペースで進めよう。`;
 $('#list').replaceChildren();$('#empty').hidden=shown.length>0;$('#empty-text').textContent=$('#search').value?'条件に合うタスクはありません。':filter==='completed'?'完了したタスクがここに並びます。':'やることを追加して、今日の一歩を始めよう。';
 for(const t of shown){const row=document.createElement('article');row.className='task'+(t.done?' done':'');row.dataset.taskId=t.id;
 if(!t.deletedAt)row.append(button(t.done?'✓':'','check',()=>change('toggle',t.id),t.done?'未完了に戻す':'完了にする'));
 const info=document.createElement('div');info.className='task-info';const title=document.createElement('h3');title.textContent=t.title;info.append(title);
 if(t.notes){const n=document.createElement('p');n.className='notes';n.textContent=t.notes;info.append(n);}
 const meta=document.createElement('div');meta.className='meta';const p=document.createElement('span');p.className='priority '+t.priority;p.textContent={high:'● 優先度 高',normal:'● ふつう',low:'● 優先度 低'}[t.priority];meta.append(p);
 if(t.due){const d=document.createElement('span');const late=!t.done&&t.due<today();d.className=late?'overdue':'';d.textContent=`▦ ${t.due.replaceAll('-','/')} ${late?'期限超過':t.due===today()?'今日':''}`;meta.append(d);}info.append(meta);row.append(info);
 const actions=document.createElement('div');actions.className='actions';if(t.deletedAt)actions.append(button('復元','restore',()=>change('restore',t.id)));else{actions.append(button('編集','edit',()=>openEditor(t)));actions.append(button('×','icon',()=>change('trash',t.id),'ごみ箱へ移動'));}row.append(actions);$('#list').append(row);}
}
function openEditor(task){playSound('click');editing=task?.id||null;$('#form').reset();$('#form-error').textContent='';$('#modal-title').textContent=task?'タスクを編集':'新しいタスク';for(const key of ['title','due','notes','priority'])$('#form').elements[key].value=task?.[key]??(key==='priority'?'normal':'');$('#editor').showModal();animate($('#editor'),'editor-enter');$('#form').elements.title.focus();}
$('#new').onclick=()=>openEditor();$('#close').onclick=$('#cancel').onclick=()=>{if(!busy)$('#editor').close();};$('#editor').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
$('#form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;$('#save').disabled=true;const previousIds=new Set(tasks.map(t=>t.id));try{await request(editing?'edit':'add',{id:editing,...Object.fromEntries(new FormData($('#form')))});$('#editor').close();playSound('click');animateTask(editing||tasks.find(t=>!previousIds.has(t.id))?.id);toast(editing?'変更を保存しました。':'タスクを追加しました。まずは一歩。');}catch(err){$('#form-error').textContent=err.message;}finally{busy=false;$('#save').disabled=false;}};
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;render();});$('#search').oninput=render;$('#sort').onchange=render;
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='n'){e.preventDefault();if(!$('#editor').open)openEditor();}});
const localMode=true;
$('#connection-title').textContent=localMode?'この端末に保存':'オンライン同期：未設定';
$('#connection-detail').textContent=localMode?'Driveのアプリ専用領域へ同期できます。':'接続先の設定後に利用できます。';
request('list').catch(e=>{render();$('#warning').hidden=false;$('#warning').textContent=e.message;$('#empty').hidden=true;$('#new').disabled=true;});setInterval(render,60000);

$('#connect').onclick=async()=>{$('#connect').disabled=true;try{await window.todoClient.connect();await request('list');}catch(e){toast(e.message);}finally{$('#connect').disabled=false;}};$('#sync').onclick=async()=>{try{await window.todoClient.sync();await request('list');}catch(e){toast(e.message);}};$('#disconnect').onclick=()=>window.todoClient.disconnect();window.addEventListener('michi-data-changed',()=>request('list').catch(e=>toast(e.message)));window.addEventListener('michi-sync-error',e=>toast(e.detail));window.addEventListener('michi-sync-state',e=>{const s=e.detail;$('#sync-status').textContent=s.syncing?'同期中…':s.connected?(s.error?'同期できませんでした':s.pending?`未同期 ${s.pending} 件`:s.lastSync?'Driveと同期済み':'接続済み・同期未確認'):`端末に保存・未同期 ${s.pending} 件`;$('#sync').hidden=!s.connected;$('#disconnect').hidden=!s.connected;$('#connect').hidden=s.connected;$('#sync').disabled=s.syncing;});window.addEventListener('michi-quick-add',()=>{if(!$('#editor').open)openEditor();});if(location.hash==='#today'){filter='today';render();}

window.addEventListener('michi-today',()=>{filter='today';render();});if(window.todo?.desktop){$('#desktop-controls').hidden=false;$('#desktop-settings').onclick=()=>window.todo.desktop('settings');$('#desktop-compact').onclick=()=>window.todo.desktop('compact');}if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
