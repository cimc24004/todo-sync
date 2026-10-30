'use strict';
function localDay(value){const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function reminderCandidates(tasks, now=Date.now(), sent={}){
 const out=[];
 for(const t of tasks){
  if(!t || t.done || t.deletedAt || typeof t.id!=='string' || typeof t.title!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.due||''))continue;
  const [y,m,d]=t.due.split('-').map(Number),due=new Date(y,m-1,d,9);
  if(localDay(due)!==t.due)continue;
  const reminder=new Date(y,m-1,d-1,9).getTime(), cutoff=new Date(y,m-1,d+1,0).getTime();
  const key=JSON.stringify([t.id,t.due]);
  if(now>=reminder && now<cutoff && !sent[key])out.push({key,id:t.id,title:t.title.slice(0,120),due:t.due,late:localDay(now)===t.due});
 }
 return out;
}
function sanitizeSnapshot(value){
 if(!Array.isArray(value)||value.length>20000)throw Error('タスク一覧が大きすぎます。');
 return value.map(t=>{if(!t||typeof t.id!=='string'||t.id.length>200||typeof t.title!=='string'||t.title.length>120||typeof t.done!=='boolean'||typeof t.due!=='string'||(t.due&&!/^\d{4}-\d{2}-\d{2}$/.test(t.due)))throw Error('通知用タスク形式が正しくありません。');return {id:t.id,title:t.title,done:t.done,due:t.due,deletedAt:t.deletedAt?true:null};});
}
module.exports={reminderCandidates,sanitizeSnapshot,localDay};
