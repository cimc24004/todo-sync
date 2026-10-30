'use strict';
const fs=require('node:fs'),path=require('node:path');
const {readEnv,resolveClient,webScript}=require('../src/env-config.cjs');
const root=path.join(__dirname,'..'),out=path.join(root,'dist','web');
const id=resolveClient('web',{fileValues:readEnv(path.join(root,'.env'))});
// Clean output: stale files, especially secrets, must never become deployable assets.
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
const files=['index.html','style.css','renderer.js','sync-core.js','drive-sync.js','data-adapter.js','manifest.webmanifest','sw.js','icon.svg'];
for(const f of files)fs.copyFileSync(path.join(root,'src',f),path.join(out,f));
fs.writeFileSync(path.join(out,'config.js'),webScript(id));
console.log('Built 10 static assets in dist/web. '+(id?'OAuth client ID configured; live login remains to be tested.':'Offline mode: GOOGLE_WEB_CLIENT_ID is not configured.'));
