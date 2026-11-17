'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
test('format toggles preserve long-document reading position and selection',{skip:process.env.DOCREVIEW_BROWSER_TEST!=='1',timeout:120000},async()=>{
 const {chromium}=require('playwright'),{zip,unzip}=require('../server/zip'),{importDocx}=require('../server/docx');
 const fixtures=require('./make-rich-fixtures'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'docreview-position-')),port=24621,url='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,[path.resolve(__dirname,'../server/daemon.js')],{env:{...process.env,DOCREVIEW_DATA:dir,DOCREVIEW_PORT:String(port),DOCREVIEW_AUTODISPATCH:'0'},stdio:'ignore',windowsHide:true});
 let browser;
 const api=async(route,body)=>{const r=await fetch(url+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});if(!r.ok)throw Error(await r.text());return r.json()};
 try{
  for(let i=0;i<80;i++){try{await api('/api/ping');break}catch{await new Promise(r=>setTimeout(r,50))}}
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const doc of ['plain','revised'])for(const mode of ['edit','suggest'])for(const revisions of [true,false]){
   const files=unzip(fs.readFileSync(path.join(fixtures.dir,doc+'.docx'))),xml=files.find(f=>f.name==='word/document.xml');
   const paragraph=text=>'<w:p><w:r><w:t>'+text+'</w:t></w:r></w:p>';
   // One paragraph extends well beyond the viewport; restoring focus to its start used to jump.
   xml.data=Buffer.from(xml.data.toString().replace('>References<','>'+('Long table cell. '.repeat(160))+' CellTarget end.<').replace('<w:body>','<w:body>'+Array.from({length:20},(_,i)=>paragraph('Intro '+i)).join('')+paragraph('Long reading paragraph. '.repeat(160)+' TargetWord end.')));
   await api('/api/open',{name:doc+'.docx',b64:zip(files).toString('base64')});await api('/api/mode',{mode});
   await page.goto(url);await page.locator('.blk').first().waitFor();if(!revisions)await page.locator('#rev').click();
   for(const word of ['TargetWord','CellTarget']){
   await page.evaluate(word=>{
    const el=[...document.querySelectorAll('.blk')].find(e=>e.textContent.includes(word));el.focus({preventScroll:true});
    const node=el.firstChild.firstChild,at=node.textContent.indexOf(word),r=document.createRange();r.setStart(node,at);r.setEnd(node,at+10);
    getSelection().removeAllRanges();getSelection().addRange(r);
    const doc=document.querySelector('#doc');doc.scrollTop+=r.getBoundingClientRect().top-260;
   },word);
   const initial=await page.evaluate(()=>({top:document.querySelector('#doc').scrollTop,y:getSelection().getRangeAt(0).getBoundingClientRect().top}));assert.ok(initial.top>1500);
   const change=async(selector)=>{
    await page.evaluate(()=>{window.observedScroll=[];window.trackScroll=true;const tick=()=>{observedScroll.push(document.querySelector('#doc').scrollTop);if(trackScroll)requestAnimationFrame(tick)};requestAnimationFrame(tick)});
    const response=page.waitForResponse(r=>r.url().endsWith('/api/format')&&r.request().method()==='POST');await page.locator(selector).click();assert.equal((await response).status(),200);
    await page.waitForFunction(word=>getSelection().toString()===word,word);
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const position=await page.evaluate(()=>{trackScroll=false;return{top:document.querySelector('#doc').scrollTop,y:getSelection().getRangeAt(0).getBoundingClientRect().top,frames:observedScroll}});
    assert.ok(Math.abs(position.top-initial.top)<=1,`${selector} scroll moved ${position.top-initial.top}`);
    assert.ok(Math.abs(position.y-initial.y)<=1,`${selector} selection moved`);
    assert.ok(position.frames.every(top=>Math.abs(top-initial.top)<=1),`${selector} transient scroll jump`);
   };
   for(const selector of ['#highlightSwatch','#textSwatch','[data-format="bold"]','[data-format="italic"]','[data-format="underline"]','[data-format="strike"]']){await change(selector);await change(selector)}
   // Rapid double-clicks must apply and cancel in order, even while saving.
   await page.locator('#textSwatch').dblclick({delay:10});await page.waitForFunction(()=>formatting===false);await page.evaluate(()=>formatWork);
   assert.equal(await page.evaluate(()=>getSelection().toString()),word);
   assert.ok(Math.abs((await page.locator('#doc').evaluate(el=>el.scrollTop))-initial.top)<=1);
   const state=await api('/api/state'),owner=state.blocks.find(b=>b.text.includes(word)),block=word==='CellTarget'?owner.rows.flat().find(c=>c.text.includes(word)):owner,at=block.text.indexOf(word);
   const style=block.formats.find(f=>f.start<=at&&f.end>at).style;assert.equal(style.highlight,'transparent');assert.equal(style.color,'auto');
   const exported=Buffer.from(await(await fetch(url+'/api/export-clean.docx')).arrayBuffer()),imported=importDocx(exported).find(b=>b.text.includes(word)),loaded=word==='CellTarget'?imported.rows.flat().find(c=>c.text.includes(word)):imported;
   assert.equal(loaded.formats.find(f=>f.start<=at&&f.end>at).style.color,'auto');
   }
  }
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();const exited=new Promise(r=>proc.once('exit',r));proc.kill();await exited;assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
});
