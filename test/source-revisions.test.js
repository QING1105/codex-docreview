const {test}=require('node:test'),a=require('node:assert/strict');
const {importDocx,exportDocx,blockSegs}=require('../server/docx'),{unzip}=require('../server/zip');
const xml=b=>unzip(b).find(f=>f.name==='word/document.xml').data.toString();
test('import preserves source revisions, original export, clean export and rejection',()=>{
 const base={id:'b1',type:'p',text:'The old phrase.'};
 const original=exportDocx({doc:{kind:'text'},baseline:[base],blocks:[{...base,text:'The revised sentence.'}],comments:[]});
 const imported=importDocx(original);a.equal(imported[0].text,'The revised sentence.');a.equal(imported[0].originalText,'The old phrase.');
 const b={...imported[0],id:'b1'},s={doc:{kind:'docx'},blocks:[b],baseline:[{...b,text:b.originalText}],comments:[]};
 a.ok(blockSegs(s,b,'live').some(x=>x.t==='del'));
 a.equal(xml(exportDocx(s,original)),xml(original));
 const clean=exportDocx(s,original,{clean:true});a.doesNotMatch(xml(clean),/<w:(ins|del)\b/);a.equal(importDocx(clean)[0].text,b.text);
 const rejected=exportDocx({...s,blocks:[{...b,text:b.originalText}]},original);a.doesNotMatch(xml(rejected),/<w:(ins|del)\b/);a.equal(importDocx(rejected)[0].text,b.originalText);
});

test('paragraph types resolve Word style names and inheritance instead of numeric IDs',()=>{
 const {zip}=require('../server/zip');
 const style=(id,name,props='',parent='')=>`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${parent?`<w:basedOn w:val="${parent}"/>`:''}<w:pPr>${props}</w:pPr></w:style>`;
 const styles=style('3','Body Text')+style('24','First Paragraph','','3')+style('2','heading 1','<w:outlineLvl w:val="0"/>')+style('custom','Custom heading','','2')+style('cycle','Body','','cycle');
 const p=(id,extra='')=>`<w:p><w:pPr><w:pStyle w:val="${id}"/>${extra}</w:pPr><w:r><w:t>Paragraph ${id}</w:t></w:r></w:p>`;
 const doc=p('3')+p('24')+p('2')+p('custom')+p('2','<w:outlineLvl w:val="9"/>')+p('3','<w:pPrChange><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:pPrChange>')+p('cycle')+p('Heading2')+p('4');
 const buf=zip([{name:'word/document.xml',data:Buffer.from(`<w:document><w:body>${doc}</w:body></w:document>`)},{name:'word/styles.xml',data:Buffer.from(`<w:styles>${styles}</w:styles>`)}]);
 a.deepEqual(importDocx(buf).map(b=>b.type),['p','p','h1','h1','p','p','p','h2','p']);
});

test('todo survives Word export, reopen, completion and subsequent editing',()=>{
 const b={id:'b1',type:'todo',checked:false,text:'Check references'};
 const original=exportDocx({doc:{kind:'text'},blocks:[b],baseline:[b],comments:[]});
 const loaded=importDocx(original)[0];a.equal(loaded.type,'todo');a.equal(loaded.text,b.text);a.equal(loaded.checked,false);
 const base={...loaded,id:'b1'},s={doc:{kind:'docx'},blocks:[{...base,checked:true}],baseline:[base],comments:[]};
 a.equal(importDocx(exportDocx(s,original))[0].checked,true);
 s.blocks[0].text='Check updated references';
 const edited=importDocx(exportDocx(s,original))[0];a.equal(edited.text,s.blocks[0].text);a.equal(edited.checked,true);
});
