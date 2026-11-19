const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('fs');
const {zip,unzip}=require('../server/zip'),{exportDocx,importDocx}=require('../server/docx'),{dir}=require('./make-rich-fixtures');
test('Word export has one revision author and excludes conversations and old comment parts',()=>{
 for(const source of ['text','plain','revised'])for(const clean of [false,true]){
  let original=null,blocks;
  if(source==='text')blocks=[{id:'b1',text:'Original sentence.',type:'p'}];
  else{
   const files=unzip(fs.readFileSync(dir+'/'+source+'.docx')),document=files.find(f=>f.name==='word/document.xml');
   document.data=Buffer.from(document.data.toString().replace('</w:body>','<w:p><w:commentRangeStart w:id="44"/><w:r><w:t>Keep this paragraph.</w:t></w:r><w:commentRangeEnd w:id="44"/><w:r><w:commentReference w:id="44"/></w:r></w:p></w:body>'));
   for(const name of ['comments','commentsExtended','commentsIds','commentsExtensible','people']){
    files.push({name:'word/'+name+'.xml',data:Buffer.from('<old>PRIVATE_OLD_DISCUSSION</old>')});
    files.push({name:'word/_rels/'+name+'.xml.rels',data:Buffer.from('<Relationships/>')});
    const types=files.find(f=>f.name==='[Content_Types].xml');types.data=Buffer.from(types.data.toString().replace('</Types>',`<Override PartName="/word/${name}.xml" ContentType="comment-type"/></Types>`));
    const rel=files.find(f=>f.name==='word/_rels/document.xml.rels');rel.data=Buffer.from(rel.data.toString().replace('</Relationships>',`<Relationship Id="${name}" Type="http://example/${name}" Target="${name}.xml"/></Relationships>`));
   }
   original=zip(files);blocks=importDocx(original).map((b,i)=>({...b,id:'b'+i}));
  }
  const base=structuredClone(blocks),comments=[{id:'c1',blockId:blocks[0].id,quote:'',text:'PRIVATE_QUESTION',author:'User',replies:[{author:'Codex',text:'PRIVATE_REPLY'}]}];
  blocks[0].text+=' Revised by user.';blocks[0].author='User';
  blocks.push({id:'new',text:'Inserted by Codex.',type:'p',author:'Codex'});
  const state={doc:{kind:source==='text'?'text':'docx'},baseline:base,blocks,comments},snapshot=structuredClone(state);
  const result=unzip(exportDocx(state,original,{clean})),all=result.filter(f=>/\.(xml|rels)$/.test(f.name)).map(f=>f.data.toString()).join('\n');
  a.deepEqual(state,snapshot);a.doesNotMatch(all,/PRIVATE_|commentRange|commentReference|\/comments|\/people/);
  a.equal(result.some(f=>/comments|people/.test(f.name)),false);
  const document=result.find(f=>f.name==='word/document.xml').data.toString();
  if(!clean){const authors=[...document.matchAll(/w:author="([^"]*)"/g)].map(m=>m[1]);a.ok(authors.length);a.deepEqual([...new Set(authors)],['Language Editor']);}
  const loaded=importDocx(zip(result));a.ok(loaded.some(b=>b.text===blocks[0].text));a.ok(loaded.some(b=>b.text==='Inserted by Codex.'));
 }
});
