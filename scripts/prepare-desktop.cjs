'use strict';
const fs=require('node:fs'),path=require('node:path');
const {readEnv,resolveClient}=require('../src/env-config.cjs');
const root=path.join(__dirname,'..');
const googleDesktopClientId=resolveClient('desktop',{fileValues:readEnv(path.join(root,'.env'))});
fs.writeFileSync(path.join(root,'src','generated-config.json'),JSON.stringify({googleDesktopClientId},null,2)+'\n');
console.log('Prepared desktop public OAuth client ID only; no secrets copied.');
