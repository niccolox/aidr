// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {CodeTally,GitChanges,changesOf,diffLines,enclosing,explain,gitChange,isPrivatePath,mask,renderChange} from '../lib/code-tutor.mjs';
import {whyOf} from '../lib/aidr.mjs';

test('private files are never shown, and secrets in a changed line are masked',()=>{
 for(const p of ['/repo/.env','/repo/.prod.env','/repo/.env.local','/repo/.local/deploy/runtime.uri','/repo/keys/server.pem','/r/.claude/settings.local.json','/r/credentials.json'])assert.equal(isPrivatePath(p),true,p);
 for(const p of ['/repo/saasx2x/brand_cycle/check.py','/repo/web/storefront/env.mjs','/repo/docs/local.md'])assert.equal(isPrivatePath(p),false,p);
 assert.equal(mask('key = "sk-ant-api03-abcdefghijklmnopqrstuvwx"'),'key = "••••"');
 assert.equal(mask('token: ghp_abcdefghijklmnopqrstuvwxyz123456'),'token: ••••');
 assert.equal(mask('password=hunter2secret'),'password=••••');
 assert.equal(mask('Authorization: Bearer abcdefghijklmnop'),'Authorization: ••••');
 assert.match(mask('sha '+'a'.repeat(64)),/^sha ••••$/);
 assert.equal(mask('const LIMIT=50;'),'const LIMIT=50;');
});

test('the edit tools of an entry become changes; other tools do not',()=>{
 const entry={type:'assistant',message:{content:[
  {type:'text',text:'I add the guard.'},
  {type:'tool_use',name:'Edit',input:{file_path:'/r/a.py',old_string:'x = 1',new_string:'x = 2\ny = 3'}},
  {type:'tool_use',name:'MultiEdit',input:{file_path:'/r/b.py',edits:[{old_string:'a',new_string:'b'},{old_string:'c',new_string:'d',replace_all:true}]}},
  {type:'tool_use',name:'Write',input:{file_path:'/r/new.mjs',content:'export const A=1;'}},
  {type:'tool_use',name:'Bash',input:{command:'sed -i s/a/b/ x',description:'Edit with sed'}},
 ]}};
 const changes=changesOf(entry);
 assert.deepEqual(changes.map(c=>[c.file,c.tool,c.kind]),[['/r/a.py','Edit','edit'],['/r/b.py','MultiEdit','edit'],['/r/b.py','MultiEdit','edit'],['/r/new.mjs','Write','write']]);
 assert.equal(changes[2].all,true);
 assert.deepEqual(changesOf({type:'user',message:{content:'hi'}}),[]);
 assert.equal(whyOf(entry),'I add the guard.');
});

test('the diff keeps the order of the lines and marks each added and removed line',()=>{
 assert.deepEqual(diffLines(['a','b','c'],['a','x','c','d']).map(d=>d.op+d.text),[' a','-b','+x',' c','+d']);
});

test('the change is placed in its function, and the notes say what kind of change it is',()=>{
 const py='class Store:\n    def save(self, row):\n        require(row.ok, "row is not ready")\n        return row\n';
 assert.equal(enclosing(py,['        require(row.ok, "row is not ready")']),'save');
 const js='export function check(c){\n if(!ready(c))return unavailable(c);\n}\n';
 assert.equal(enclosing(js,[' if(!ready(c))return unavailable(c);']),'check');
 const guard=explain('/r/saasx2x/store.py',diffLines([],['        if row.state == "held":','            raise ValueError("concept held")']),'edit');
 assert.ok(guard.notes.some(n=>n.startsWith('Changes a decision')));
 assert.ok(guard.notes.some(n=>n.includes('"concept held"')));
 assert.match(guard.question,/When is the new condition true/);
 const fn=explain('/r/saasx2x/store.py',diffLines([],['def score(rows):','    return len(rows)']),'edit');
 assert.match(fn.question,/what does `score` do/);
 const t=explain('/r/tests/test_store.py',diffLines([],['def test_score():','    assert score([]) == 0']),'edit');
 assert.match(t.notes[0],/^A test/);
 const doc=explain('/r/docs/spec.md',diffLines(['old'],['new']),'edit');
 assert.match(doc.notes[0],/^Documentation/);
});

test('a change shows the file, the counts, why, the lines, a note and a question; a private file shows nothing',()=>{
 const change={file:'/r/app/limits.py',tool:'Edit',kind:'edit',before:['LIMIT = 10'],after:['LIMIT = 50  # token=abcdefghijk']};
 const out=renderChange(change,{cwd:'/r',why:'I raise the limit to 50.'}).join('\n');
 assert.match(out,/app\/limits\.py.*\+1 -1/);
 assert.match(out,/Why: I raise the limit to 50\./);
 assert.match(out,/- LIMIT = 10/);assert.match(out,/\+ LIMIT = 50  # token=••••/);
 assert.match(out,/Changes a fixed value \(`LIMIT`\)/);
 assert.match(out,/Check yourself: /);
 assert.ok(!out.includes('abcdefghijk'));
 const hidden=renderChange({file:'/r/.prod.env',tool:'Edit',kind:'edit',before:['A=1'],after:['A=2']},{cwd:'/r'}).join('\n');
 assert.match(hidden,/a private file: not shown/);assert.ok(!hidden.includes('A=2'));
 const long=renderChange({file:'/r/x.py',tool:'Write',kind:'write',before:[],after:Array.from({length:40},(_,i)=>'line '+i)},{cwd:'/r'}).join('\n');
 assert.match(long,/… \d+ more lines/);
});

test('git changes: the first read only remembers; later reads give the new hunks, not a file an edit tool just showed',()=>{
 let diff='diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n',others='';
 const g=new GitChanges('/r',args=>args[0]==='diff'?diff:others);
 assert.deepEqual(g.poll(0),[]);
 assert.deepEqual(g.poll(1000),[]);
 diff+='diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -3 +3 @@\n-y = 1\n+y = 9\ndiff --git a/.env b/.env\n@@ -1 +1 @@\n-K=1\n+K=2\n';
 const found=g.poll(2000);
 assert.deepEqual(found.map(f=>f.file),['b.py']);
 const change=gitChange('/r',found[0]);
 assert.deepEqual([change.before,change.after],[['y = 1'],['y = 9']]);
 diff=diff.replace('+y = 9','+y = 10');g.shown('/r/b.py',2500);
 assert.deepEqual(g.poll(3000),[]);
});

test('the tally names the files to read first and the code that changed with no test change',()=>{
 const t=new CodeTally();
 t.add({file:'/r/app/a.py',before:['a'],after:['b','c']});
 t.add({file:'/r/app/b.mjs',before:[],after:['x']});
 assert.equal(t.line(),'2 files changed, +3 -1');
 assert.deepEqual(t.top('/r'),['app/a.py (+2 -1)','app/b.mjs (+1 -0)']);
 assert.deepEqual(t.untested('/r'),['app/a.py','app/b.mjs']);
 t.add({file:'/r/tests/test_a.py',before:[],after:['assert True']});
 assert.deepEqual(t.untested('/r'),[]);
});

test('the map of a change: its symbol, its callers, what it uses and the tests that reach it (CodeGraph)',async()=>{
 const {graphOf,renderGraph,symbolOfChange}=await import('../lib/code-tutor.mjs');
 // A temporary folder with an empty .codegraph/ index: the package's own tests run inside .local/aidr-package, which
 // the watch treats as private, so the test cannot use the folder it sits in.
 const {mkdtempSync,mkdirSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'aidr-map-'));mkdirSync(join(root,'.codegraph'));
 assert.equal(symbolOfChange({file:root+'/x.py',before:[],after:['def score(rows):','    return 1']},root),'score');
 assert.equal(symbolOfChange({file:root+'/README.md',before:[],after:['def score():']},root),null);
 assert.equal(symbolOfChange({file:root+'/.env',before:[],after:['def score():']},root),null);
 const def={name:'score',kind:'function',filePath:'app/score.py',startLine:3};
 const answers={
  callers:{definitions:[{definition:def,callers:[{name:'rank',filePath:'app/rank.py',startLine:9}],total:1}]},
  callees:{definitions:[{definition:def,callees:[{name:'clean',filePath:'app/score.py',startLine:1}]}]},
  impact:{definitions:[{definition:def,affected:[def,{name:'rank',filePath:'app/rank.py',startLine:9},{name:'test_score',filePath:'tests/test_score.py',startLine:4}]}]},
 };
 const seen=[],exec=async(cwd,args)=>{seen.push(args.slice(0,2));return answers[args[0]];};
 const g=await graphOf(root,'score','app/score.py',{exec,now:1});
 assert.deepEqual(seen.map(a=>a[0]).sort(),['callees','callers','impact']);
 assert.deepEqual([g.callers[0].name,g.callees[0].name,g.tests.length,g.affectedFiles],['rank','clean',1,1]);
 const lines=renderGraph(g).join('\n');
 assert.match(lines,/Map of `score` \(CodeGraph, app\/score\.py:3\)/);
 assert.match(lines,/← called by rank \(rank\.py:9\)/);assert.match(lines,/→ uses clean/);
 assert.match(lines,/1 test reaches it \(tests\/test_score\.py\)/);
 const untested=renderGraph({...g,tests:[]}).join('\n');
 assert.match(untested,/No test reaches `score`: how would you know that it works\?/);
 // Not indexed yet, and a folder with no index: no map, no failure.
 const fresh=await graphOf(root,'brand_new','app/new.py',{exec:async()=>({definitions:[]}),now:2});
 assert.match(renderGraph(fresh).join('\n'),/not in the CodeGraph index yet/);
 assert.equal(await graphOf('/tmp','score','app/score.py',{exec}),null);
 assert.deepEqual(renderGraph(null),[]);
});

test('code highlights: each word of a .mjs or Python line gets the colour of its role, and the plain look has none',async()=>{
 const {highlight,langOf,renderChange}=await import('../lib/code-tutor.mjs');
 assert.deepEqual(['a.mjs','b.js','c.ts','d.py','e.md','f.json'].map(langOf),['js','js','js','python',null,'json']);
 const tag=(c,t)=>`<${c}>${t}</${c}>`;
 assert.equal(highlight('def score(rows): # count','python',tag),'<keyword>def</keyword> <definition>score</definition>(rows): <comment># count</comment>');
 assert.equal(highlight('@app.get("/x")','python',tag),'<decorator>@app.get</decorator>(<string>"/x"</string>)');
 assert.equal(highlight('    raise Refused("no", 409)','python',tag),'    <keyword>raise</keyword> <call>Refused</call>(<string>"no"</string>, <number>409</number>)');
 assert.equal(highlight('return len(self.rows)','python',tag),'<keyword>return</keyword> <builtin>len</builtin>(<builtin>self</builtin>.rows)');
 assert.equal(highlight('export function check(c){ // gate','js',tag),'<keyword>export</keyword> <keyword>function</keyword> <definition>check</definition>(c){ <comment>// gate</comment>');
 assert.equal(highlight('const n=12,f=x=>Date.now();','js',tag),'<keyword>const</keyword> n=<number>12</number>,f=x<keyword>=></keyword><builtin>Date</builtin>.<call>now</call>();');
 assert.equal(highlight('a ## b','markdown-or-none',tag),'a ## b');
 // In a change: the added line carries the colours, the removed line does not; without colours the text is unchanged.
 const change={file:'/r/app/a.py',tool:'Edit',kind:'edit',before:['x = 1'],after:['def f(): return 2']};
 const coloured=renderChange(change,{cwd:'/r',paint:tag}).join('\n');
 assert.match(coloured,/<keyword>def<\/keyword> <definition>f<\/definition>/);assert.match(coloured,/<red>- x = 1<\/red>/);
 const plain=renderChange(change,{cwd:'/r'}).join('\n');
 assert.match(plain,/\+ def f\(\): return 2/);assert.doesNotMatch(plain,/</);
});

test('JSON highlights: keys, strings, numbers, literals and comments each get their role',async()=>{
 const {highlight,langOf}=await import('../lib/code-tutor.mjs');
 const tag=(k,t)=>`[${k}:${t}]`;
 for(const f of ['saasx2x/data/models/model-ids.json','wrangler.jsonc','a.jsonl'])assert.equal(langOf(f),'json',f);
 assert.equal(highlight('  "model_id": "@cf/google/gemma-4-26b-a4b-it", "n": -1.5e3,','json',tag),
  '  [definition:"model_id"]: [string:"@cf/google/gemma-4-26b-a4b-it"], [definition:"n"]: [number:-1.5e3],');
 assert.equal(highlight('{"ok": true, "x": null} // note','json',tag),'{[definition:"ok"]: [keyword:true], [definition:"x"]: [keyword:null]} [comment:// note]');
 // A URL in a string is not a comment, and an escaped quote stays in its string.
 assert.equal(highlight('"url": "https://republic.dev", "q": "a\\"b"','json',tag),'[definition:"url"]: [string:"https://republic.dev"], [definition:"q"]: [string:"a\\"b"]');
 assert.equal(highlight('"plain"','json',(k,t)=>t),'"plain"');
});

test('the code graph draws callers, the symbol and what it uses as box lines',async()=>{
 const {GRAPH_LIMIT}=await import('../lib/code-tutor.mjs');
 assert.equal(GRAPH_LIMIT,10);
 const {graphDiagram,renderGraph}=await import('../lib/code-tutor.mjs');
 const n=x=>({name:x,file:'a.py',line:1});
 assert.deepEqual(graphDiagram({symbol:'pay',callers:['review','publish','auto'].map(n),total:3,callees:['apply','check'].map(n)}),[
  ' review ──┐',
  'publish ──┼──▶ pay ──┬──▶ apply',
  '   auto ──┘          └──▶ check']);
 assert.deepEqual(graphDiagram({symbol:'score',callers:[n('rank')],total:1,callees:[n('clean')]}),['rank ─────▶ score ─────▶ clean']);
 assert.deepEqual(graphDiagram({symbol:'leaf',callers:['x','y'].map(n),total:6,callees:[]}),['      x ──┐','      y ──┼──▶ leaf','+4 more ──┘']);
 // The map shows the drawing under its title.
 const lines=renderGraph({indexed:true,symbol:'score',file:'s.py',line:3,callers:[n('rank')],total:1,callees:[n('clean')],tests:[],affectedFiles:0});
 assert.match(lines[1],/rank ─────▶ score ─────▶ clean/);
});

test('the code graph draws up to 10 callers, then +N more',async()=>{
 const {graphDiagram}=await import('../lib/code-tutor.mjs');
 const n=x=>({name:x,file:'a.py',line:1});
 const callers=Array.from({length:12},(_,k)=>n('c'+k));
 const lines=graphDiagram({symbol:'hub',callers,total:14,callees:[n('leaf')]});
 assert.equal(lines.filter(l=>/c\d+ ──/.test(l)).length,10);
 assert.ok(lines.some(l=>l.includes('+4 more ──')));
 assert.equal(lines.length,11);
});
