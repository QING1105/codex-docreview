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
  const select=async word=>{await page.evaluate(word=>{
   const el=[...document.querySelectorAll('.blk')].find(e=>e.textContent.includes(word));el.focus();
   const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),nodes=[];let n;
   while(n=walker.nextNode())if(!n.parentElement.closest('del'))nodes.push(n);
   const at=nodes.map(n=>n.textContent).join('').indexOf(word);if(at<0)throw Error('Selection missing');
   const r=document.createRange();let pos=0,started=false;
   for(const n of nodes){const end=pos+n.length;if(!started&&at<end){r.setStart(n,at-pos);started=true}if(started&&at+word.length<=end){r.setEnd(n,at+word.length-pos);break}pos=end}
   getSelection().removeAllRanges();getSelection().addRange(r);
  },word)};
  const change=async action=>{const response=page.waitForResponse(r=>r.url().endsWith('/api/format')&&r.request().method()==='POST');await action();assert.equal((await response).status(),200);await page.waitForFunction(()=>getSelection().toString().length>0)};
  const expectColor=async(word,key,value)=>{const state=await api('/api/state');const b=state.blocks.find(b=>b.text.includes(word)),at=b.text.indexOf(word);assert.ok(b.formats.filter(f=>f.start<at+word.length&&f.end>at).every(f=>f.style[key]?.toLowerCase()===value))};
  for(const doc of ['plain','revised'])for(const mode of ['edit','suggest'])for(const revisions of [true,false]){
   await api('/api/open',{name:doc+'.docx',b64:fs.readFileSync(path.join(fixtures.dir,doc+'.docx')).toString('base64')});await api('/api/mode',{mode});
   await page.goto(url);await page.locator('.blk').first().waitFor();if(!revisions)await page.locator('#rev').click();
   await page.evaluate(()=>{window.pickerClicks=0;document.querySelectorAll('input[type=color]').forEach(e=>e.addEventListener('click',()=>window.pickerClicks++))});
   await select('Alpha');await change(()=>page.locator('#textSwatch').click());await expectColor('Alpha','color','#b42318');
   assert.equal(await page.locator('#textColorBtn').getAttribute('aria-pressed'),'true');
   await change(()=>page.locator('#textSwatch').click());await expectColor('Alpha','color','#000000');
   assert.equal(await page.locator('#textColorBtn').getAttribute('aria-pressed'),'false');
   // Imported Word colors use uppercase hex; they must toggle off on the first click too.
   await select('colored');await change(()=>page.locator('#textSwatch').click());await expectColor('colored','color','#000000');
   await change(()=>page.locator('#highlightSwatch').click());await expectColor('colored','highlight','transparent');
   await select('Alpha');await change(()=>page.locator('#highlightSwatch').click());await expectColor('Alpha','highlight','#fff176');
   assert.equal(await page.locator('#highlightBtn').getAttribute('aria-pressed'),'true');
   await change(()=>page.locator('#highlightSwatch').click());await expectColor('Alpha','highlight','transparent');
   assert.equal(await page.locator('#highlightBtn').getAttribute('aria-pressed'),'false');
   assert.equal(await page.evaluate(()=>window.pickerClicks),0);
   for(const key of ['bold','italic','underline','strike']){
    const state=await api('/api/state'),b=state.blocks.find(b=>b.text.includes('Alpha')),at=b.text.indexOf('Alpha');
    // The selection starts with formatting enabled but ends with it disabled.
    await api('/api/format',{id:b.id,start:at,end:at+2,style:{[key]:true}});
    await api('/api/format',{id:b.id,start:at+2,end:at+5,style:{[key]:false}});
    await page.reload();await page.locator('.blk').first().waitFor();if(!revisions)await page.locator('#rev').click();await select('Alpha');
    const btn=page.locator('[data-format="'+key+'"]');
    await change(()=>btn.click());
    let current=(await api('/api/state')).blocks.find(x=>x.id===b.id);
    assert.ok(current.formats.filter(f=>f.start<at+5&&f.end>at).every(f=>f.style[key]===true));
    assert.equal(await btn.getAttribute('aria-pressed'),'true');
    await change(()=>btn.click());current=(await api('/api/state')).blocks.find(x=>x.id===b.id);
    assert.ok(current.formats.filter(f=>f.start<at+5&&f.end>at).every(f=>f.style[key]===false));
    assert.equal(await btn.getAttribute('aria-pressed'),'false');
   }
   for(const [input,key,color,swatch]of [['textColor','color','#147d39','textSwatch'],['highlightColor','highlight','#aabbff','highlightSwatch']]){
    await select('Alpha');await page.locator('#'+input).dispatchEvent('pointerdown');
    await change(()=>page.locator('#'+input).evaluate((el,color)=>{el.value=color;el.dispatchEvent(new Event('change',{bubbles:true}))},color));
    await expectColor('Alpha',key,color);await select('Convert');await change(()=>page.locator('#'+swatch).click());await expectColor('Convert',key,color);
   }
   await select('Alpha');await change(()=>page.locator('#highlightSwatch').click());await expectColor('Alpha','highlight','transparent');
   // Changing colors repeatedly must still clear to actual black, even after another selection changes the saved swatch.
   await select('Alpha');
   for(const color of ['#ff0000','#0000ff','#00ff00']){
    await page.locator('#textColor').dispatchEvent('pointerdown');
    await change(()=>page.locator('#textColor').evaluate((el,color)=>{el.value=color;el.dispatchEvent(new Event('change',{bubbles:true}))},color));
    await expectColor('Alpha','color',color);
   }
   await change(()=>page.locator('#textSwatch').click());await expectColor('Alpha','color','#000000');
   assert.equal(await page.evaluate(()=>getComputedStyle(getSelection().anchorNode.parentElement).color),'rgb(0, 0, 0)');
   await change(()=>page.locator('#textSwatch').click());await expectColor('Alpha','color','#00ff00');
   await select('Convert');await page.locator('#textColor').dispatchEvent('pointerdown');
   await change(()=>page.locator('#textColor').evaluate(el=>{el.value='#771199';el.dispatchEvent(new Event('change',{bubbles:true}))}));
   await select('Alpha');await change(()=>page.locator('#textSwatch').click());await expectColor('Alpha','color','#000000');
   assert.equal(await page.locator('#textColorBtn').getAttribute('aria-pressed'),'false');
   // Color changes and cancellation can arrive before the preceding saves finish.
   await page.locator('#textColor').dispatchEvent('pointerdown');
   await page.locator('#textColor').evaluate(el=>{for(const color of ['#ee0000','#0000ee','#00aa00']){el.value=color;el.dispatchEvent(new Event('change',{bubbles:true}))}});
   await page.locator('#textSwatch').click();await page.evaluate(()=>formatWork);
   await expectColor('Alpha','color','#000000');
   assert.equal(await page.evaluate(()=>getComputedStyle(getSelection().anchorNode.parentElement).color),'rgb(0, 0, 0)');
   const response=await fetch(url+'/api/export-clean.docx');assert.ok(response.ok);
   const imported=require('../server/docx').importDocx(Buffer.from(await response.arrayBuffer()));
   const alpha=imported.find(b=>b.text.includes('Alpha')),at=alpha.text.indexOf('Alpha');
   assert.ok(alpha.formats.filter(f=>f.start<at+5&&f.end>at).every(f=>f.style.color==='#000000'));
   for(const key of ['bold','italic','underline','strike'])assert.ok(alpha.formats.filter(f=>f.start<at+5&&f.end>at).every(f=>!f.style[key]));
   assert.ok(alpha.formats.filter(f=>f.start<at+5&&f.end>at).every(f=>!f.style.highlight||f.style.highlight==='transparent'));
  }
  await api('/api/mode',{mode:'view'});await page.waitForFunction(()=>document.querySelector('#textColorBtn').disabled&&document.querySelector('#highlightBtn').disabled);
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();const exited=new Promise(r=>proc.once('exit',r));proc.kill();await exited;assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
});
