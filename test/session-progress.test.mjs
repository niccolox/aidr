// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Progress,clockOf,lastLine} from '../lib/session-progress.mjs';

const T=s=>new Date(Date.UTC(2026,10,22,1,0,s)).toISOString();
const use=(id,input,s)=>({type:'assistant',timestamp:T(s),message:{content:[{type:'tool_use',id,name:'Bash',input}]}});
const result=(id,content,s)=>({type:'user',timestamp:T(s),message:{content:[{type:'tool_result',tool_use_id:id,content}]}});

test('a tool call runs until its result, and a background command until its task notice',()=>{
 const p=new Progress(),start=Date.parse(T(0));
 p.feed(use('a',{description:'Run the release checks',command:'release.py check'},0));
 assert.deepEqual(p.running(start+20_000),[]);
 assert.deepEqual(p.running(start+90_000).map(r=>[r.kind,r.text,r.seconds]),[['call','Run the release checks',90]]);
 p.feed(result('a','Command running in background with ID: bk1. Output is being written to: /tmp/x/tasks/bk1.output',1));
 assert.equal(p.calls.size,0);
 assert.deepEqual(p.running(start+61_000,{tail:()=>'admin check 1 exit 0'}).map(r=>[r.kind,r.name,r.last]),[['background','bk1','admin check 1 exit 0']]);
 const ended=p.feed({type:'user',timestamp:T(50),message:{content:'<task-notification><task-id>bk1</task-id><status>completed</status></task-notification>'}});
 assert.deepEqual(ended,[{id:'bk1',text:'Run the release checks',status:'completed',seconds:49}]);
 assert.equal(p.background.size,0);
});

test('the last output line is filtered and read only from a tasks folder',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wtf-progress-'));
 try{
  mkdirSync(join(dir,'tasks'));
  const file=join(dir,'tasks','b1.output');
  writeFileSync(file,'one\ntoken: '+'ghp_'+'abcdefghijklmnopqrstuvwxyz123456\n\n');
  assert.equal(lastLine(file),'token: ••••');
  assert.equal(lastLine(join(dir,'other.txt')),'');
 }finally{rmSync(dir,{recursive:true,force:true});}
 assert.equal(clockOf(45),'45 s');assert.equal(clockOf(130),'2 min 10 s');assert.equal(clockOf(3720),'1 h 2 min');
});
