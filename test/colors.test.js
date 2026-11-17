'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
test('color swatches apply directly and reuse chosen colors across Word modes', {skip:process.env.DOCREVIEW_BROWSER_TEST!=='1',timeout:120000},async()=>{
 const {chromium}=require('playwright');const fixtures=require('./make-rich-fixtures');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'docreview-colors-')),port=24618,url='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,[path.resolve(__dirname,'../server/daemon.js')],{env:{...process.env,DOCREVIEW_DATA:dir,DOCREVIEW_PORT:String(port),DOCREVIEW_AUTODISPATCH:'0'},stdio:'ignore',windowsHide:true});
 let browser;
 const api=async(route,body)=>{const r=await fetch(url+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});if(!r.ok)throw Error(await r.text());return r.json()};
 try{
  for(let i=0;i<80;i++){try{await api('/api/ping');break}catch{await new Promise(r=>setTimeout(r,50))}}
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1500,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const select=async word=>{await page.evaluate(word=>{const el=[...document.querySelectorAll('.blk')].find(e=>e.textContent.includes(word));el.focus();const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const at=n.textContent.indexOf(word);if(at>=0&&!n.parentElement.closest('del')){const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+word.length);getSelection().removeAllRanges();getSelection().addRange(r);return}}throw Error('Selection missing')},word)};
  const change=async action=>{const response=page.waitForResponse(r=>r.url().endsWith('/api/format')&&r.request().method()==='POST');await action();assert.equal((await response).status(),200);await page.waitForFunction(()=>getSelection().toString().length>0)};
  const expectColor=async(word,key,value)=>{const state=await api('/api/state');const b=state.blocks.find(b=>b.text.includes(word)),at=b.text.indexOf(word);assert.ok(b.formats.some(f=>f.start<=at&&f.end>=at+word.length&&f.style[key]?.toLowerCase()===value))};
  for(const doc of ['plain','revised'])for(const mode of ['edit','suggest'])for(const revisions of [true,false]){
   await api('/api/open',{name:doc+'.docx',b64:fs.readFileSync(path.join(fixtures.dir,doc+'.docx')).toString('base64')});await api('/api/mode',{mode});
   await page.goto(url);await page.locator('.blk').first().waitFor();if(!revisions)await page.locator('#rev').click();
   await page.evaluate(()=>{window.pickerClicks=0;document.querySelectorAll('input[type=color]').forEach(e=>e.addEventListener('click',()=>window.pickerClicks++))});
   await select('Alpha');await change(()=>page.locator('#textSwatch').click());await expectColor('Alpha','color','#b42318');
   await select('Alpha');await change(()=>page.locator('#highlightSwatch').click());await expectColor('Alpha','highlight','#fff176');
   assert.equal(await page.evaluate(()=>window.pickerClicks),0);
   for(const [input,key,color,swatch]of [['textColor','color','#147d39','textSwatch'],['highlightColor','highlight','#aabbff','highlightSwatch']]){
    await select('Alpha');await page.locator('#'+input).dispatchEvent('pointerdown');
    await change(()=>page.locator('#'+input).evaluate((el,color)=>{el.value=color;el.dispatchEvent(new Event('change',{bubbles:true}))},color));
    await expectColor('Alpha',key,color);await select('Convert');await change(()=>page.locator('#'+swatch).click());await expectColor('Convert',key,color);
   }
  }
  await api('/api/mode',{mode:'view'});await page.waitForFunction(()=>document.querySelector('#textColorBtn').disabled&&document.querySelector('#highlightBtn').disabled);
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();const exited=new Promise(r=>proc.once('exit',r));proc.kill();await exited;assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
});
