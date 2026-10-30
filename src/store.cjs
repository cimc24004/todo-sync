const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function clean(input) {
  if (!input || typeof input !== 'object') throw new Error('タスクの形式が正しくありません。');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 120) throw new Error('タイトルは1〜120文字で入力してください。');
  const notes = typeof input.notes === 'string' ? input.notes : '';
  if (notes.length > 5000) throw new Error('メモは5000文字以内で入力してください。');
  const due = input.due || '';
  if (typeof due !== 'string' || (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || new Date(due).toISOString().slice(0,10) !== due))) throw new Error('締切の日付を確認してください。');
  if (!['low','normal','high'].includes(input.priority)) throw new Error('優先度が正しくありません。');
  return { title, notes, due, priority:input.priority };
}
class Store {
  constructor(dir) { this.file = path.join(dir,'tasks.json'); fs.mkdirSync(dir,{recursive:true}); this.state={version:1,tasks:[]}; this.warning='';
    if(fs.existsSync(this.file)) { try { const data=JSON.parse(fs.readFileSync(this.file,'utf8')); if(data.version!==1||!Array.isArray(data.tasks)) throw Error(); const ids=new Set(); for(const t of data.tasks){clean(t);if(typeof t.id!=='string'||!t.id||ids.has(t.id)||typeof t.done!=='boolean'||typeof t.createdAt!=='string'||!Number.isFinite(Date.parse(t.createdAt))||(t.deletedAt!==null&&(typeof t.deletedAt!=='string'||!Number.isFinite(Date.parse(t.deletedAt)))))throw Error(); ids.add(t.id);} this.state=data; }
    catch { const backup=this.file+'.invalid-'+Date.now(); fs.copyFileSync(this.file,backup); this.warning='保存データを読み込めなかったため、元データをバックアップして空の一覧を開きました。'; } }
  }
  list(){ return {tasks:structuredClone(this.state.tasks),warning:this.warning}; }
  change(action,payload={}){
    const next=structuredClone(this.state); const task=next.tasks.find(t=>t.id===payload.id);
    if(action==='add')next.tasks.push({...clean(payload),id:randomUUID(),done:false,deletedAt:null,createdAt:new Date().toISOString()});
    else {if(!task)throw new Error('タスクが見つかりません。');
      if(action==='edit')Object.assign(task,clean(payload));
      else if(action==='toggle')task.done=!task.done;
      else if(action==='trash')task.deletedAt=new Date().toISOString();
      else if(action==='restore')task.deletedAt=null;
      else throw new Error('操作が正しくありません。');
    }
    const temp=this.file+'.tmp'; fs.writeFileSync(temp,JSON.stringify(next,null,2),'utf8'); fs.renameSync(temp,this.file); this.state=next; return this.list();
  }
}
module.exports={Store,clean};
