'use strict';
const fs=require('node:fs'),path=require('node:path');
const {readEnv,resolveClient,webScript}=require('../src/env-config.cjs');
const root=path.join(__dirname,'..'),out=path.join(root,'dist','web');
const fileValues=readEnv(path.join(root,'.env'));
const id=resolveClient('web',{fileValues});
const config=webScript(id,process.env.GOOGLE_WEB_AUTH_MODE||fileValues.GOOGLE_WEB_AUTH_MODE||'gis');
// Clean output: stale files, especially secrets, must never become deployable assets.
if(path.resolve(out)!==path.join(path.resolve(root),'dist','web'))throw Error('Invalid build output directory');
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
const files=['index.html','style.css','renderer.js','sync-core.js','drive-sync.js','data-adapter.js','manifest.webmanifest','sw.js','icon.svg'];
const assets=['assets/app-icon-32.png','assets/app-icon-180.png','assets/app-icon-192.png','assets/app-icon-256.png','assets/app-icon-512.png','assets/app-icon.ico','assets/sounds/click.ogg','assets/sounds/complete.ogg','assets/sounds/LICENSE.txt','assets/sounds/Kenney-LICENSE.txt'];
for(const f of [...files,...assets]){fs.mkdirSync(path.dirname(path.join(out,f)),{recursive:true});fs.copyFileSync(path.join(root,'src',f),path.join(out,f));}
fs.writeFileSync(path.join(out,'config.js'),config);
console.log(`Built ${files.length+assets.length+1} static assets in dist/web. `+(id?'OAuth client ID configured.':'Offline mode: GOOGLE_WEB_CLIENT_ID is not configured.'));
