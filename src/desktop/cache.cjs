'use strict';
const fs=require('node:fs'),path=require('node:path');const {merge}=require('../sync-core.js');
function validateCache(x){
 if(!x||typeof x!=='object'||typeof x.device!=='string'||!x.device||x.device.length>200||!Array.isArray(x.ops)||x.ops.length>100000||!Array.isArray(x.pending)||x.pending.length>100000)throw Error('保存データが不正です。');
 const ops=merge(x.ops),ids=new Set(ops.map(o=>o.id));if(x.pending.some(id=>typeof id!=='string'||!ids.has(id)))throw Error('未同期データの参照が不正です。');
 if(x.account!==undefined&&(typeof x.account!=='string'||x.account.length>200))throw Error('アカウント識別情報が不正です。');
 if(x.knownFiles!==undefined&&(!Array.isArray(x.knownFiles)||x.knownFiles.length>100000||x.knownFiles.some(id=>typeof id!=='string'||id.length>200)))throw Error('同期ファイル情報が不正です。');
 return {device:x.device,ops,pending:[...new Set(x.pending)],...(x.account!==undefined?{account:x.account}:{}),...(x.knownFiles!==undefined?{knownFiles:x.knownFiles}: {})};
}
class OperationCache{constructor(dir){fs.mkdirSync(dir,{recursive:true});this.file=path.join(dir,'operations.json');}load(){if(!fs.existsSync(this.file))return null;const stat=fs.statSync(this.file);if(stat.size>50*1024*1024)throw Error('保存データが大きすぎます。');return validateCache(JSON.parse(fs.readFileSync(this.file,'utf8')));}save(value){const next=validateCache(value);const text=JSON.stringify(next);if(Buffer.byteLength(text)>50*1024*1024)throw Error('保存データが大きすぎます。');if(fs.existsSync(this.file))this.load();fs.writeFileSync(this.file+'.tmp',text,{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);return next;}}
module.exports={OperationCache,validateCache};
