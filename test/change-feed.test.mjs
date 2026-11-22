// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {ChangeFeed,planLines,renderEvent} from '../lib/change-feed.mjs';

const said=(...parts)=>({type:'assistant',timestamp:'2026-11-21T10:00:00Z',message:{content:parts}});
const tool=(id,name,input)=>({type:'tool_use',id,name,input});
const result=(id,text,is_error=false)=>({type:'user',timestamp:'2026-11-21T10:00:05Z',message:{content:[{type:'tool_result',tool_use_id:id,content:text,is_error}]}});

test('reads, searches, plain commands and text between steps give no change event',()=>{
 const feed=new ChangeFeed();
 const busy=said({type:'text',text:'I read the file first.'},tool('a','Read',{file_path:'/r/a.py'}),tool('b','Grep',{pattern:'x'}),
  tool('c','Bash',{command:'git status --porcelain',description:'Show status'}),tool('d','Bash',{command:'node --test',description:'Run tests'}));
 assert.deepEqual(feed.events(busy),[]);
 assert.deepEqual(feed.events(result('c',' M a.py')),[]);
 assert.deepEqual(feed.events(result('d','# pass 9')),[]);
 // Harness text is not a request.
 assert.deepEqual(feed.events({type:'user',message:{content:'<system-reminder>x</system-reminder>'}}),[]);
});

test('the request and new task-list items are planned; a start is in process; a finish is completed',()=>{
 const feed=new ChangeFeed();
 assert.deepEqual(feed.events({type:'user',timestamp:'t',message:{content:'add the change flag'}}).map(e=>[e.stage,e.kind,e.text]),[['planned','asked','add the change flag']]);
 const first=feed.events(said(tool('t1','TodoWrite',{todos:[{content:'Add the flag',status:'pending'},{content:'Write the tests',status:'pending'}]})));
 assert.deepEqual(first.map(e=>[e.stage,e.text]),[['planned','Add the flag'],['planned','Write the tests']]);
 const second=feed.events(said(tool('t2','TodoWrite',{todos:[{content:'Add the flag',status:'in_progress',activeForm:'Adding the flag'},{content:'Write the tests',status:'pending'}]})));
 assert.deepEqual(second.map(e=>[e.stage,e.text]),[['process','Adding the flag']]);
 const third=feed.events(said(tool('t3','TodoWrite',{todos:[{content:'Add the flag',status:'completed'},{content:'Write the tests',status:'pending'}]})));
 assert.deepEqual(third.map(e=>[e.stage,e.text]),[['done','Add the flag']]);
});

test('a task keeps its name from TaskCreate to TaskUpdate',()=>{
 const feed=new ChangeFeed();
 assert.deepEqual(feed.events(said(tool('k','TaskCreate',{subject:'Build the export'}))).map(e=>[e.stage,e.text]),[['planned','Build the export']]);
 feed.events(result('k','Task #4 created successfully'));
 assert.deepEqual(feed.events(said(tool('u','TaskUpdate',{taskId:'4',status:'completed'}))).map(e=>[e.stage,e.text]),[['done','Build the export']]);
});

test('a commit, a push and a deploy are completed changes, read from their results',()=>{
 const feed=new ChangeFeed();
 feed.events(said(tool('c','Bash',{command:'git add a.mjs && git commit -q -F msg.txt',description:'Commit'})));
 assert.deepEqual(feed.events(result('c','[master 1de962a6] feat(local): the change view\n 2 files changed')).map(e=>[e.stage,e.kind,e.text]),
  [['done','commit','1de962a6 feat(local): the change view']]);
 feed.events(said(tool('p','Bash',{command:'git push -q origin master'})));
 assert.deepEqual(feed.events(result('p','To github.com:o/r.git\n   97722f8d..1de962a6  master -> master')).map(e=>e.text),['master to master (97722f8d..1de962a6)']);
 feed.events(said(tool('d','Bash',{command:'.venv/bin/python deployment/release.py check admin; R=$?; [ $R -eq 0 ] && .venv/bin/python deployment/release.py deploy admin'})));
 assert.deepEqual(feed.events(result('d','Deployed.')).map(e=>[e.stage,e.text]),[['done','admin deployed']]);
 feed.events(said(tool('e','Bash',{command:'.venv/bin/python deployment/release.py deploy storefront'})));
 assert.deepEqual(feed.events(result('e','Exit code 1',true)).map(e=>[e.stage,e.text]),[['failed','storefront did not deploy']]);
 // A commit command that made no commit (nothing to commit) gives no event.
 feed.events(said(tool('n','Bash',{command:'git commit -m x'})));
 assert.deepEqual(feed.events(result('n','nothing to commit, working tree clean')),[]);
});

test('a plan shows its headings and list items, and the event renders as plain text',()=>{
 assert.deepEqual(planLines('# Plan\nSome prose.\n- step one\n2. step two\n'),['Plan','- step one','2. step two']);
 const feed=new ChangeFeed();
 const [plan]=feed.events(said(tool('x','ExitPlanMode',{plan:'## Change view\n- add the flag'})));
 assert.deepEqual(renderEvent(plan,{folder:'repo'}),['2026-11-21T10:00:00Z  repo  Planned · Plan | A plan','  │ Change view','  │ - add the flag']);
});
