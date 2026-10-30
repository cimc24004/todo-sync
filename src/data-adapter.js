'use strict';
/* オフライン操作を先に永続化。未送信操作はDriveで確認するまで削除しない。 */
(()=>{
 const key='michi-todo-operations-v1';let data=null,token='',syncing=false,accountReady=false,lockPromise=null,connectPromise=null,authGeneration=0,expiryTimer=null,lastSync=0,syncError='';
 const emit=()=>window.dispatchEvent(new CustomEvent('michi-sync-state',{detail:{pending:data?.pending.length||0,syncing,connected:accountReady,lastSync,error:syncError}}));
 async function save(next){if(window.todo) {const r=await window.todo.request('cache-save',next);if(!r.ok)throw Error(r.error);}else localStorage.setItem(key,JSON.stringify(next));data=next;emit();}
 async function load(){if(data)return;if(!window.todo){if(!lockPromise)lockPromise=new Promise((resolve,reject)=>{if(!navigator.locks)return reject(Error('このブラウザでは安全な保存ロックが使えません。最新のChrome等で開いてください。'));navigator.locks.request('michi-todo-single-tab',{ifAvailable:true},lock=>{if(!lock){reject(Error('このアプリは別のタブで開いています。そちらを閉じて再読み込みしてください。'));return;}resolve();return new Promise(()=>{});}).catch(reject);});await lockPromise;}let raw;if(window.todo){const r=await window.todo.request('cache-load');if(!r.ok)throw Error(r.error);raw=r.data;}else raw=JSON.parse(localStorage.getItem(key)||'null');if(raw){window.MichiSync.merge(raw.ops);if(!Array.isArray(raw.pending)||raw.pending.some(id=>typeof id!=='string'||!raw.ops.some(o=>o.id===id))||typeof raw.device!=='string')throw Error('保存データが不正です。上書きせず停止しました。');data=raw;}else await save({device:crypto.randomUUID(),ops:[],pending:[]});}
 const drive=new window.MichiDrive(async()=>token);
 async function sync(){if(syncing)return;await load();if(!token||!accountReady)throw Error('Google Driveに接続してください。');syncing=true;syncError='';emit();try{const files=await drive.list();const known=new Set(data.knownFiles||[]);const newFiles=files.filter(f=>!known.has(f.id));const downloaded=await drive.pull(newFiles);const remote=window.MichiSync.merge(data.ops.filter(o=>!data.pending.includes(o.id)),downloaded);const remoteIds=new Set(remote.map(o=>o.id));await save({...data,ops:window.MichiSync.merge(data.ops,remote),knownFiles:[...new Set([...(data.knownFiles||[]),...files.map(f=>f.id)])],pending:data.pending.filter(id=>!remoteIds.has(id))});for(const id of [...data.pending]){const op=data.ops.find(o=>o.id===id);await drive.push(op);await save({...data,pending:data.pending.filter(x=>x!==id)});}lastSync=Date.now();window.dispatchEvent(new Event('michi-data-changed'));}catch(e){syncError=e.message;throw e;}finally{syncing=false;emit();}}
 async function connectFlow(){
  const generation=++authGeneration;let account,candidateToken,candidateExpiry;accountReady=false;lastSync=0;syncError='';token='';clearTimeout(expiryTimer);emit();
  const assertCurrent=()=>{if(generation!==authGeneration)throw Error('ログインをキャンセルしました。');};
  if(window.todo){
   if(!window.todo.driveAuth)throw Error('PC版ログインは未設定です。');
   const result=await window.todo.driveAuth('connect');assertCurrent();if(!result.ok)throw Error(result.error);
   account=result.data.account||result.data.identity;candidateToken='electron-session';candidateExpiry=result.data.expiresAt;
  }else{
   const id=window.MICHI_CONFIG.googleWebClientId;if(!id)throw Error('Google OAuthクライアントIDが未設定です。設定後にDrive同期を利用できます。');
   if(!window.google?.accounts?.oauth2){await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.onload=resolve;script.onerror=()=>reject(Error('Googleログインを読み込めませんでした。'));document.head.append(script);});}assertCurrent();
   const result=await new Promise((resolve,reject)=>{const client=google.accounts.oauth2.initTokenClient({client_id:id,scope:'https://www.googleapis.com/auth/drive.appdata openid email',callback:r=>r.error?reject(Error(r.error)):resolve(r),error_callback:e=>reject(Error(e.type||'ログインを完了できませんでした。'))});client.requestAccessToken({prompt:''});});assertCurrent();
   if(!result.access_token||!Number.isFinite(Number(result.expires_in)))throw Error('ログイン結果を確認できませんでした。');
   candidateToken=result.access_token;candidateExpiry=Date.now()+Number(result.expires_in)*1000;
   account=await(await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${candidateToken}`}})).json();assertCurrent();
  }
  if(!account?.sub)throw Error('Googleアカウントを確認できませんでした。');await load();assertCurrent();
  if(data.account&&data.account!==account.sub){if(window.todo?.driveAuth)await window.todo.driveAuth('disconnect');throw Error('この端末の保存先とは別のGoogleアカウントです。元のアカウントで接続してください。');}
  if(!data.account){if(!window.confirm(`この端末のタスクを ${account.email||'選択したGoogleアカウント'} のアプリ専用領域へ同期します。続けますか？`)){if(window.todo?.driveAuth)await window.todo.driveAuth('disconnect');return;}await save({...data,account:account.sub});assertCurrent();}
  token=candidateToken;accountReady=true;emit();if(candidateExpiry)expiryTimer=setTimeout(()=>{if(generation===authGeneration){token='';accountReady=false;emit();}},Math.max(0,candidateExpiry-Date.now()-60000));await sync();
 }
 function connect(){if(connectPromise)return connectPromise;connectPromise=connectFlow().finally(()=>{connectPromise=null;});return connectPromise;}

 window.todoClient={mode:'offline',connect,sync,disconnect(){authGeneration++;clearTimeout(expiryTimer);token='';accountReady=false;if(window.todo?.driveAuth)window.todo.driveAuth('disconnect');emit();},async request(action,payload={}){try{await load();if(action!=='list'){if(syncing)throw Error('同期中です。少し待ってからもう一度お試しください。');const tasks=window.MichiSync.materialize(data.ops),task=tasks.find(t=>t.id===payload.id);let id=payload.id,patch;
 if(action==='add'){id=crypto.randomUUID();patch={title:payload.title.trim(),notes:payload.notes||'',due:payload.due||'',priority:payload.priority,done:false,deletedAt:null,createdAt:new Date().toISOString()};}
 else{if(!task)throw Error('タスクが見つかりません。');if(action==='edit'){patch={};for(const k of ['title','notes','due','priority']){const v=k==='title'?payload[k].trim():payload[k];if(task[k]!==v)patch[k]=v;}}else if(action==='toggle')patch={done:!task.done};else if(action==='trash')patch={deletedAt:new Date().toISOString()};else if(action==='restore')patch={deletedAt:null};else throw Error('操作が不正です。');}
 const op=window.MichiSync.create(data.ops,data.device,id,patch,crypto.randomUUID());await save({...data,ops:window.MichiSync.merge(data.ops,[op]),pending:[...data.pending,op.id]});}
 if(action!=='list'&&accountReady&&!syncing)setTimeout(()=>sync().catch(e=>window.dispatchEvent(new CustomEvent('michi-sync-error',{detail:e.message}))),0);return{ok:true,data:{tasks:window.MichiSync.materialize(data.ops),warning:''}};}catch(e){return{ok:false,error:e.message};}}};
window.addEventListener('focus',()=>{if(accountReady&&!syncing)sync().catch(e=>window.dispatchEvent(new CustomEvent('michi-sync-error',{detail:e.message})));});setInterval(()=>{if(accountReady&&!syncing)sync().catch(e=>window.dispatchEvent(new CustomEvent('michi-sync-error',{detail:e.message})));},60000);
})();
