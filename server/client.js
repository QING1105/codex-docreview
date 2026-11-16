'use strict';
const { spawn } = require('child_process'), path = require('path');
const sessionId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
if (!sessionId) throw new Error('请从发起审阅的 Codex 聊天中运行');
const name = process.argv[2], args = JSON.parse(process.argv[3] || '{}');
const child = spawn(process.execPath, [path.join(__dirname, 'mcp.js')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 35000);
require('readline').createInterface({ input: child.stdout }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: { ...args, session_id: sessionId } } }) + '\n');
  if (m.id === 2) {
    console.log(JSON.stringify(m.result || m.error));
    process.exitCode = m.error || m.result?.isError ? 1 : 0;
    clearTimeout(timer); child.kill();
  }
});
child.on('error', e => { clearTimeout(timer); console.error(e.message); process.exitCode = 1; });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'docreview-current-chat', version: require('../.codex-plugin/plugin.json').version } } }) + '\n');
