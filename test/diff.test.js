const {test}=require('node:test'),assert=require('node:assert/strict'),{diff}=require('../server/diff');
test('phrase replacements preserve both drafts including spaces and punctuation',()=>{
 const cases=[['biomarker status is used to','biomarkers inform treatment selection by helping'],['a b c','x y z'],['','new'],['old',''],['中文原文测试。','中文修改测试。'],['a  b\nc','a b\nnew c'],['A-B, C.','A-D; E.']];
 for(const [a,b] of cases){const d=diff(a,b);assert.equal(d.filter(x=>x.t!=='ins').map(x=>x.s).join(''),a);assert.equal(d.filter(x=>x.t!=='del').map(x=>x.s).join(''),b)}
 assert.deepEqual(diff('a b c','x y z'),[{t:'del',s:'a b c'},{t:'ins',s:'x y z'}]);
});
