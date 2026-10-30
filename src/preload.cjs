'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('todo',{request:(action,payload)=>ipcRenderer.invoke('tasks',action,payload),desktop:action=>ipcRenderer.invoke('desktop',action),driveAuth:action=>ipcRenderer.invoke('drive-auth',action),driveRequest:input=>ipcRenderer.invoke('drive-request',input)});
ipcRenderer.on('desktop-event',(_event,action)=>{if(action==='quick-add'||action==='today')window.dispatchEvent(new Event('michi-'+action));});
