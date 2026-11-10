'use strict';
/* 同期単位は不変の操作JSON。複数端末による同一ファイル上書きを避ける。 */
window.MichiNetwork=(()=>{
 const timeoutError=()=>Object.assign(Error('Googleとの通信がタイムアウトしました。通信環境を確認して、もう一度同期してください。ローカルの変更は保持しています。'),{code:'NETWORK_TIMEOUT'});
 const cancelledError=()=>Object.assign(Error('Google接続をキャンセルしました。'),{code:'NETWORK_CANCELLED'});
 async function run(operation,timeoutMs=30000,externalSignal){
  let timer,detach=()=>{};
  const timeoutSignal=typeof AbortSignal.timeout==='function'?AbortSignal.timeout(timeoutMs):(()=>{const controller=new AbortController();timer=setTimeout(()=>controller.abort(),timeoutMs);return controller.signal;})();
  let signal=timeoutSignal;
  if(externalSignal){
   if(typeof AbortSignal.any==='function')signal=AbortSignal.any([timeoutSignal,externalSignal]);
   else{const controller=new AbortController();const abort=()=>controller.abort();for(const source of [timeoutSignal,externalSignal])source.addEventListener('abort',abort,{once:true});detach=()=>{for(const source of [timeoutSignal,externalSignal])source.removeEventListener('abort',abort);};if(timeoutSignal.aborted||externalSignal.aborted)abort();signal=controller.signal;}
  }
  const error=()=>timeoutSignal.aborted?timeoutError():cancelledError();let abort;
  const cancelled=new Promise((_,reject)=>{abort=()=>reject(error());if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([cancelled,Promise.resolve().then(()=>{if(signal.aborted)throw error();return operation(signal);})]);}
  finally{signal.removeEventListener('abort',abort);clearTimeout(timer);detach();}
 }
 // The deadline includes the response body, not just the arrival of headers.
 function fetchResponse(url,options={},timeoutMs=30000){return run(async signal=>{const response=await fetch(url,{...options,signal});const text=await response.text();return new Response([204,205,304].includes(response.status)?null:text,{status:response.status,headers:response.headers});},timeoutMs,options.signal);}
 return Object.freeze({run,fetch:fetchResponse});
})();
// Logout runs after pending responses (or their abort) so a refreshed cookie cannot arrive after it.
window.MichiServerAuth=(()=>{
 const pending=new Set();let disconnecting=null;
 const optionsFor=options=>({...options,credentials:'same-origin',cache:'no-store',redirect:'error'});
 function request(action,options={}){
  if(!['session','drive'].includes(action))return Promise.reject(Error('Google接続の操作が不正です。'));
  if(disconnecting)return Promise.reject(Error('Google接続を解除しています。'));
  const promise=window.MichiNetwork.fetch('/api/google?action='+action,optionsFor(options),45000);
  pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;
 }
 function disconnect(){
  if(disconnecting)return disconnecting;
  const inFlight=[...pending];
  const promise=(async()=>{await Promise.allSettled(inFlight);return window.MichiNetwork.fetch('/api/google?action=disconnect',optionsFor({method:'POST',headers:{'Content-Type':'application/json','X-Michi-Request':'1'},body:'{}'}),45000);})().finally(()=>{if(disconnecting===promise)disconnecting=null;});
  disconnecting=promise;return promise;
 }
 return Object.freeze({request,disconnect});
})();
window.MichiDrive = class {
 constructor(getToken,getAccount=()=>null,getSignal=()=>null){this.getToken=getToken;this.getAccount=getAccount;this.getSignal=getSignal;}
 async fetch(url,options={}){
  const signal=this.getSignal();
  if(window.todo?.driveRequest){const account=this.getAccount();if(typeof account!=='string'||!account||account.length>255)throw Error('同期先のGoogleアカウントを確認できませんでした。再接続してください。');const response=await window.MichiNetwork.run(()=>window.todo.driveRequest({url,options,account}),45000,signal);if(!response.ok)throw Error(response.error);const r=new Response(response.data.text,{status:response.data.status});if(!r.ok)throw Error(`Driveとの通信に失敗しました (${r.status})。再接続してください。`);return r;}
  if(window.MICHI_CONFIG?.googleAuthMode==='server'){
   const account=this.getAccount();if(typeof account!=='string'||!account||account.length>255)throw Error('同期先のGoogleアカウントを確認できませんでした。再接続してください。');
   const response=await window.MichiServerAuth.request('drive',{method:'POST',headers:{'Content-Type':'application/json','X-Michi-Request':'1'},body:JSON.stringify({url,options,account})});
   let result;try{result=await response.json();}catch(_){throw Object.assign(Error('同期サーバーの応答を確認できませんでした。'),{authRequired:response.status===401});}
   if(!response.ok||!result?.ok)throw Object.assign(Error(typeof result?.error==='string'?result.error:'Driveとの通信に失敗しました。ローカルの変更は保持しています。'),{authRequired:response.status===401});
   if(!result.data||!Number.isInteger(result.data.status)||result.data.status<200||result.data.status>599||typeof result.data.text!=='string')throw Error('同期サーバーの応答を確認できませんでした。');
   const r=new Response(result.data.text,{status:result.data.status});
   if(!r.ok)throw Object.assign(Error(`Driveとの通信に失敗しました (${r.status})。ローカルの変更は保持しています。`),{authRequired:r.status===401});
   return r;
  }
  const token=await this.getToken();if(!token)throw Error('Google Driveへのログインが必要です。');const r=await window.MichiNetwork.fetch(url,{...options,headers:{...options.headers,Authorization:`Bearer ${token}`},signal});if(r.status===401)throw Object.assign(Error('ログインの期限が切れました。再接続してください。'),{authRequired:true});if(!r.ok)throw Error(`Driveとの通信に失敗しました (${r.status})。ローカルの変更は保持しています。`);return r;
 }
 async list(){let token='',files=[];do{const q=new URLSearchParams({spaces:'appDataFolder',q:"trashed = false and appProperties has { key='michiFormat' and value='op-v1' }",fields:'nextPageToken,files(id,name)',pageSize:'1000'});if(token)q.set('pageToken',token);const data=await(await this.fetch('https://www.googleapis.com/drive/v3/files?'+q)).json();files.push(...(data.files||[]));token=data.nextPageToken||'';}while(token);return files;}
 async pull(files,onProgress=()=>{}){const ops=[];for(const file of files){const text=await(await this.fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`)).text();if(text.length>65536)throw Error('同期ファイルが大きすぎます。安全のため同期を停止しました。');const op=JSON.parse(text);window.MichiSync.valid(op);ops.push(op);onProgress(ops.length,files.length);}return window.MichiSync.merge(ops);}
 async push(op){window.MichiSync.valid(op);const boundary='michi_'+crypto.randomUUID();const metadata={name:`michi-op-${op.id}.json`,mimeType:'application/json',parents:['appDataFolder'],appProperties:{michiFormat:'op-v1'}};const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(op)}\r\n--${boundary}--`;return(await this.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body})).json();}
};
