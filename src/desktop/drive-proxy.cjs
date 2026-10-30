'use strict';
const {valid}=require('../sync-core.js');
function validateRequest(input){
 if(!input||typeof input.url!=='string'||input.url.length>10000)throw Error('Driveリクエストが不正です。');const u=new URL(input.url);if(u.origin!=='https://www.googleapis.com'||u.username||u.password||u.hash)throw Error('許可されていない接続先です。');
 const options=input.options||{},method=options.method||'GET',headers={},query=u.searchParams;
 if(method==='GET'&&u.pathname==='/drive/v3/files'){
  const keys=['spaces','q','fields','pageSize','pageToken'];if([...query.keys()].some(k=>!keys.includes(k))||query.get('spaces')!=='appDataFolder'||query.get('q')!=="trashed = false and appProperties has { key='michiFormat' and value='op-v1' }"||query.get('fields')!=='nextPageToken,files(id,name)'||query.get('pageSize')!=='1000')throw Error('Drive一覧の範囲が不正です。');return {url:u.href,method,headers};
 }
 if(method==='GET'&&/^\/drive\/v3\/files\/[A-Za-z0-9_-]{1,200}$/.test(u.pathname)&&u.search==='?alt=media')return {url:u.href,method,headers};
 if(method==='POST'&&u.pathname==='/upload/drive/v3/files'&&u.search==='?uploadType=multipart&fields=id'){
  const contentType=options.headers?.['Content-Type'];const match=/^multipart\/related; boundary=(michi_[A-Za-z0-9-]{1,80})$/.exec(contentType||'');if(!match||typeof options.body!=='string'||Buffer.byteLength(options.body)>100000)throw Error('同期データのサイズ・形式が不正です。');
  const b=match[1],parts=options.body.split(`--${b}`);if(parts.length!==4||parts[0]!==''||parts[3]!=='--')throw Error('同期データ形式が不正です。');
  function json(part){const index=part.indexOf('\r\n\r\n');if(index<0||!part.endsWith('\r\n'))throw Error('同期データ形式が不正です。');return JSON.parse(part.slice(index+4,-2));}
  const metadata=json(parts[1]),op=valid(json(parts[2]));if(metadata.name!==`michi-op-${op.id}.json`||metadata.mimeType!=='application/json'||JSON.stringify(metadata.parents)!=='["appDataFolder"]'||metadata.appProperties?.michiFormat!=='op-v1'||Object.keys(metadata).some(k=>!['name','mimeType','parents','appProperties'].includes(k)))throw Error('アプリ専用領域以外には保存できません。');
  headers['Content-Type']=contentType;return {url:u.href,method,headers,body:options.body};
 }
 throw Error('許可されていないDrive操作です。');
}
async function driveRequest(input,getAccessToken,fetchImpl=fetch){const r=validateRequest(input),token=await getAccessToken();if(typeof token!=='string'||!token)throw Error('Google Driveへのログインが必要です。');const response=await fetchImpl(r.url,{method:r.method,headers:{...r.headers,Authorization:`Bearer ${token}`},body:r.body,redirect:'error',signal:AbortSignal.timeout(30000)});const text=await response.text();if(text.length>4*1024*1024)throw Error('Driveの応答が大きすぎます。');return {status:response.status,text};}
module.exports={validateRequest,driveRequest};
