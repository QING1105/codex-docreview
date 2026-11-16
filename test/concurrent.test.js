'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process');
test('concurrent chats have independent pages, queues, edits, exports and restart recovery',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'docreview-concurrent-'));
 const env={...process.env,DOCREVIEW_DATA:dir,DOCREVIEW_AUTODISPATCH:'0',DOCREVIEW_PORT:'24589'};delete env.DOCREVIEW_LEGACY;
 const client=path.resolve(__dirname,'../server/client.js');
 const tool=(sid,name,args={})=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[client,name,JSON.stringify(args)],{env:{...env,CODEX_THREAD_ID:sid},windowsHide:true});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('exit',code=>{try{const r=JSON.parse(out);if(code)throw Error(out+err);resolve(r.content[0].text)}catch(e){reject(e)}})});
 const api=async(url,route,body)=>{const r=await fetch(url+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json();if(!r.ok)throw Error(j.error);return j};
 const stop=async()=>{for(const folder of fs.readdirSync(path.join(dir,'sessions'))){try{const e=JSON.parse(fs.readFileSync(path.join(dir,'sessions',folder,'endpoint.json')));process.kill(e.pid)}catch{}}await new Promise(r=>setTimeout(r,400))};
 try{
  const [a,b,a2]=await Promise.all([tool('chat-a','doc_review_start'),tool('chat-b','doc_review_start'),tool('chat-a','doc_review_start')]).then(rs=>rs.map(JSON.parse));
  assert.notEqual(a.url,b.url);assert.equal(a.url,a2.url);
  await Promise.all([[a,'Alpha original'],[b,'Beta original']].map(([s,text])=>api(s.url,'api/open',{name:'same-name.txt',b64:Buffer.from(text).toString('base64')})));
  const states=await Promise.all([a,b].map(s=>api(s.url,'api/state')));
  const comments=await Promise.all([a,b].map((s,i)=>api(s.url,'api/comments',{blockId:states[i].blocks[0].id,text:'Request '+i,send:true})));
  const tasks=await Promise.all(['chat-a','chat-b'].map(s=>tool(s,'doc_review_next'))).then(rs=>rs.map(JSON.parse));
  assert.match(tasks[0].prompt,/Alpha original/);assert.doesNotMatch(tasks[0].prompt,/Beta original/);assert.match(tasks[1].prompt,/Beta original/);
  await tool('chat-a','doc_edit_block',{block_id:states[0].blocks[0].id,text:'Alpha revised'});
  assert.match(await tool('chat-b','doc_read'),/Beta original/);
  for(let i=0;i<2;i++){const sid=i?'chat-b':'chat-a';await tool(sid,'comment_reply',{comment_id:comments[i].id,text:'Reply '+i});await tool(sid,'doc_review_finish',{task_id:tasks[i].task_id,text:'Done'})}
  assert.equal((await api(a.url,'api/state')).comments[0].replies[0].text,'Reply 0');
  assert.equal((await api(b.url,'api/state')).comments[0].replies[0].text,'Reply 1');
  const outputs=await Promise.all(['chat-a','chat-b'].map(s=>tool(s,'doc_export')));assert.notEqual(outputs[0],outputs[1]);
  const zip=require('../server/zip');for(let i=0;i<2;i++){const file=outputs[i].replace('已导出：','');const xml=zip.unzip(fs.readFileSync(file)).find(f=>f.name==='word/document.xml').data.toString();assert.match(xml,i?/Beta/:/Alpha/)}
  await tool('chat-a','doc_review_release');assert.match(await tool('chat-b','doc_read'),/Beta original/);
  await new Promise(r=>setTimeout(r,400));await stop();
  const restarted=JSON.parse(await tool('chat-b','doc_review_start'));assert.match(await tool('chat-b','doc_read'),/Beta original/);assert.equal((await api(restarted.url,'api/state')).comments[0].replies[0].text,'Reply 1');
 }finally{await stop();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
});
