'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),{spawn}=require('child_process');
test('web questions reach their chat, recover after restart and reconnect on ordinary tool calls',{timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'docreview-dispatch-')),port=24619,url='http://127.0.0.1:'+port;
 const pipe=process.platform==='win32'?'\\\\.\\pipe\\docreview-dispatch-'+process.pid:path.join(dir,'bridge.sock');
 const deliveries=[];let daemon;
 const bridge=net.createServer(socket=>{let bytes=Buffer.alloc(0);socket.on('data',d=>{
  bytes=Buffer.concat([bytes,d]);if(bytes.length<4||bytes.length<bytes.readUInt32LE()+4)return;
  const m=JSON.parse(bytes.subarray(4));let result;
  if(m.method==='tools/list')result={tools:[{name:'send_message_to_thread',namespace:'codex_app'}]};
  else{deliveries.push(m.params);result={success:true,contentItems:[]};}
  const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result})),head=Buffer.alloc(4);head.writeUInt32LE(body.length);socket.end(Buffer.concat([head,body]));
 });});
 await new Promise(r=>bridge.listen(pipe,r));
 const env={...process.env,DOCREVIEW_DATA:dir,DOCREVIEW_PORT:String(port),DOCREVIEW_LEGACY:'1',CODEX_APP_TOOLS_PIPE_PATH:pipe+'-expired'};delete env.DOCREVIEW_AUTODISPATCH;
 const api=async(route,body)=>{const r=await fetch(url+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json();if(!r.ok)throw Error(j.error);return j};
 const until=async(fn)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30))}throw Error('Timed out')};
 const start=async()=>{daemon=spawn(process.execPath,[path.resolve(__dirname,'../server/daemon.js')],{env,stdio:'ignore',windowsHide:true});await until(async()=>{try{await api('/api/ping');return true}catch{return false}})};
 const stop=async()=>{const done=new Promise(r=>daemon.once('exit',r));daemon.kill();await done};
 const tool=name=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,[path.resolve(__dirname,'../server/client.js'),name,'{}'],{env:{...env,CODEX_THREAD_ID:'chat-dispatch',CODEX_APP_TOOLS_PIPE_PATH:pipe,CODEX_APP_TOOLS_CALLER_HOST_ID:'host-a'},windowsHide:true});let out='';c.stdout.on('data',d=>out+=d);c.on('exit',code=>code?reject(Error(out)):resolve(out))});
 try{
  await start();await api('/api/session/bind',{session_id:'chat-dispatch'});
  await api('/api/open',{name:'sample.txt',b64:Buffer.from('Example paragraph').toString('base64')});
  const c=await api('/api/chat',{text:'Explain this paragraph'});
  await until(async()=>(await api('/api/state')).queue[0].deliveryError);
  await tool('doc_read'); // An ordinary call replaces the expired bridge without reopening the page.
  await until(()=>deliveries.length===1);await until(async()=>(await api('/api/state')).queue[0].delivered);
  assert.equal(deliveries[0].arguments.threadId,'chat-dispatch');assert.equal(deliveries[0].arguments.hostId,'host-a');assert.match(deliveries[0].arguments.prompt,/Explain this paragraph/);
  await new Promise(r=>setTimeout(r,300));await stop();await start();await tool('doc_read');
  await until(()=>deliveries.length===2);assert.notEqual(deliveries[0].callId,deliveries[1].callId);
  const task=await api('/api/session/next',{session_id:'chat-dispatch'});assert.match(task.prompt,/Explain this paragraph/);
  await new Promise(r=>setTimeout(r,300));await stop();await start();await tool('doc_read');
  await until(()=>deliveries.length===3);
  const resumed=await api('/api/session/next',{session_id:'chat-dispatch'});assert.equal(resumed.task_id,task.task_id);
  await api('/api/comment/reply',{id:c.id,text:'Here is the explanation',author:'Codex'});
  await api('/api/session/finish',{session_id:'chat-dispatch',task_id:task.task_id});
  const state=await api('/api/state');assert.equal(state.queue[0].status,'done');assert.equal(state.comments[0].replies[0].text,'Here is the explanation');
  await new Promise(r=>setTimeout(r,300));await stop();await start();await tool('doc_read');await new Promise(r=>setTimeout(r,500));assert.equal(deliveries.length,3);
  // Opening another document reuses short queue IDs, but must produce a fresh delivery ID.
  await api('/api/open',{name:'second.txt',b64:Buffer.from('Another paragraph').toString('base64')});
  await api('/api/chat',{text:'Explain this paragraph'});await until(()=>deliveries.length===4);
  assert.equal((await api('/api/state')).queue[0].id,task.task_id);
  assert.notEqual(deliveries[3].callId,deliveries[0].callId);
 }finally{if(daemon?.exitCode===null)await stop();await new Promise(r=>bridge.close(r));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
});
