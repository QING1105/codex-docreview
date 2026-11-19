'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),{spawn,spawnSync}=require('child_process');
test('permission denial fails doctor/start and preserves queued comments without endless retries',{timeout:20000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'docreview-permissions-')),root=path.resolve(__dirname,'..'),mock=path.join(dir,'deny.js'),calls=path.join(dir,'calls');
 fs.writeFileSync(mock,`const net=require('net'),{EventEmitter}=require('events');const original=net.createConnection;net.createConnection=function(p,...args){if(p!=='docreview-denied-test')return original.call(this,p,...args);require('fs').appendFileSync(process.env.PROBE_LOG,'x');const s=new EventEmitter();s.destroy=()=>{};process.nextTick(()=>s.emit('error',Object.assign(new Error('denied'),{code:'EPERM'})));return s};`);
 const env={...process.env,CODEX_APP_TOOLS_PIPE_PATH:'docreview-denied-test',PROBE_LOG:calls,DOCREVIEW_DATA:path.join(dir,'data'),DOCREVIEW_PORT:'24623'};delete env.DOCREVIEW_AUTODISPATCH;delete env.DOCREVIEW_LEGACY;
 let daemon;
 const api=async(route,body)=>{const r=await fetch('http://127.0.0.1:24623'+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,value:await r.json()}};
 try{
  const doctor=spawnSync(process.execPath,['--require',mock,path.join(root,'server/doctor.js'),'--skip-port'],{env,encoding:'utf8'});
  assert.equal(doctor.status,1);const report=JSON.parse(doctor.stdout);assert.equal(report.ok,false);assert.equal(report.checks.find(c=>c.id==='current-chat').code,'EPERM');
  const start=spawnSync(process.execPath,['--require',mock,'-e',`require(${JSON.stringify(path.join(root,'server/instances.js'))}).ensure('permission-test').catch(e=>console.log(e.code))`],{env,encoding:'utf8'});
  assert.equal(start.stdout.trim(),'EPERM');assert.equal(fs.existsSync(env.DOCREVIEW_DATA),false);
  daemon=spawn(process.execPath,['--require',mock,path.join(root,'server/daemon.js')],{env,stdio:'ignore',windowsHide:true});
  for(let i=0;i<80;i++){try{await api('/api/ping');break}catch{await new Promise(r=>setTimeout(r,30))}}
  const bound=await api('/api/session/bind',{session_id:'permission-test',host_bridge:{pipe:env.CODEX_APP_TOOLS_PIPE_PATH}});
  assert.equal(bound.status,400);assert.match(bound.value.error,/EPERM/); // Existing daemon identity is checked too.
  await api('/api/session/bind',{session_id:'permission-test'});
  await api('/api/open',{name:'test.txt',b64:Buffer.from('Example').toString('base64')});
  await api('/api/chat',{text:'Explain the paragraph'});
  await new Promise(r=>setTimeout(r,600));const count=fs.readFileSync(calls,'utf8').length;
  await new Promise(r=>setTimeout(r,5300));assert.equal(fs.readFileSync(calls,'utf8').length,count);
  const state=(await api('/api/state')).value;assert.equal(state.queue[0].status,'queued');assert.equal(state.queue[0].deliveryBlocked,true);assert.equal(state.comments[0].text,'Explain the paragraph');
  const next=(await api('/api/session/next',{session_id:'permission-test'})).value;assert.ok(next.task_id); // Queue remains accessible for recovery.
 }finally{if(daemon){const exited=new Promise(r=>daemon.once('exit',r));daemon.kill();await exited}assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
});
