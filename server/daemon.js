'use strict';
// 本地服务：文档状态 + 批注队列 + Codex app-server 桥 + 网页
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { importDocx, importText, exportDocx, exportMarkdown, blockSegs, mergedOrder } = require('./docx');

const rich=require('./rich');
const clone=x=>structuredClone(x);
const content=b=>!!(b.text?.trim()||b.images?.length||b.rows?.length);
const sameContent=(a,b)=>a&&b&&['text','formats','images','rows','type','checked'].every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));
const { notifyThread } = require('./host-bridge');
const { randomUUID } = require('crypto');
let PORT = +(process.env.DOCREVIEW_PORT || 4517);
const DATA = process.env.DOCREVIEW_DATA || path.join(os.homedir(), '.codex-docreview');
fs.mkdirSync(DATA, { recursive: true });
const SF = path.join(DATA, 'state.json'), OF = path.join(DATA, 'original.docx');

let S = { mode: 'suggest', doc: null, blocks: [], baseline: [], comments: [], queue: [], seq: 0, paused: false, user: process.env.DOCREVIEW_USER || os.userInfo().username || 'Reviewer' };
try { S = Object.assign(S, JSON.parse(fs.readFileSync(SF, 'utf8'))); } catch { }
for (const q of S.queue) if (['running','queued'].includes(q.status)) {
  q.status = 'queued'; q.delivered = false; delete q.deliveryError; delete q.deliveryBlocked;
  q.deliveryId ||= randomUUID();
  q.deliveryGeneration = (q.deliveryGeneration || 0) + 1;
}
for (const c of S.comments) if (c.status === 'running') c.status = 'queued';
if (process.env.DOCREVIEW_INSTANCE_SESSION) S.sessionId = process.env.DOCREVIEW_INSTANCE_SESSION;
const agent = { status: 'idle', mode: 'current-session', threadId: S.sessionId || null, log: [], err: null };
const nid = p => p + (++S.seq);
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
// 将旧版整篇消息移入可见的批注记录，保留原队列 ID。
for (const q of S.queue) if (q.kind === 'message' && q.status !== 'done') {
  const c = { id: nid('c'), blockId: '__document__', quote: '', start: 0, text: q.text,
    author: S.user, date: now(), status: q.status === 'failed' ? 'failed' : 'queued', replies: [] };
  S.comments.push(c); q.kind = 'comment'; q.commentId = c.id;
}
const orig = () => { try { return fs.readFileSync(OF); } catch { return null; } };

if(S.doc?.kind==='docx' && !S.doc.sourceRevisionsLoaded && orig()) {
  const imported=importDocx(orig());
  for(const b of S.blocks){const source=imported.find(x=>x.src===b.src),base=S.baseline.find(x=>x.id===b.id);
    if(source?.sourceSegs&&base){b.sourceSegs=source.sourceSegs;b.originalText=source.originalText;base.sourceSegs=source.sourceSegs;base.originalText=source.originalText;base.text=source.originalText;}}
  // Paragraphs containing only deleted text were previously skipped.
  for(const source of imported)if(source.sourceSegs&&!S.blocks.some(b=>b.src===source.src)){
    const b={...source,id:nid('b')};let at=S.blocks.findIndex(x=>x.src>source.src);if(at<0)at=S.blocks.length;
    S.blocks.splice(at,0,b);S.baseline.splice(at,0,{...b,text:source.originalText});
  }
  S.doc.sourceRevisionsLoaded=true;
}

// Refresh imported paragraph classifications while retaining edits and annotations.
if(S.doc?.kind==='docx' && !S.doc.stylesResolved && orig()) {
  const types=new Map(importDocx(orig()).map(b=>[b.src,b.type]));
  for(const b of [...S.blocks,...S.baseline])
    if(!b.typeOverride && types.has(b.src)) b.type=types.get(b.src);
  S.doc.stylesResolved=true;
}

// ---------- 推送 ----------
const clients = new Set(); let saveT = null;
function view() {
  const order = S.doc ? mergedOrder(S) : [];
  return {
    doc: S.doc, mode: S.mode, user: S.user, paused: S.paused, comments: S.comments, queue: S.queue.slice(-50), agent,
    blocks: order.map(({ b, state }) => { const base = S.baseline.find(x => x.id === b.id); const ch = state === 'deleted' || !sameContent(base,b); return { id: b.id, formats:b.formats,images:b.images,rows:b.rows,layout:b.layout, text: b.text, type: b.type, prefix: b.prefix, checked: !!b.checked, locked: b.locked, state: state === 'deleted' ? 'deleted' : !base ? 'new' : ch ? 'changed' : 'same', segs: ch ? blockSegs(S, b, state) : null, author: b.author }; }),
  };
}
function emit(ev, data) { const s = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); }
function changed() { scheduleDispatch(); emit('state', view()); clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(SF, JSON.stringify(S), () => { }), 200); }
function log(role, text) { agent.log.push({ role, text, ts: Date.now() }); if (agent.log.length > 200) agent.log.shift(); }

// 网页提交直接投递给绑定的 Codex 聊天。
let dispatchContext = { pipe: process.env.CODEX_APP_TOOLS_PIPE_PATH, hostId: process.env.CODEX_APP_TOOLS_CALLER_HOST_ID };
let dispatchTimer = null, dispatchBusy = false, dispatchBlocked = false;
function scheduleDispatch(delay = 250) {
  if (process.env.DOCREVIEW_AUTODISPATCH === '0' || dispatchTimer || dispatchBlocked) return;
  dispatchTimer = setTimeout(() => { dispatchTimer = null; dispatchPending(); }, delay);
}
async function dispatchPending() {
  if (dispatchBusy || S.paused || !S.sessionId) return;
  const pending = S.queue.filter(q => q.status === 'queued' && !q.delivered);
  if (!pending.length) return;
  dispatchBusy = true;
  const sessionId=S.sessionId;
  const texts = pending.map(q=>q.kind==='comment'?`批注 ${q.commentId}：${cm(q.commentId).text}`:q.text).join('\n');
  try {
    await notifyThread({ ...dispatchContext, threadId:sessionId, callId:'docreview-'+sessionId+'-'+pending.map(q=>q.deliveryId+'g'+(q.deliveryGeneration||0)).join('-'),
      prompt:`【Doc Review 网页提交】${texts}\n请在这条聊天使用 $doc-review 立即领取并处理批注队列，逐条写回 comment_reply 并完成任务。回复显示在网页批注弹窗中。` });
    if(S.sessionId===sessionId)for(const q of pending){q.delivered=true;delete q.deliveryError;delete q.deliveryBlocked;}
    agent.err=null;
  } catch(e) { dispatchBlocked=['EPERM','EACCES'].includes(e.code);for(const q of pending){q.deliveryError=e.message;q.deliveryBlocked=dispatchBlocked;}agent.err=(dispatchBlocked?'自动投递权限受阻：':'自动投递正在重试：')+e.message; }
  finally { dispatchBusy=false;emit('state',view());clearTimeout(saveT);saveT=setTimeout(()=>fs.writeFile(SF,JSON.stringify(S),()=>{}),200);
    if(S.queue.some(q=>q.status==='queued'&&!q.delivered))scheduleDispatch(5000);
  }
}

// ---------- 文档操作 ----------
function openDoc(name, buf) {
  if (S.queue.some(q => q.status === 'running')) throw new Error('请先完成当前批注，再切换文档');
  const isDocx = /\.docx$/i.test(name), raw = isDocx ? importDocx(buf) : importText(buf.toString('utf8'));
  if (isDocx) fs.writeFileSync(OF, buf); else fs.rmSync(OF, { force: true });
  S.seq = 0; S.blocks = raw.map(b => Object.assign({ id: nid('b') }, b)); S.baseline = S.blocks.map(b => ({ ...clone(b), text:b.originalText ?? b.text }));
  S.comments = []; S.queue = []; S.doc = { title: name.replace(/\.[^.]+$/, ''), name, kind: isDocx ? 'docx' : 'text', sourceRevisionsLoaded:true, stylesResolved:true };
  agent.log = []; changed();
}
const blk = id => S.blocks.find(b => b.id === id);
function editBlock(id, text, author) { noView(author); const clean0 = !hasRev(id); const b = blk(id); if (!b) throw new Error('没有这个段落：' + id); if (b.locked) throw new Error(id + ' 含图片/脚注/域，已锁定，不能改'); if (typeof text !== 'string' || !text.trim()) throw new Error('内容不能为空；要删除请用删除'); rich.remapFormats(b,text); b.text = text; b.author = author; if (direct(author, clean0)) commit([id]); else changed(); return b; }
function insertBlock(afterId, text, type, author) { noView(author); const i = afterId ? S.blocks.findIndex(b => b.id === afterId) : -1; if (afterId && i < 0) throw new Error('没有这个段落：' + afterId); const b = { id: nid('b'), text, type: type || 'p', author }; if (b.type === 'li') b.prefix = '• '; S.blocks.splice(i + 1, 0, b); if (direct(author, true) && content(b)) commit([b.id]); else changed(); return b; }
function deleteBlock(id, author) { noView(author); const clean0 = !hasRev(id); const i = S.blocks.findIndex(b => b.id === id); if (i < 0) throw new Error('没有这个段落：' + id); if (S.blocks[i].locked) throw new Error(id + ' 已锁定，不能删'); S.blocks.splice(i, 1); const bb = S.baseline.find(x => x.id === id); if (bb) bb.delAuthor = author; if (!bb) return changed(); if (direct(author, clean0)) commit([id]); else changed(); }
function restoreBlock(id) { const bi = S.baseline.findIndex(x => x.id === id); if (bi < 0) throw new Error('基线里没有 ' + id); if (blk(id)) { S.blocks[S.blocks.findIndex(b=>b.id===id)]=clone(S.baseline[bi]); return changed(); } let at = 0; for (let k = bi - 1; k >= 0; k--) { const j = S.blocks.findIndex(b => b.id === S.baseline[k].id); if (j >= 0) { at = j + 1; break; } } const { delAuthor, ...b } = S.baseline[bi]; S.blocks.splice(at, 0, b); changed(); }
// 接受指定段落的修订：把它们并进基线。来源是 .docx 时同时写回原文件，保住样式和锚点。
function commit(ids) {
  const set = new Set(ids), nb = [];
  for (const { b, state } of mergedOrder(S)) {
    const base = S.baseline.find(x => x.id === b.id);
    if (set.has(b.id)) { if (state !== 'deleted' && content(b)) { const { delAuthor, sourceSegs, originalText, ...c } = b; nb.push(clone(c)); } }
    else if (base) { const { delAuthor, ...c } = base; nb.push(clone(c)); }
  }
  if (S.doc.kind === 'docx' && orig()) {
    const clean = exportDocx({ ...S, baseline: S.baseline, blocks: nb }, orig(), { clean: true }), re = importDocx(clean);
    if (re.length === nb.length && re.every((r, i) => r.text === nb[i].text)) {
      fs.writeFileSync(OF, clean);
      nb.forEach((x, i) => { x.src = re[i].src; x.sourceTable=re[i].sourceTable; x.locked = re[i].locked; if(set.has(x.id)){delete x.sourceSegs; delete x.originalText;} const live = blk(x.id); if (live) { live.src = x.src; live.sourceTable=x.sourceTable; live.locked = x.locked; if(set.has(x.id)){delete live.sourceSegs; delete live.originalText;} } });
    } else { throw new Error('文档结构核对未通过，原 Word 已保留；请保留当前修订后继续编辑。'); }
  }
  for (const b of S.blocks) delete b.delAuthor;
  S.baseline = nb; changed();
}
function acceptAll() { commit(mergedOrder(S).map(o => o.b.id)); }
function rejectAll() { S.blocks = S.baseline.map(({ delAuthor, ...b }) => (clone(b))); S.baseline.forEach(b => delete b.delAuthor); changed(); }
function hasRev(id) { const b = blk(id), base = S.baseline.find(x => x.id === id); if (!base) return !(b && !b.text.trim()); return !sameContent(base,b); }
// 编辑模式下，你自己的改动直接生效（不留修订）；段落里已有未处理的修订时仍记为修订，免得顺手把 Codex 的改动也接受了
const direct = (author, wasClean) => S.mode === 'edit' && author !== 'Codex' && wasClean;
const noView = author => { if (S.mode === 'view' && author !== 'Codex') throw new Error('当前是查看模式，只能批注'); };
const cm = id => { const c = S.comments.find(c => c.id === id); if (!c) throw new Error('没有这条批注：' + id); return c; };
function addComment({ blockId, quote, start, text, send }) { if (!blockId || !text) throw new Error('缺少段落或批注内容'); const c = { id: nid('c'), blockId, quote: quote || '', start: start || 0, text, author: S.user, date: now(), status: 'draft', replies: [] }; S.comments.push(c); if (send) enqueueComment(c); else changed(); return c; }
function enqueueComment(c) { if (S.queue.some(q => q.commentId === c.id && (q.status === 'queued' || q.status === 'running'))) return; c.status = 'queued'; c.answered = false; S.queue.push({ id: nid('q'), deliveryId:randomUUID(), kind: 'comment', commentId: c.id, status: 'queued' }); changed(); }
function reply(id, text, author, resolve) { const c = cm(id); c.replies.push({ author: author || 'Codex', text, date: now() }); if (author === 'Codex' || !author) { c.answered = true; if (c.status !== 'resolved') c.status = 'answered'; } if (resolve) c.status = 'resolved'; changed(); return c; }
function readForAgent() {
  const L = [`文档《${S.doc ? S.doc.title : '(未打开)'}》 共 ${S.blocks.length} 段。格式：[段落ID|类型] 内容`];
  for (const b of S.blocks) L.push(`[${b.id}|${b.type}${b.locked ? '|locked' : ''}] ${b.text}`);
  const open = S.comments.filter(c => c.status !== 'resolved');
  if (open.length) { L.push('', '未解决批注：'); for (const c of open) L.push(`(${c.id}) 段落 ${c.blockId}，选中「${c.quote}」：${c.text}`); }
  return L.join('\n');
}

// ---------- 当前聊天领取队列；模型和权限批准由宿主 Codex 管理 ----------
function requireSession(id) {
  if (!id || id !== S.sessionId) throw new Error('请在发起审阅的聊天中调用 doc_review_start，再继续处理。');
}
function refreshBridge(bridge) {
  if (!bridge?.pipe) return;
  const renewed = dispatchContext.pipe !== bridge.pipe || dispatchContext.hostId !== bridge.host_id;
  dispatchContext = { pipe:bridge.pipe, hostId:bridge.host_id };
  if (renewed) dispatchBlocked=false;
  if (renewed && dispatchTimer) { clearTimeout(dispatchTimer); dispatchTimer = null; }
  scheduleDispatch();
}
async function bindSession(id, bridge) {
  if(process.env.DOCREVIEW_INSTANCE_SESSION && id!==process.env.DOCREVIEW_INSTANCE_SESSION)throw new Error('这个审阅页属于另一条聊天，请在当前聊天调用 doc_review_start 获取独立页面。');
  if (typeof id !== 'string' || !id.trim()) throw new Error('需要当前 Codex 聊天 ID');
  if (S.sessionId && S.sessionId !== id) throw new Error('文档已绑定另一条聊天；请在原聊天中释放审阅后再启动。');
  // Probe from the daemon itself: an accessible caller may be reusing a sandbox-owned daemon.
  if(bridge?.pipe&&process.env.DOCREVIEW_AUTODISPATCH!=='0')await require('./host-bridge').checkConnection(bridge.pipe);
  refreshBridge(bridge);
  S.sessionId = id; agent.threadId = id; changed();
  return { session_id: id, url: `http://127.0.0.1:${PORT}/`, mode: 'current-session' };
}
async function nextTask(b) {
  requireSession(b.session_id);
  const deadline = Date.now() + Math.max(0, Math.min(20, Number(b.wait_seconds) || 0)) * 1000;
  do {
    requireSession(b.session_id);
    if (S.paused) return { paused: true };
    const running = S.queue.find(q => q.status === 'running');
    const q = running || S.queue.find(q => q.status === 'queued');
    if (q) {
      if (q.kind === 'comment' && !S.comments.some(c => c.id === q.commentId)) { q.status = 'failed'; changed(); continue; }
      q.status = 'running';
      if (q.kind === 'comment') cm(q.commentId).status = 'running';
      agent.status = 'running'; changed();
      return { task_id: q.id, resumed: !!running, prompt: promptFor(q) };
    }
    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 200));
  } while (true);
  return { idle: true, message: '队列为空，后续网页提交会自动触发当前聊天处理。' };
}
function finishTask(b) {
  requireSession(b.session_id);
  const q = S.queue.find(q => q.id === b.task_id);
  if (!q) throw new Error('任务已结束或文档已切换，请重新读取队列');
  if (q.status === 'done') return { ok: true, already_done: true };
  if (q.status !== 'running') throw new Error('请先领取任务');
  if (q.kind === 'comment' && !b.error && !cm(q.commentId).answered) throw new Error('请先调用 comment_reply 写回批注回复');
  q.status = b.error ? 'failed' : 'done'; q.error = b.error || null;
  if (q.kind === 'comment') cm(q.commentId).status = b.error ? 'failed' : 'answered';
  if (b.text) log('agent', b.text);
  agent.status = 'idle'; changed(); return { ok: true };
}
function promptFor(q) {
  if (q.kind === 'message') return q.text + '\n\n（当前在文档批注页里。读文档用 docreview 的 doc_read，改文档只用 doc_edit_block / doc_insert_block / doc_delete_block。）';
  const c = cm(q.commentId), b = blk(c.blockId);
  return `[文档批注 ${c.id}] 文档《${S.doc.title}》\n段落 ${c.blockId}${b ? `（${b.type}${b.locked ? '，locked 不可改' : ''}）当前内容：\n${b.text}` : c.blockId === '__document__' ? '（整篇文档；需要全文时调用 doc_read）' : '（该段已被删除）'}\n选中文字：「${c.quote}」\n批注：${c.text}\n已有回复（按时间顺序）：\n${c.replies.map(r => `${r.author}：${r.text}`).join("\n")}\n\n结合已有回复，处理用户最新的要求。请处理这条批注。需要改文就用 docreview 的 doc_edit_block / doc_insert_block / doc_delete_block，只改必要处，其余文字逐字保留；需要上下文用 doc_read。处理完必须调用 comment_reply(comment_id="${c.id}", text=一两句话说明你改了什么或你的回答)。不要改磁盘上的任何文件。`;
}
// ---------- HTTP ----------
const body = req => new Promise((res, rej) => { const ch = []; let n = 0; req.on('data', d => { n += d.length; if (n > 80e6) { rej(new Error('文件太大')); req.destroy(); } else ch.push(d); }); req.on('end', () => { try { res(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { rej(new Error('请求不是合法 JSON')); } }); });
function changeRich(id,fn){noView();const b=blk(id);if(!b||b.locked)throw Error('请选择可编辑内容');const clean=!hasRev(id);fn(b);b.author=S.user;if(direct(S.user,clean))commit([id]);else changed();return b}
function targetCell(b,row,col){if(row===undefined)return b;if(!b.rows?.[row]?.[col])throw Error('请选择表格单元格');return b.rows[row][col]}
function formatPatch(input){const out={};for(const [k,v]of Object.entries(input||{})){if(['bold','italic','underline','strike'].includes(k))out[k]=!!v;else if(['font','eastAsia'].includes(k)&&typeof v==='string'&&v.length<=100&&!/[<>;\x00-\x1f]/.test(v))out[k]=v;else if(k==='size'&&+v>=6&&+v<=96)out[k]=+v;else if(['color','highlight'].includes(k)&&/^#[a-f0-9]{6}$/i.test(v))out[k]=v;else if(k==='color'&&v==='auto')out[k]=v;else if(k==='highlight'&&v==='transparent')out[k]=v;else throw Error('文字格式值无效')}return out}
function insertObject(afterId,obj){noView();const i=afterId?S.blocks.findIndex(x=>x.id===afterId):-1;if(afterId&&i<0)throw Error('插入位置已改变');const b={id:nid('b'),author:S.user,...obj};S.blocks.splice(i+1,0,b);if(S.mode==='edit')commit([b.id]);else changed();return b}
const routes = {
  'GET /api/ping': () => ({ ok: true, app: 'docreview', version: require('../.codex-plugin/plugin.json').version, mode: 'current-session', instance_key: process.env.DOCREVIEW_INSTANCE_KEY }),
  'GET /api/state': () => view(),
  'POST /api/session/bind': b => bindSession(b.session_id, b.host_bridge),
  'POST /api/session/bridge': b => { requireSession(b.session_id); refreshBridge(b.host_bridge); return { ok:true }; },
  'POST /api/session/next': b => nextTask(b),
  'POST /api/session/finish': b => finishTask(b),
  'POST /api/session/release': b => { requireSession(b.session_id); if (S.queue.some(q => q.status === 'running')) throw new Error('请先完成当前批注'); S.sessionId = null; agent.threadId = null; changed(); return { ok: true }; },
  // start.cmd 看到退出码 75 会自动重新拉起服务，用来更新代码
  'POST /api/restart': () => { setTimeout(() => { try { fs.writeFileSync(SF, JSON.stringify(S)); } catch { } process.exit(75); }, 200); return { ok: true }; },
  'GET /api/read': () => ({ text: readForAgent() }),
  'POST /api/open': b => { if (b.path) openDoc(path.basename(b.path), fs.readFileSync(b.path)); else openDoc(b.name, Buffer.from(b.b64, 'base64')); return { ok: true, blocks: S.blocks.length, url: `http://127.0.0.1:${PORT}/` }; },
  'POST /api/comments': b => addComment(b),
  'POST /api/comment/send': b => { enqueueComment(cm(b.id)); return { ok: true }; },
  'POST /api/comment/send-all': () => { S.comments.filter(c => c.status === 'draft' || c.status === 'failed').forEach(enqueueComment); return { ok: true }; },
  'POST /api/comment/followup': b => { const c = cm(b.id); if (typeof b.text !== 'string' || !b.text.trim()) throw new Error('请填写回复内容'); if (S.queue.some(q => q.commentId === c.id && ['queued', 'running'].includes(q.status))) throw new Error('这条批注正在处理中，请等待回复'); reply(c.id, b.text.trim(), S.user, false); enqueueComment(c); return { ok: true }; },
  'POST /api/comment/reply': b => reply(b.id, b.text, b.author, b.resolve),
  'POST /api/comment/resolve': b => { cm(b.id).status = b.reopen ? 'answered' : 'resolved'; changed(); return { ok: true }; },
  'POST /api/comment/delete': b => { if (S.queue.some(q => q.commentId === b.id && q.status === 'running')) throw new Error('请先完成当前批注'); S.comments = S.comments.filter(c => c.id !== b.id); S.queue = S.queue.filter(q => !(q.commentId === b.id && q.status === 'queued')); changed(); return { ok: true }; },
  'POST /api/block/edit': b => editBlock(b.id, b.text, b.author || S.user),
  'POST /api/block/insert': b => insertBlock(b.afterId, b.text, b.type, b.author || S.user),
  'POST /api/block/delete': b => { deleteBlock(b.id, b.author || S.user); return { ok: true }; },
  'POST /api/block/restore': b => { restoreBlock(b.id); return { ok: true }; },
  'POST /api/accept-all': () => { acceptAll(); return { ok: true }; },
  'POST /api/reject-all': () => { rejectAll(); return { ok: true }; },
  'POST /api/block/accept': b => { commit([b.id]); return { ok: true }; },
  'POST /api/block/reject': b => { if (S.baseline.some(x => x.id === b.id)) restoreBlock(b.id); else { S.blocks = S.blocks.filter(x => x.id !== b.id); changed(); } return { ok: true }; },
  'POST /api/block/type': b => { noView(); const x = blk(b.id); if (!x) throw new Error('没有这个段落'); if (x.locked) throw new Error('这一段已锁定'); if(!['p','h1','h2','h3','h4','h5','h6','li','todo','code'].includes(b.type)||['image','table'].includes(x.type))throw Error('请选择文字段落');x.type = b.type; x.typeOverride = true; x.prefix = b.type === 'li' ? (x.prefix || '• ') : undefined; const base = S.baseline.find(y => y.id === b.id); if (base) { base.type = x.type; base.typeOverride = true; base.prefix = x.prefix; } changed(); return { ok: true }; },
  'POST /api/format': p => changeRich(p.id,b=>{const t=targetCell(b,p.row,p.col);rich.applyFormat(t,p.start,p.end,formatPatch(p.style));if(b.rows)b.tableChanged=true}),
  'POST /api/table/insert': p => {const rows=Number(p.rows),cols=Number(p.cols);if(!Number.isInteger(rows)||!Number.isInteger(cols)||rows<1||rows>30||cols<1||cols>12)throw Error('表格支持 1–30 行、1–12 列');const cells=Array.from({length:rows},()=>Array.from({length:cols},()=>({text:'',formats:[]})));return insertObject(p.afterId,{type:'table',text:rich.tableText(cells),rows:cells,tableChanged:true})},
  'POST /api/table/cell': p => changeRich(p.id,b=>{const c=targetCell(b,p.row,p.col);if(typeof p.text!=='string')throw Error('请输入单元格内容');rich.remapFormats(c,p.text);c.text=p.text;b.text=rich.tableText(b.rows);b.tableChanged=true}),
  'POST /api/image/insert': p => {if(typeof p.data!=='string'||p.data.length>16000000||!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(p.data))throw Error('请选择小于 12 MB 的 PNG、JPEG、GIF 或 WebP 图片');return insertObject(p.afterId,{type:'image',text:'',images:[{data:p.data,width:Math.max(20,Math.min(900,+p.width||320)),height:Math.max(20,Math.min(1200,+p.height||180)),alt:String(p.alt||'图片').slice(0,200)}]})},
  'POST /api/image/delete': p => {const b=blk(p.id);if(!b?.images?.[p.index])throw Error('图片已移除');if(b.images.length===1&&!b.text.trim()){deleteBlock(p.id,S.user);return {ok:true}}return changeRich(p.id,b=>{b.images.splice(p.index,1);b.imagesChanged=true})},
  'POST /api/block/check': b => { noView(); const x=blk(b.id); if(!x || x.type!=='todo') throw new Error('请选择待办项'); x.checked=!!b.checked; changed(); return {ok:true}; },
  'POST /api/fonts': b => { if (!S.doc) throw new Error('请先打开文档'); for (const f of [b.latin, b.east_asia]) if (typeof f !== 'string' || !f.trim() || f.length > 100 || /[\x00-\x1f]/.test(f)) throw new Error('请提供有效字体名称'); S.doc.fonts = { latin: b.latin.trim(), eastAsia: b.east_asia.trim() };for(const x of S.blocks){for(const t of x.rows?x.rows.flat():[x])if(t.text.length)rich.applyFormat(t,0,t.text.length,{font:S.doc.fonts.latin,eastAsia:S.doc.fonts.eastAsia});if(x.rows)x.tableChanged=true} changed(); return { ok: true, fonts: S.doc.fonts }; },
  'POST /api/mode': b => { if (!['edit', 'suggest', 'view'].includes(b.mode)) throw new Error('未知模式'); S.mode = b.mode; changed(); return { ok: true }; },
  'POST /api/chat': b => addComment({ blockId: '__document__', text: b.text, send: true }),
  'POST /api/queue': b => { if (b.action === 'pause') S.paused = true; if (b.action === 'resume') { S.paused = false; } if (b.action === 'clear') { S.queue.filter(q => q.status === 'queued').forEach(q => { const c = S.comments.find(c => c.id === q.commentId); if (c) c.status = 'draft'; }); S.queue = S.queue.filter(q => q.status !== 'queued'); } if (b.action === 'interrupt') { S.paused = true; } changed(); return { ok: true }; },
  'POST /api/export': b => { const out = b.path || path.join(DATA, (S.doc.title || 'document') + '-修订.docx'); fs.writeFileSync(out, exportDocx(S, orig())); return { ok: true, path: out }; },
};
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), key = req.method + ' ' + u.pathname;
  const host = (req.headers.host || '').split(':')[0], og = req.headers.origin;
  if (!['127.0.0.1', 'localhost'].includes(host) || (og && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(og))) { res.writeHead(403); return res.end('forbidden'); }
  try {
    if (key === 'GET /') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'))); }
    if (key === 'GET /api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); res.write(`event: state\ndata: ${JSON.stringify(view())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (key === 'GET /api/export.docx' || key === 'GET /api/export.md' || key === 'GET /api/export-clean.docx') {
      if (!S.doc) throw new Error('还没打开文档'); const md = key.endsWith('.md'), cl = key.includes('clean'), name = encodeURIComponent(S.doc.title + (md ? '.md' : cl ? '-清洁稿.docx' : '-修订.docx'));
      res.writeHead(200, { 'Content-Type': md ? 'text/markdown; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename*=UTF-8''${name}` });
      return res.end(md ? exportMarkdown(S.blocks) : exportDocx(S, orig(), cl ? { clean: true } : undefined));
    }
    const h = routes[key]; if (!h) { res.writeHead(404); return res.end('not found'); }
    if (req.headers['x-docreview-session'] && key !== 'POST /api/session/bind') requireSession(req.headers['x-docreview-session']);
    const out = await h(req.method === 'POST' ? await body(req) : {});
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(out));
  } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: e.message })); }
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用（可能已经在运行）` : e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => { PORT=server.address().port;if(process.env.DOCREVIEW_INSTANCE_KEY)fs.writeFileSync(path.join(DATA,'endpoint.json'),JSON.stringify({port:PORT,pid:process.pid}));console.log(`Doc Review: http://127.0.0.1:${PORT}/`);scheduleDispatch(); });
process.on('exit', () => { try { fs.writeFileSync(SF, JSON.stringify(S)); } catch { } });
process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
