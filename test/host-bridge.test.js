const {test}=require('node:test'),a=require('node:assert/strict'),net=require('node:net'),{notifyThread}=require('../server/host-bridge');
test('web submit forwards to the bound existing chat with its current model',async()=>{
 const pipe=process.platform==='win32'?'\\\\.\\pipe\\docreview-test-'+process.pid:'/tmp/docreview-test-'+process.pid;
 let delivered;
 const server=net.createServer(socket=>{let buf=Buffer.alloc(0);socket.on('data',d=>{buf=Buffer.concat([buf,d]);if(buf.length<4||buf.length<4+buf.readUInt32LE())return;const msg=JSON.parse(buf.subarray(4));let result;
 if(msg.method==='tools/list')result={tools:[{name:'send_message_to_thread',namespace:'codex_app'}]};
 else{delivered=msg.params;result={success:true,contentItems:[]};}
 const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})),header=Buffer.alloc(4);header.writeUInt32LE(data.length);socket.end(Buffer.concat([header,data]));});});
 await new Promise(r=>server.listen(pipe,r));
 try{await notifyThread({pipe,threadId:'original-chat',prompt:'用户的实际批注',callId:'test-call'});a.equal(delivered.threadId,'original-chat');a.equal(delivered.arguments.threadId,'original-chat');a.equal(delivered.arguments.prompt,'用户的实际批注');a.equal(delivered.arguments.model,undefined);}
 finally{await new Promise(r=>server.close(r));}
});
