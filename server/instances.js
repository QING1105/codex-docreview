'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),net=require('net');
const {createHash}=require('crypto'),{spawn}=require('child_process');
const root=()=>path.resolve(process.env.DOCREVIEW_DATA||path.join(os.homedir(),'.codex-docreview'));
const key=id=>createHash('sha256').update(root()+'\0'+id).digest('hex');
const directory=id=>path.join(root(),'sessions',key(id));
function read(port,route){return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port,path:route},res=>{let data='';res.on('data',d=>data+=d);res.on('end',()=>{try{resolve(JSON.parse(data))}catch{resolve(null)}})});req.on('error',()=>resolve(null));req.setTimeout(800,()=>{req.destroy();resolve(null)})})}
async function endpoint(id){try{const e=JSON.parse(fs.readFileSync(path.join(directory(id),'endpoint.json'),'utf8'));const ping=await read(e.port,'/api/ping');return ping?.instance_key===key(id)?e.port:null}catch{return null}}
async function ensure(id){
 if(process.env.DOCREVIEW_LEGACY==='1')return Number(process.env.DOCREVIEW_PORT||4517);
 const existing=await endpoint(id);if(existing)return existing;
 // Keep an already-open legacy document in its original chat and browser.
 const legacyPort=Number(process.env.DOCREVIEW_PORT||4517),ping=await read(legacyPort,'/api/ping');
 if(ping?.app==='docreview'&&!ping.instance_key){const state=await read(legacyPort,'/api/state');if(state?.agent?.threadId===id)return legacyPort}
 // Verify the spawning identity before creating a detached process or touching document state.
 if(process.env.CODEX_APP_TOOLS_PIPE_PATH&&process.env.DOCREVIEW_AUTODISPATCH!=='0')await require('./host-bridge').checkConnection();
 spawn(process.execPath,[__filename,id],{env:process.env,detached:true,stdio:'ignore',windowsHide:true}).unref();
 for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,100));const port=await endpoint(id);if(port)return port}
 throw Error('当前聊天的审阅实例启动失败，请检查文档目录的写入权限。');
}
if(require.main===module){
 const id=process.argv[2],base=root(),instanceKey=key(id),dir=directory(id);
 const pipe=process.platform==='win32'?'\\\\.\\pipe\\docreview-'+instanceKey:path.join(os.tmpdir(),'docreview-'+instanceKey.slice(0,32)+'.sock');
 const lock=net.createServer(socket=>socket.end());
 lock.on('error',()=>process.exit(0));
 lock.listen(pipe,()=>{
  fs.mkdirSync(dir,{recursive:true});
  // Recover a stopped legacy instance only into the chat that owned it.
  if(!fs.existsSync(path.join(dir,'state.json'))){try{const state=fs.readFileSync(path.join(base,'state.json'));if(JSON.parse(state).sessionId===id){fs.writeFileSync(path.join(dir,'state.json'),state);if(fs.existsSync(path.join(base,'original.docx')))fs.copyFileSync(path.join(base,'original.docx'),path.join(dir,'original.docx'))}}catch{}}
  process.env.DOCREVIEW_DATA=dir;process.env.DOCREVIEW_PORT='0';
  process.env.DOCREVIEW_INSTANCE_KEY=instanceKey;process.env.DOCREVIEW_INSTANCE_SESSION=id;
  require('./daemon');
 });
}
module.exports={ensure,directory};
