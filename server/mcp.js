'use strict';
// Codex 用的 MCP 服务（stdio）。很薄：所有操作转发给本地服务，没启动就先拉起来。
const http = require('http'), path = require('path'), { spawn } = require('child_process'), readline = require('readline');
const { AsyncLocalStorage } = require('async_hooks');
const session = new AsyncLocalStorage();
const PORT = +(process.env.DOCREVIEW_PORT || 4517);
function call(method, p, data) {
  return new Promise((res, rej) => {
    const b = data ? Buffer.from(JSON.stringify(data)) : null;
    const r = http.request({ host: '127.0.0.1', port: session.getStore()?.port || PORT, path: p, method, headers: { ...(b ? { 'Content-Type': 'application/json', 'Content-Length': b.length } : {}), ...(session.getStore() ? { 'X-Docreview-Session': session.getStore().id } : {}) } }, x => { let s = ''; x.on('data', d => s += d); x.on('end', () => { try { const j = JSON.parse(s); j.error ? rej(new Error(j.error)) : res(j); } catch { rej(new Error(s.slice(0, 200))); } }); });
    r.on('error', rej); r.setTimeout(30000, () => r.destroy(new Error('本地服务无响应'))); if (b) r.write(b); r.end();
  });
}
async function ensure() {
  session.getStore().port = await require('./instances').ensure(session.getStore().id);
}
async function refreshBridge() {
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH) await call('POST', '/api/session/bridge', {
    session_id:session.getStore().id,
    host_bridge:{pipe:process.env.CODEX_APP_TOOLS_PIPE_PATH,host_id:process.env.CODEX_APP_TOOLS_CALLER_HOST_ID}
  });
}
const str = (d, req) => ({ type: 'string', description: d });
const TOOLS = [
  { name: 'doc_open', description: '在批注页里打开一份文档（.docx / .md / .txt），返回网页地址。会清空上一份文档的批注。', inputSchema: { type: 'object', properties: { path: str('文档的绝对路径') }, required: ['path'] }, run: async a => { const r = await call('POST', '/api/open', { path: a.path }); return `已打开，共 ${r.blocks} 段。请用户在浏览器里打开 ${r.url} 进行批注。`; } },
  { name: 'doc_read', description: '读取当前文档全部段落（带段落 ID）和未解决的批注。', inputSchema: { type: 'object', properties: {} }, run: async () => (await call('GET', '/api/read')).text },
  { name: 'doc_edit_block', description: '把某一段替换为新内容。传完整的新段落文字；未要求改动的文字逐字保留，否则会产生多余修订。', inputSchema: { type: 'object', properties: { block_id: str('段落 ID，如 b12'), text: str('该段完整的新内容') }, required: ['block_id', 'text'] }, run: async a => { await call('POST', '/api/block/edit', { id: a.block_id, text: a.text, author: 'Codex' }); return '已修改 ' + a.block_id; } },
  { name: 'doc_insert_block', description: '在某段之后插入新段落。', inputSchema: { type: 'object', properties: { after_block_id: str('插在这一段之后；留空则插在文首'), text: str('新段落内容'), type: { type: 'string', enum: ['p', 'h1', 'h2', 'h3', 'li', 'code'], description: '段落类型，默认 p' } }, required: ['text'] }, run: async a => { const b = await call('POST', '/api/block/insert', { afterId: a.after_block_id || null, text: a.text, type: a.type, author: 'Codex' }); return '已插入 ' + b.id; } },
  { name: 'doc_delete_block', description: '删除一段。', inputSchema: { type: 'object', properties: { block_id: str('段落 ID') }, required: ['block_id'] }, run: async a => { await call('POST', '/api/block/delete', { id: a.block_id, author: 'Codex' }); return '已删除 ' + a.block_id; } },
  { name: 'comment_reply', description: '回复一条批注，说明做了什么或回答问题。每处理完一条批注都必须调用。', inputSchema: { type: 'object', properties: { comment_id: str('批注 ID，如 c3'), text: str('回复内容') }, required: ['comment_id', 'text'] }, run: async a => { await call('POST', '/api/comment/reply', { id: a.comment_id, text: a.text, author: 'Codex' }); return '已回复 ' + a.comment_id; } },
  { name: 'doc_export', description: '导出带修订痕迹和批注的 Word 文件。', inputSchema: { type: 'object', properties: { path: str('输出 .docx 的绝对路径；留空则存到默认目录') } }, run: async a => '已导出：' + (await call('POST', '/api/export', { path: a.path })).path },
];
TOOLS.push(
  { name: 'doc_set_fonts', description: '设置全文中西文字体，同时应用于网页及导出的 Word。', inputSchema: { type: 'object', properties: { latin: str('西文字体名称，例如 Arial'), east_asia: str('中文字体名称，例如 华文中宋') }, required: ['latin', 'east_asia'] }, run: async a => JSON.stringify(await call('POST', '/api/fonts', a)) },
  { name: 'doc_review_start', description: '启动批注页并绑定发起审阅的当前 Codex 聊天。返回网页地址。', inputSchema: { type: 'object', properties: {} }, run: async a => JSON.stringify(await call('POST', '/api/session/bind', { ...a, host_bridge: { pipe: process.env.CODEX_APP_TOOLS_PIPE_PATH, host_id: process.env.CODEX_APP_TOOLS_CALLER_HOST_ID } })) },
  { name: 'doc_review_next', description: '在当前聊天领取下一条批注或网页消息；返回选中文字、所在段落和要求。', inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', minimum: 0, maximum: 20 } } }, run: async a => JSON.stringify(await call('POST', '/api/session/next', a)) },
  { name: 'doc_review_finish', description: '完成已领取任务。批注任务应先写入 comment_reply。', inputSchema: { type: 'object', properties: { task_id: str('领取返回的任务 ID'), text: str('结果摘要'), error: str('失败原因，失败时填写') }, required: ['task_id'] }, run: async a => JSON.stringify(await call('POST', '/api/session/finish', a)) },
  { name: 'doc_review_release', description: '用户结束审阅时解除当前聊天绑定，以便另一条聊天使用。', inputSchema: { type: 'object', properties: {} }, run: async a => JSON.stringify(await call('POST', '/api/session/release', a)) },
  { name: 'doc_review_decide', description: '根据当前聊天中用户的明确决定接受或拒绝修订；block_id 留空表示全部。', inputSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['accept', 'reject'] }, block_id: str('段落 ID；留空表示全部修订') }, required: ['decision'] }, run: async a => {
    if (!['accept', 'reject'].includes(a.decision)) throw new Error('decision 应为 accept 或 reject');
    return JSON.stringify(await call('POST', a.block_id ? '/api/block/' + a.decision : '/api/' + a.decision + '-all', { id: a.block_id }));
  } }
);
for (const t of TOOLS) {
  t.inputSchema.properties.session_id = str('发起插件的 Codex 聊天 ID；从当前 shell 的 CODEX_THREAD_ID 或 CODEX_SESSION_ID 读取');
  t.inputSchema.required = [...(t.inputSchema.required || []), 'session_id'];
}
const out = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  try {
    if (m.method === 'initialize') return out({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'docreview', version: require('../.codex-plugin/plugin.json').version } } });
    if (m.method === 'ping') return out({ id: m.id, result: {} });
    if (m.method === 'tools/list') return out({ id: m.id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (m.method === 'tools/call') {
      const t = TOOLS.find(t => t.name === m.params.name); if (!t) return out({ id: m.id, error: { code: -32602, message: '未知工具' } });
      try { const a = m.params.arguments || {}; if (typeof a.session_id !== 'string' || !a.session_id.trim()) throw new Error('请提供当前 Codex 聊天 ID'); const result = await session.run({id:a.session_id}, async () => { await ensure(); if(t.name!=='doc_review_start')await refreshBridge(); return t.run(a); }); return out({ id: m.id, result: { content: [{ type: 'text', text: result }] } }); }
      catch (e) { return out({ id: m.id, result: { content: [{ type: 'text', text: '失败：' + e.message }], isError: true } }); }
    }
    out({ id: m.id, error: { code: -32601, message: 'method not found' } });
  } catch (e) { out({ id: m.id, error: { code: -32603, message: e.message } }); }
});
