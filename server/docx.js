'use strict';
const { zip, unzip } = require('./zip');
const { diff } = require('./diff');
const rich = require('./rich');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

// ---------- 读取 ----------
// 找出最外层段落的位置；含嵌套段落（文本框等）的标 nested，不动它
function scanParas(xml) {
  const re = /<w:p(?:\s[^>]*?)?(\/)?>|<\/w:p>/g, out = []; let m, depth = 0, cur = null;
  while ((m = re.exec(xml))) {
    if (m[0] === '</w:p>') { depth--; if (depth === 0 && cur) { cur.end = re.lastIndex; out.push(cur); cur = null; } }
    else if (m[1]) { if (depth === 0) out.push({ start: m.index, end: re.lastIndex, empty: true }); }
    else { if (depth === 0) cur = { start: m.index, nested: false }; else if (cur) cur.nested = true; depth++; }
  }
  return out;
}
function paraText(px) {
  const body = px.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '');
  let s = ''; const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g; let m;
  while ((m = re.exec(body))) s += m[1] !== undefined ? unesc(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n';
  return s;
}
const LOCK = /<w:drawing|<w:pict|<w:object|<w:fldChar|<w:fldSimple|<w:footnoteReference|<w:endnoteReference|<m:oMath|<w:sdt[ >]|<mc:AlternateContent/;
const valOf = (xml, tag) => {
  const element = xml.match(new RegExp('<w:' + tag + '\\b[^>]*>'));
  return element ? (element[0].match(/\bw:val="([^"]*)"/) || [])[1] : undefined;
};
const currentProps = xml => xml.replace(/<w:pPrChange\b[^>]*>[\s\S]*?<\/w:pPrChange>/g, '').match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/)?.[0] || '';
function paragraphStyles(xml) {
  const styles = new Map();
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    if (!/\bw:type="paragraph"/.test(m[1])) continue;
    const id = m[1].match(/\bw:styleId="([^"]*)"/)?.[1];
    if (id) styles.set(id, { name:valOf(m[2],'name'), parent:valOf(m[2],'basedOn'), props:currentProps(m[2]) });
  }
  return styles;
}
function paraType(px, styles) {
  const props = currentProps(px), st = valOf(props,'pStyle') || '';
  const chain = [], seen = new Set();
  for (let id=st; id && !seen.has(id) && styles.has(id); id=styles.get(id).parent) {
    seen.add(id); chain.push(styles.get(id));
  }
  // Style IDs are arbitrary identifiers; numeric IDs do not denote heading levels.
  const outline = [props,...chain.map(s=>s.props)].map(p=>valOf(p,'outlineLvl')).find(v=>v!==undefined);
  if (outline !== undefined) return /^[0-8]$/.test(outline) ? 'h'+Math.min(+outline+1,6) : /<w:numPr\b/.test(props) ? 'li' : 'p';
  for (const name of chain.length ? chain.map(s=>s.name || '') : [st]) {
    const h = name.match(/^(?:heading|标题)\s*([1-9])$/i);
    if (h) return 'h'+Math.min(+h[1],6);
    if (/^title$/i.test(name)) return 'h1';
  }
  if ([props,...chain.map(s=>s.props)].some(p=>/<w:numPr\b/.test(p))) return 'li';
  return 'p';
}
function revisionSegments(px) {
  px=px.replace(/<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>/g,'').replace(/<w:rPrChange\b[^>]*>[\s\S]*?<\/w:rPrChange>/g,'');
  const segs=[],stack=[];
  const token=/<w:(ins|del|moveFrom|moveTo)\b([^>]*?)>|<\/w:(ins|del|moveFrom|moveTo)>|<w:(t|delText)(?:\s[^>]*)?>([\s\S]*?)<\/w:\4>|<w:(tab|br|cr)\s*\/>/g;
  let m;
  while((m=token.exec(px))){
    if(m[1]){if(!m[2].endsWith('/'))stack.push(m[1]);continue}
    if(m[3]){stack.pop();continue}
    const state=stack.at(-1), t=m[4]==='delText'||state==='del'||state==='moveFrom'?'del':state==='ins'||state==='moveTo'?'ins':'eq';
    const s=m[4]?unesc(m[5]):m[6]==='tab'?'\t':'\n';
    if(segs.at(-1)?.t===t)segs.at(-1).s+=s;else segs.push({t,s});
  }
  return segs;
}
function importDocx(buf) {
  const files = unzip(buf), d = files.find(f => f.name === 'word/document.xml');
  if (!d) throw new Error('docx 里没有 word/document.xml');
  const xml = d.data.toString('utf8'), blocks = [];
  const richContext=rich.context(files), sourceTables=rich.tables(xml,richContext);
  const styles = paragraphStyles(files.find(f=>f.name==='word/styles.xml')?.data.toString('utf8') || '');
  scanParas(xml).forEach((p, i) => {
    const table=sourceTables.find(t=>p.start>=t.start&&p.end<=t.end);
    if(table){if(!blocks.some(b=>b.sourceTable===table.index))blocks.push({text:rich.tableText(table.rows),type:'table',rows:table.rows,tableProperties:table.properties,tableGrid:table.grid,layout:table.layout,sourceTable:table.index,src:i,locked:false});return}
    if (p.empty) return; const px = xml.slice(p.start,p.end), segs=revisionSegments(px);
    const detail=rich.paragraph(px,richContext);
    const todo=segs[0]?.s.match(/^[☐☑] /);if(todo)segs[0].s=segs[0].s.slice(2);
    const text=segs.filter(g=>g.t!=='del').map(g=>g.s).join(''), originalText=segs.filter(g=>g.t!=='ins').map(g=>g.s).join('');
    if(!text.trim()&&!originalText.trim()&&!detail.images.length)return;
    if(todo)detail.formats=detail.formats.map(f=>({...f,start:Math.max(0,f.start-2),end:Math.max(0,f.end-2)})).filter(f=>f.end>f.start);
    const revisions=segs.some(g=>g.t!=='eq');
    blocks.push({...detail,text,type:!text&&!originalText&&detail.images.length?'image':todo?'todo':paraType(px,styles),...(todo?{checked:todo[0][0]==='☑'}:{}),src:i,locked:!!(p.nested||LOCK.test(px.replace(/<w:drawing[\s\S]*?<\/w:drawing>/g,''))),...(revisions?{sourceSegs:segs,originalText}:{})});
  });
  return blocks;
}

// ---------- 文本类 ----------
function importText(src) {
  const blocks = [], lines = src.replace(/\r\n?/g, '\n').split('\n'); let para = [], code = null;
  const flush = () => { if (para.length) { blocks.push({ text: para.join('\n'), type: 'p' }); para = []; } };
  for (const ln of lines) {
    if (code) { if (/^```/.test(ln)) { blocks.push({ text: code.join('\n'), type: 'code' }); code = null; } else code.push(ln); continue; }
    let m;
    if (/^```/.test(ln)) { flush(); code = []; }
    else if ((m = ln.match(/^\s*[-*+] \[([ xX])\] (.*)$/))) { flush(); blocks.push({text:m[2],type:'todo',checked:m[1].toLowerCase()==='x'}); }
    else if ((m = ln.match(/^(#{1,6})\s+(.*)$/))) { flush(); blocks.push({ text: m[2].trim(), type: 'h' + Math.min(m[1].length, 6) }); }
    else if ((m = ln.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) { flush(); blocks.push({ text: m[2], type: 'li', prefix: /\d/.test(m[1]) ? m[1] + ' ' : '• ' }); }
    else if (!ln.trim()) flush();
    else para.push(ln);
  }
  if (code) blocks.push({ text: code.join('\n'), type: 'code' });
  flush(); return blocks;
}
function exportMarkdown(blocks) {
  return blocks.map(b => /^h\d$/.test(b.type) ? '#'.repeat(+b.type[1]) + ' ' + b.text : b.type === 'todo' ? '- ['+(b.checked?'x':' ')+'] '+b.text : b.type === 'li' ? (b.prefix && /\d/.test(b.prefix) ? b.prefix : '- ') + b.text : b.type === 'code' ? '```\n' + b.text + '\n```' : b.text).join('\n\n') + '\n';
}

// ---------- 修订 run ----------
function mkCtx(S, opt) { return { clean: !!(opt && opt.clean), rev: 90000, date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), user: S.user || 'Reviewer', comments: [], images:[] }; }
function imageRuns(b,ctx){return (b.images||[]).map(img=>{const i=ctx.images.push(img)-1;return `<!--DOCREVIEW_IMAGE_${i}-->`}).join('')}
function finishMedia(files,ctx){const write=rich.mediaWriter(files),d=files.find(f=>f.name==='word/document.xml');d.data=Buffer.from(d.data.toString().replace(/<!--DOCREVIEW_IMAGE_(\d+)-->/g,(_,i)=>write(ctx.images[+i])));return zip(files)}
function tRun(text, rPr, del) {
  const tag = del ? 'w:delText' : 'w:t';
  return '<w:r>' + rPr + text.split('\n').map(x => x ? `<${tag} xml:space="preserve">${esc(x)}</${tag}>` : '').join('<w:br/>') + '</w:r>';
}
// segs: diff 结果；marks: [{off, xml}]，off 是"当前文本"里的偏移（Infinity = 段尾）
function runsXml(segs, rPr, author, ctx, marks) {
  marks = (marks || []).slice().sort((a, b) => a.off - b.off); let out = '', pos = 0, mi = 0;
  const attr = () => `w:id="${ctx.rev++}" w:author="${esc(author)}" w:date="${ctx.date}"`;
  const flushMarks = at => { while (mi < marks.length && marks[mi].off <= at) out += marks[mi++].xml; };
  for (const g of segs) {
    const rp = g.rPr !== undefined ? g.rPr : rPr;
    if (g.t === 'del') { if (ctx.clean) continue; flushMarks(pos); out += `<w:del ${attr()}>${tRun(g.s, rp, true)}</w:del>`; continue; }
    let s = g.s;
    while (s.length) {
      flushMarks(pos);
      const next = mi < marks.length ? marks[mi].off : Infinity, take = Math.min(s.length, next - pos), piece = s.slice(0, take);
      out += g.t === 'ins' && !ctx.clean ? `<w:ins ${attr()}>${tRun(piece, rp)}</w:ins>` : tRun(piece, rp);
      s = s.slice(take); pos += take;
    }
  }
  while (mi < marks.length) out += marks[mi++].xml;
  return out;
}
function commentMarks(S, ctx, blockId, text, deleted) {
  const marks = []; if (ctx.clean) return marks;
  for (const c of S.comments.filter(c => c.blockId === blockId)) {
    const id = ctx.cbase + ctx.comments.length; ctx.comments.push({ id, c });
    let a = 0, b = Infinity;
    if (!deleted && c.quote) { let i = text.indexOf(c.quote, Math.max(0, (c.start || 0) - 20)); if (i < 0) i = text.indexOf(c.quote); if (i >= 0) { a = i; b = i + c.quote.length; } }
    marks.push({ off: a, xml: `<w:commentRangeStart w:id="${id}"/>` }, { off: b, xml: `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>` });
  }
  return marks;
}
function commentsBody(ctx) {
  return ctx.comments.map(({ id, c }) => {
    const ps = [`<w:p><w:r><w:t xml:space="preserve">${esc(c.text)}</w:t></w:r></w:p>`]
      .concat((c.replies || []).map(r => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(r.author)}：</w:t></w:r><w:r><w:t xml:space="preserve">${esc(r.text)}</w:t></w:r></w:p>`));
    return `<w:comment w:id="${id}" w:author="${esc(c.author || ctx.user)}" w:date="${esc(c.date || ctx.date)}" w:initials="R">${ps.join('')}</w:comment>`;
  }).join('');
}
// 把已删除的基线段落按原位置插回当前顺序里
function mergedOrder(S) {
  const cur = new Set(S.blocks.map(b => b.id)), res = S.blocks.map(b => ({ b, state: 'live' }));
  let head = 0;
  S.baseline.forEach((bb, i) => {
    if (cur.has(bb.id)) return;
    const prev = i > 0 ? S.baseline[i - 1].id : null, at = prev ? res.findIndex(r => r.b.id === prev) : -1;
    if (at >= 0) res.splice(at + 1, 0, { b: bb, state: 'deleted' }); else res.splice(head++, 0, { b: bb, state: 'deleted' });
  });
  return res;
}
function blockSegs(S, b, state) {
  const base = S.baseline.find(x => x.id === b.id);
  if (state === 'deleted') return [{ t: 'del', s: b.text }];
  if (!base) return [{ t: 'ins', s: b.text }];
  if(b.sourceSegs && b.text===b.sourceSegs.filter(g=>g.t!=='del').map(g=>g.s).join(''))return b.sourceSegs;
  return diff(base.text, b.text);
}
const markIns = (ctx, a) => ctx.clean ? '' : `<w:rPr><w:ins w:id="${ctx.rev++}" w:author="${esc(a)}" w:date="${ctx.date}"/></w:rPr>`;
const markDel = (ctx, a) => `<w:rPr><w:del w:id="${ctx.rev++}" w:author="${esc(a)}" w:date="${ctx.date}"/></w:rPr>`;

// 原段落若只由普通 run 组成，就按原 run 的格式切分修订片段，保住加粗/字体等
function origRuns(px) {
  const rest = px.replace(/^<w:p(?:\s[^>]*)?>/, '').replace(/<\/w:p>$/, '').replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '');
  const re = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>|<w:proofErr[^>]*\/>|<w:bookmark(?:Start|End)[^>]*\/>/g, runs = [], marks = []; let m, covered = 0;
  while ((m = re.exec(rest))) {
    covered += m[0].length;
    if (m[1] === undefined) { if (m[0].startsWith('<w:bookmark')) marks.push(m[0]); continue; }
    const rPr = (m[1].match(/^\s*<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0].trim();
    runs.push({ rPr, text: paraText('<w:r>' + m[1].slice(rPr.length) + '</w:r>') });
  }
  return covered === rest.replace(/>\s+</g, '><').length || covered === rest.length ? { runs, marks } : null;
}
function styleSegs(segs, runs) {
  const out = []; let off = 0;
  const runAt = o => { let a = 0; for (const r of runs) { if (o < a + r.text.length) return r; a += r.text.length; } return runs[runs.length - 1]; };
  for (const g of segs) {
    if (g.t === 'ins') { out.push({ ...g, rPr: (runAt(Math.max(0, off - 1)) || {}).rPr || '' }); continue; }
    let s = g.s;
    while (s.length) { let a = 0, r = null; for (const x of runs) { if (off < a + x.text.length) { r = x; break; } a += x.text.length; } const take = r ? Math.min(s.length, a + r.text.length - off) : s.length; out.push({ t: g.t, s: s.slice(0, take), rPr: r ? r.rPr : '' }); s = s.slice(take); off += take; }
  }
  return out;
}

// ---------- 全新生成 ----------
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  [[1, 36], [2, 30], [3, 26], [4, 24], [5, 22], [6, 22]].map(([n, sz]) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`).join('') +
  `<w:style w:type="paragraph" w:styleId="ListItem"><w:name w:val="List Item"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style></w:styles>`;
function exportNew(S, opt) {
  const ctx = mkCtx(S, opt); ctx.cbase = 0; let body = '';
  for (const { b, state } of mergedOrder(S)) {
    if (ctx.clean && state === 'deleted') continue;
    if(b.type==='table'){body+=rich.tableXml(b);continue}
    const base = S.baseline.find(x => x.id === b.id), author = b.author || 'Codex';
    const style = /^h\d$/.test(b.type) ? 'Heading' + b.type[1] : b.type === 'li' ? 'ListItem' : b.type === 'code' ? 'Code' : '';
    const pm = ctx.clean ? '' : state === 'deleted' ? markDel(ctx, b.delAuthor || 'Codex') : !base ? markIns(ctx, author) : '';
    const pPr = style || pm ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pm}</w:pPr>` : '';
    const pre = b.type === 'todo' ? `<w:r><w:t xml:space="preserve">${b.checked?'☑':'☐'} </w:t></w:r>` : b.type === 'li' ? `<w:r><w:t xml:space="preserve">${esc(b.prefix || '• ')}</w:t></w:r>` : '';
    body += `<w:p>${pPr}${pre}${runsXml(b.formats?rich.formatSegs(blockSegs(S,b,state),b,base):blockSegs(S, b, state), '', state === 'deleted' ? (b.delAuthor || 'Codex') : author, ctx, commentMarks(S, ctx, b.id, b.text, state === 'deleted'))}${imageRuns(b,ctx)}</w:p>`;
  }
  const hasC = ctx.comments.length > 0;
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${hasC ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ''}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>` },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${hasC ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' : ''}</Relationships>` },
  ];
  if (hasC) files.push({ name: 'word/comments.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>${commentsBody(ctx)}</w:comments>` });
  return finishMedia(files,ctx);
}

// ---------- 写回原 docx ----------
function exportInto(S, origBuf, opt) {
  const files = unzip(origBuf), get = n => files.find(f => f.name === n), ctx = mkCtx(S, opt);
  const d = get('word/document.xml');let ti=0;const xml = d.data.toString('utf8').replace(/<w:tbl(?:\s[^>]*)?>/g,m=>m+'<!--docreview-table-'+ti+++'-->'), paras = scanParas(xml);
  const cf = get('word/comments.xml'); let cx = cf ? cf.data.toString('utf8') : null;
  ctx.cbase = cx ? Math.max(-1, ...[...cx.matchAll(/<w:comment\b[^>]*w:id="(\d+)"/g)].map(m => +m[1])) + 1 : 0;
  const order = mergedOrder(S), bySrc = new Map(), after = new Map(), head = []; let lastSrc = null;
  for (const o of order) { if (o.b.src != null) { bySrc.set(o.b.src, o); if (o.state === 'live') lastSrc = o.b.src; } else if (lastSrc == null) head.push(o); else { if (!after.has(lastSrc)) after.set(lastSrc, []); after.get(lastSrc).push(o); } }
  const newPara = o => { if(ctx.clean&&o.state==='deleted')return '';if(o.b.type==='table')return rich.tableXml(o.b);const a = o.b.author || 'Codex'; return `<w:p><w:pPr>${markIns(ctx, a)}</w:pPr>${o.b.type==='todo'?`<w:r><w:t xml:space="preserve">${o.b.checked?'☑':'☐'} </w:t></w:r>`:''}${runsXml(o.b.formats?rich.formatSegs([{t:'ins',s:o.b.text}],o.b):[{ t: 'ins', s: o.b.text }], '', a, ctx, commentMarks(S, ctx, o.b.id, o.b.text, false))}${imageRuns(o.b,ctx)}</w:p>`; };
  let out = '', pos = 0, first = true;
  paras.forEach((p, i) => {
    out += xml.slice(pos, p.start); pos = p.end;
    if (first) { out += head.map(newPara).join(''); first = false; }
    let px = xml.slice(p.start, p.end); const o = bySrc.get(i);
    if (o && o.b.type!=='table') {
      let { b, state } = o, base = S.baseline.find(x => x.id === b.id), inherited = base?.sourceSegs, sourceFinal = inherited?.filter(g=>g.t!=='del').map(g=>g.s).join(''), changed = state === 'deleted' || (base && base.text !== b.text) || (inherited && b.text!==sourceFinal) || (ctx.clean && inherited) || b.formatChanged || b.imagesChanged || b.typeOverride;
      if(inherited && !b.formatChanged && !b.imagesChanged && !b.typeOverride && /<w:(?:ins|del|moveFrom|moveTo)\b/.test(px) && b.text===sourceFinal && state!=='deleted' && !ctx.clean) changed=false;
      if(b.type==='todo')px=px.replace(/(<w:t\b[^>]*>)[☐☑] /, '$1'+(b.checked?'☑':'☐')+' ');
      const marks = commentMarks(S, ctx, b.id, b.text, state === 'deleted');
      const open = px.match(/^<w:p(?:\s[^>]*)?>/)[0]; let pPr = (px.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
      if (changed) {
        const rest = px.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, ''), r1 = rest.match(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/);
        const rPr = r1 ? ((r1[1].match(/^\s*<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0]).trim() : '';
        const who = state === 'deleted' ? (b.delAuthor || 'Codex') : (b.author || 'Codex');
        if (state === 'deleted' && !ctx.clean && !/<w:sectPr/.test(pPr)) {
          const dm = `<w:del w:id="${ctx.rev++}" w:author="${esc(who)}" w:date="${ctx.date}"/>`;
          pPr = !pPr ? `<w:pPr><w:rPr>${dm}</w:rPr></w:pPr>` : /<w:rPr>/.test(pPr) ? pPr.replace('<w:rPr>', '<w:rPr>' + dm) : pPr.replace('</w:pPr>', `<w:rPr>${dm}</w:rPr></w:pPr>`);
        }
        const or = origRuns(px), ok = or && or.runs.length && or.runs.map(r => r.text).join('') === (base ? base.text : b.text);
        let segs = ok ? styleSegs(blockSegs(S, b, state), or.runs) : blockSegs(S, b, state);
        if(b.formats)segs=rich.formatSegs(segs,b,base);
        px = open + pPr + (b.type==='todo'?`<w:r><w:t xml:space="preserve">${b.checked?'☑':'☐'} </w:t></w:r>`:'') + (ok ? or.marks.join('') : '') + runsXml(segs, rPr, who, ctx, marks) + imageRuns(b,ctx) + '</w:p>';
        if (ctx.clean && state === 'deleted') {
          const sole = /(<\/w:tcPr>|<w:tc>)\s*$/.test(xml.slice(Math.max(0, p.start - 600), p.start)) && /^\s*<\/w:tc>/.test(xml.slice(p.end, p.end + 30));
          px = sole || /<w:sectPr/.test(pPr) ? open + pPr + '</w:p>' : '';
        }
      } else if (marks.length) {
        // 未改动的段落不碰 run，批注挂整段
        const s = marks.filter((_, k) => k % 2 === 0).map(m => m.xml).join(''), e = marks.filter((_, k) => k % 2 === 1).map(m => m.xml).join('');
        const cut = open.length + (pPr && px.indexOf(pPr) === open.length ? pPr.length : 0);
        px = px.slice(0, cut) + s + px.slice(cut, px.length - 6) + e + '</w:p>';
      }
    }
    out += px + (o?.b.sourceTable!=null?'':(after.get(i) || []).map(newPara).join(''));
  });
  out += xml.slice(pos);
  for(const table of rich.scan(out,'w:tbl').reverse()){const idx=table.xml.match(/<!--docreview-table-(\d+)-->/)?.[1];if(idx===undefined)continue;const item=order.find(o=>o.b.sourceTable===+idx);if(item){const replacement=item.state==='deleted'&&ctx.clean?'':item.b.tableChanged?rich.tableXml(item.b):table.xml;out=out.slice(0,table.start)+replacement+(after.get(item.b.src)||[]).map(newPara).join('')+out.slice(table.end)}}
  out=out.replace(/<!--docreview-table-\d+-->/g,'');d.data = Buffer.from(out, 'utf8');
  if (ctx.comments.length) {
    if (cx) cf.data = Buffer.from(cx.replace('</w:comments>', commentsBody(ctx) + '</w:comments>'), 'utf8');
    else {
      files.push({ name: 'word/comments.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>${commentsBody(ctx)}</w:comments>`, 'utf8') });
      const ct = get('[Content_Types].xml'); ct.data = Buffer.from(ct.data.toString('utf8').replace('</Types>', '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'), 'utf8');
      let rel = get('word/_rels/document.xml.rels');
      if (!rel) { rel = { name: 'word/_rels/document.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>') }; files.push(rel); }
      rel.data = Buffer.from(rel.data.toString('utf8').replace('</Relationships>', '<Relationship Id="rIdDocReviewComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>'), 'utf8');
    }
  }
  return finishMedia(files,ctx);
}
function exportDocx(S, origBuf, opt) {
  const buf = S.doc && S.doc.kind === 'docx' && origBuf ? exportInto(S, origBuf, opt) : exportNew(S, opt);
  if (!S.doc?.fonts) return buf;
  const fonts = `<w:rFonts w:ascii="${esc(S.doc.fonts.latin)}" w:hAnsi="${esc(S.doc.fonts.latin)}" w:cs="${esc(S.doc.fonts.latin)}" w:eastAsia="${esc(S.doc.fonts.eastAsia)}"/>`;
  const files = unzip(buf);
  for (const f of files) if (/^word\/.*\.xml$/.test(f.name)) {
    let xml = f.data.toString('utf8');
    xml = xml.replace(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, run => {
      if (/<w:rFonts\b/.test(run)) return run;
      if (/<w:rPr(?:\s[^>]*)?\s*\/>/.test(run)) return run.replace(/<w:rPr(?:\s[^>]*)?\s*\/>/, `<w:rPr>${fonts}</w:rPr>`);
      if (/<w:rPr(?:\s[^>]*)?>/.test(run)) return run.replace(/<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>/, pr => pr.replace(/<w:rFonts\b[^>]*(?:\/>|>[\s\S]*?<\/w:rFonts>)/g, '').replace('</w:rPr>', fonts + '</w:rPr>'));
      return run.replace(/^(<w:r(?:\s[^>]*)?>)/, '$1<w:rPr>' + fonts + '</w:rPr>');
    });
    f.data = Buffer.from(xml);
  }
  return zip(files);
}
module.exports = { importDocx, importText, exportDocx, exportMarkdown, blockSegs, mergedOrder };
