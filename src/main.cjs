'use strict';
const electron=require('electron');const {app,BrowserWindow,ipcMain}=electron;
const path=require('node:path');const {pathToFileURL}=require('node:url');
const {Store}=require('./store.cjs');const {OperationCache}=require('./desktop/cache.cjs');const {materialize}=require('./sync-core.js');const {createDesktopFeatures}=require('./desktop/features.cjs');
const {createGoogleAuth}=require('./electron-google-auth.cjs');const {driveRequest}=require('./desktop/drive-proxy.cjs');const {readEnv,resolveClient}=require('./env-config.cjs');
let bakedConfig={};try{bakedConfig=require('./generated-config.json');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
const {loadDesktopClientSecret}=require('./desktop/google-client-config.cjs');
const {createGoogleTokenStore}=require('./desktop/google-token-store.cjs');
// Keep development and packaged builds on the same existing task/credential store.
app.setPath('userData',path.join(app.getPath('appData'),'michi-todo'));
let store,cache,mainWindow,desktop,googleAuth,googleConfigError;
const entry=pathToFileURL(path.join(__dirname,'index.html')).href;
function trusted(event){return mainWindow&&!mainWindow.isDestroyed()&&event.sender===mainWindow.webContents&&event.senderFrame===mainWindow.webContents.mainFrame&&event.senderFrame.url===entry;}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>desktop?.show());
 app.whenReady().then(()=>{
  const clientId=resolveClient('desktop',{fileValues:readEnv(path.join(app.isPackaged?(process.env.PORTABLE_EXECUTABLE_DIR||path.dirname(process.execPath)):path.join(__dirname,'..'),'.env')),fallback:bakedConfig.googleDesktopClientId||''});
  let clientSecret='';try{clientSecret=loadDesktopClientSecret(app.getPath('userData'),clientId);}catch(error){googleConfigError=error;}
  googleAuth=createGoogleAuth({clientId,clientSecret,tokenStore:createGoogleTokenStore({userData:app.getPath('userData'),safeStorage:electron.safeStorage}),openExternal: url=>{const u=new URL(url);if(u.origin!=='https://accounts.google.com'||u.pathname!=='/o/oauth2/v2/auth')throw Error('認証URLが不正です。');return electron.shell.openExternal(u.href);}});
  app.on('before-quit',()=>googleAuth.dispose());
  app.setAppUserModelId('jp.local.michitodo');store=new Store(app.getPath('userData'));cache=new OperationCache(app.getPath('userData'));
  ipcMain.handle('tasks',(event,action,payload)=>{if(!trusted(event))throw Error('アクセスできません。');try{let data;if(action==='cache-load')data=cache.load();else if(action==='cache-save'){cache.save(payload);data=null;desktop?.changed();}else data=action==='list'?store.list():store.change(action,payload);return {ok:true,data};}catch(e){return {ok:false,error:e.message};}});
  ipcMain.handle('desktop',(event,action)=>{if(!trusted(event))throw Error('アクセスできません。');try{return {ok:true,data:desktop.handle(action)};}catch(e){return {ok:false,error:e.message};}});
  ipcMain.handle('drive-auth',async(event,action)=>{if(!trusted(event))throw Error('アクセスできません。');try{let data;if(action==='connect'||action==='restore'){if(googleConfigError)throw googleConfigError;data=await googleAuth[action]();}else if(action==='disconnect')data=await googleAuth.disconnect();else if(action==='cancel'){googleAuth.cancel();data=googleAuth.status();}else if(action==='status')data=googleAuth.status();else throw Error('認証操作が不正です。');return {ok:true,data:{...data,account:data.account||data.identity||null}};}catch(e){return {ok:false,error:e.message};}});
  ipcMain.handle('drive-request',async(event,input)=>{if(!trusted(event))throw Error('アクセスできません。');try{return {ok:true,data:await driveRequest(input,async()=>{const token=await googleAuth.getAccessToken();if(typeof input.account!=='string'||!input.account||input.account!==googleAuth.status().identity?.sub)throw Error('同期先のGoogleアカウントが変わりました。元のアカウントで接続してください。');return token;})};}catch(e){return {ok:false,error:e.message};}});
  mainWindow=new BrowserWindow({width:1180,height:800,minWidth:820,minHeight:600,title:'Michi ToDo',icon:path.join(__dirname,'assets','app-icon-256.png'),backgroundColor:'#f7f8fa',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  mainWindow.removeMenu();mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));mainWindow.webContents.on('will-navigate',e=>e.preventDefault());
  desktop=createDesktopFeatures({electron,mainWindow,userData:app.getPath('userData'),readTasks:()=>{const data=cache.load();return data?materialize(data.ops):[];}});
  mainWindow.loadURL(entry);app.on('activate',()=>desktop.show());
 }).catch(error=>{electron.dialog.showErrorBox('設定エラー',error.message);app.quit();});
 app.on('window-all-closed',()=>app.quit());
}
