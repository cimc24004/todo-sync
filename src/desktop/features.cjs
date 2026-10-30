'use strict';
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {reminderCandidates,sanitizeSnapshot}=require('./reminders.cjs');
function createDesktopFeatures({electron,mainWindow,userData,readTasks}){
 const {app,BrowserWindow,Tray,Menu,nativeImage,globalShortcut,Notification,ipcMain}=electron;
 const file=path.join(userData,'desktop-settings.json');
 let state={notifications:false,closeToTray:true,sent:{}},error='',quitting=false,compact=null,tray=null,shortcut=false;
 try{if(fs.existsSync(file)){const x=JSON.parse(fs.readFileSync(file,'utf8'));if(typeof x.notifications!=='boolean'||typeof x.closeToTray!=='boolean'||!x.sent||typeof x.sent!=='object'||Array.isArray(x.sent))throw Error('Invalid settings');state=x;}}catch{error='デスクトップ設定を読み込めません。通知は無効です。';}
 function save(){try{fs.writeFileSync(file+'.tmp',JSON.stringify(state));fs.renameSync(file+'.tmp',file);return true;}catch{error='デスクトップ設定を保存できません。';return false;}}
 function show(event){if(mainWindow.isDestroyed())return;if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();if(event)mainWindow.webContents.send('desktop-event',event);}
 const compactURL=pathToFileURL(path.join(__dirname,'compact.html')).href;
 function openCompact(){if(compact&&!compact.isDestroyed()){compact.show();compact.focus();return;}compact=new BrowserWindow({width:380,height:510,minWidth:300,minHeight:280,alwaysOnTop:true,title:'今日 • Michi',backgroundColor:'#f5f5ee',webPreferences:{preload:path.join(__dirname,'compact-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});compact.removeMenu();compact.webContents.setWindowOpenHandler(()=>({action:'deny'}));compact.webContents.on('will-navigate',e=>e.preventDefault());compact.loadURL(compactURL);compact.on('closed',()=>compact=null);}
 function rows(){try{return sanitizeSnapshot(readTasks());}catch{return [];}}
 ipcMain.handle('desktop-compact',(e,action)=>{if(!compact||e.sender!==compact.webContents||e.senderFrame!==compact.webContents.mainFrame||e.senderFrame.url!==compactURL)throw Error('アクセスできません。');if(action==='list')return rows();if(action==='open'){show('today');return null;}throw Error('操作が正しくありません。');});
 function status(){let startup=false;try{if(process.platform==='win32')startup=app.getLoginItemSettings().openAtLogin;}catch{}return {notifications:state.notifications,notificationSupported:Notification.isSupported(),closeToTray:state.closeToTray,trayAvailable:!!tray,shortcutAvailable:shortcut,shortcut:'Ctrl+Shift+Space',startup,startupSupported:process.platform==='win32'&&app.isPackaged,error};}
 function menu(){const s=status();return Menu.buildFromTemplate([{label:'Michi を開く',click:()=>show()},{label:'タスクを追加  Ctrl+Shift+Space',click:()=>show('quick-add')},{label:'今日のミニウィンドウ（最前面）',click:openCompact},{type:'separator'},{label:'×で閉じたときトレイに常駐',type:'checkbox',checked:state.closeToTray,enabled:!!tray,click:item=>{const old=state.closeToTray;state.closeToTray=item.checked;if(!save())state.closeToTray=old;refreshMenu();}},{label:'締切通知を有効にする（前日9時／起動中）',type:'checkbox',checked:state.notifications,enabled:Notification.isSupported(),click:item=>{const old=state.notifications;state.notifications=item.checked;if(!save())state.notifications=old;refreshMenu();check();}},{label:'Windows サインイン時に起動',type:'checkbox',checked:s.startup,enabled:s.startupSupported,click:item=>{try{app.setLoginItemSettings({openAtLogin:item.checked,path:process.execPath});}catch{error='自動起動の変更に失敗しました。';}refreshMenu();}},{type:'separator'},{label:'完全に終了',click:()=>{quitting=true;app.quit();}}]);}
 function refreshMenu(){if(tray)tray.setContextMenu(menu());}
 try{const icon=nativeImage.createFromPath(path.join(__dirname,'tray.png'));tray=new Tray(icon);tray.setToolTip('Michi ToDo • 右クリックで設定・終了');tray.on('click',()=>show());refreshMenu();}catch{error='この環境ではトレイを利用できません。×で終了します。';}
 try{shortcut=globalShortcut.register('CommandOrControl+Shift+Space',()=>show('quick-add'));if(!shortcut)error='Ctrl+Shift+Space は他のアプリが使用中です。トレイから追加できます。';}catch{error='グローバルショートカットを利用できません。';}
 mainWindow.on('close',event=>{if(!quitting&&tray&&state.closeToTray){event.preventDefault();mainWindow.hide();}});
 app.on('before-quit',()=>quitting=true);
 function check(){if(!state.notifications||!Notification.isSupported())return;for(const r of reminderCandidates(rows(),Date.now(),state.sent)){const n=new Notification({title:r.late?'今日が締切です':'明日が締切です',body:`${r.title}\n締切日：${r.due}`,silent:false});state.sent[r.key]=Date.now();if(!save()){delete state.sent[r.key];break;}n.on('click',()=>show('today'));n.on('failed',()=>{error='OS通知を表示できませんでした。通知設定を確認してください。';});n.show();}}
 const timer=setInterval(check,60000);timer.unref();check();
 app.on('will-quit',()=>{clearInterval(timer);globalShortcut.unregisterAll();if(tray)tray.destroy();});
 return {status,show,openCompact,changed(){if(compact&&!compact.isDestroyed())compact.webContents.send('desktop-tasks-changed');check();},handle(action){if(action==='status')return status();if(action==='settings'){menu().popup({window:mainWindow});return status();}if(action==='compact'){openCompact();return status();}if(action==='quick-add'){show('quick-add');return status();}if(action==='quit'){quitting=true;app.quit();return null;}throw Error('操作が正しくありません。');}};
}
module.exports={createDesktopFeatures};
