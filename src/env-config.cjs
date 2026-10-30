'use strict';
const fs=require('node:fs');
const {parseEnv}=require('node:util');
const KEYS={web:'GOOGLE_WEB_CLIENT_ID',desktop:'GOOGLE_DESKTOP_CLIENT_ID'};
function readEnv(file){try{return parseEnv(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw Error('設定ファイル .env を読み込めません。');}}
function clientId(value,key){if(value===undefined||value==='')return '';if(typeof value!=='string'||value.length>256||!/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value))throw Error(`${key} は Google OAuth クライアントID形式で指定してください。`);return value;}
function resolveClient(kind,{env=process.env,fileValues={},fallback=''}={}){const key=KEYS[kind];if(!key)throw Error('Unknown config target');return clientId(Object.hasOwn(env,key)?env[key]:Object.hasOwn(fileValues,key)?fileValues[key]:fallback,key);}
function webScript(id,authMode='gis'){if(!['gis','server'].includes(authMode))throw Error('GOOGLE_WEB_AUTH_MODE は gis または server を指定してください。');return 'window.MICHI_CONFIG = Object.freeze('+JSON.stringify({googleWebClientId:clientId(id,KEYS.web),...(authMode==='server'?{googleAuthMode:'server'}:{})}).replace(/</g,'\\u003c')+');\n';}
module.exports={readEnv,clientId,resolveClient,webScript};
