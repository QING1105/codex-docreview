'use strict';
const net = require('net');
const { randomUUID } = require('crypto');
function request(pipe, method, params) {
  return new Promise((resolve, reject) => {
    if (!pipe) return reject(new Error('请从 Codex 桌面聊天启动插件，以连接当前聊天'));
    const socket = net.createConnection(pipe); let bytes = Buffer.alloc(0), settled = false;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('Codex 聊天接口响应超时')), 15000);
    socket.once('error', e => {if(['EPERM','EACCES'].includes(e.code))e.message=`${e.code}：当前进程账户 ${require('os').userInfo().username} 无权连接 Codex 桌面管道。请通过宿主授权，以桌面登录用户运行环境检查并启动审阅服务；已有实例需保存状态后重启。`;finish(e)}); socket.once('end', () => finish(new Error('Codex 聊天接口已关闭')));
    socket.once('connect', () => { const body = Buffer.from(JSON.stringify({ jsonrpc:'2.0', id:1, method, params })); const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame); });
    socket.on('data', data => {
      bytes = Buffer.concat([bytes,data]);
      while (bytes.length >= 4) {
        const size = bytes.readUInt32LE(0); if(size > 16e6) return finish(new Error('聊天接口响应过大'));
        if(bytes.length < size + 4)return;
        let r;try{r=JSON.parse(bytes.subarray(4,size+4));}catch(e){return finish(e)}
        bytes=bytes.subarray(size+4);if(r.id!==1)continue;
        return r.error?finish(new Error(r.error.message)):finish(null,r.result);
      }
    });
  });
}
async function notifyThread({pipe,hostId,threadId,prompt,callId}) {
  const catalog = await request(pipe,'tools/list',{threadStartKind:'all'});
  const tool = catalog.tools.find(t=>t.name==='send_message_to_thread');
  if(!tool)throw new Error('当前 Codex 桌面未提供聊天消息接口');
  const result=await request(pipe,'tools/call',{
    namespace:tool.namespace,tool:tool.name,callerSource:'codex',threadId,hostId,
    turnId:'docreview-submit',callId:callId||('docreview-'+randomUUID()),arguments:{threadId,prompt,...(hostId?{hostId}:{})}
  });
  if(!result.success)throw new Error(result.contentItems?.filter(c=>c.type==='inputText').map(c=>c.text).join('\n')||'发送到当前聊天失败');
  return result;
}
async function checkConnection(pipe=process.env.CODEX_APP_TOOLS_PIPE_PATH){
 const catalog=await request(pipe,'tools/list',{threadStartKind:'all'});
 if(!catalog.tools?.some(t=>t.name==='send_message_to_thread'))throw Error('当前 Codex 桌面未提供聊天消息接口');
 return {ok:true,user:require('os').userInfo().username};
}
module.exports={request,notifyThread,checkConnection};
