const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('compact',{list:()=>ipcRenderer.invoke('desktop-compact','list'),open:()=>ipcRenderer.invoke('desktop-compact','open'),onChange:callback=>ipcRenderer.on('desktop-tasks-changed',()=>callback())});
