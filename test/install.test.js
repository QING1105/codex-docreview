'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),path=require('node:path');
test('pip install and automatic runtime preparation without system Node',{
 skip:!process.env.DOCREVIEW_TEST_PYTHON||!process.env.DOCREVIEW_TEST_WHEELHOUSE,
 timeout:240000
},()=>{
 const result=spawnSync(process.env.DOCREVIEW_TEST_PYTHON,[path.join(__dirname,'pip.test.py')],{encoding:'utf8',timeout:230000,windowsHide:true});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
