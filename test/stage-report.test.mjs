// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {markMoves,parseDiff,rangeOf,renderStage} from '../lib/stage-report.mjs';

const DIFF=`diff --git a/pkg/a.py b/pkg/a.py
--- a/pkg/a.py
+++ b/pkg/a.py
@@ -1,2 +0,0 @@
-def moved():
-    return 1
@@ -9,0 +8,4 @@
+# a new header
+def moved():
+    return 1
+NEW = 2
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

test('a diff becomes code hunks; documents are left out',()=>{
 const hunks=parseDiff(DIFF);
 assert.equal(hunks.length,2);
 assert.deepEqual(hunks.map(h=>h.file),['pkg/a.py','pkg/a.py']);
 assert.deepEqual(hunks[1].after,['# a new header','def moved():','    return 1','NEW = 2']);
});

test('a hunk that only moves code is a move; a new code line makes it a change; comments are neutral',()=>{
 const [gone,added]=markMoves(parseDiff(DIFF));
 assert.equal(gone.moved,true);
 assert.equal(added.moved,false);
 assert.deepEqual(added.changedAfter,['NEW = 2']);
 const [only]=markMoves(parseDiff(DIFF.replace('+NEW = 2\n','')).slice(1));
 assert.equal(only.moved,false,'alone, the added lines have no removed twin');
 const both=markMoves(parseDiff(DIFF.replace('+NEW = 2\n','')));
 assert.equal(both[1].moved,true);
});

test('a single commit becomes its own range; anything else is refused',()=>{
 assert.equal(rangeOf('974bfa17'),'974bfa17~1..974bfa17');
 assert.equal(rangeOf('a1..HEAD'),'a1..HEAD');
 assert.equal(rangeOf(),'HEAD~1..HEAD');
 assert.throws(()=>rangeOf('HEAD; rm -rf /'));
});

test('the report has the two tables, and says when a symbol has no test',()=>{
 const lines=renderStage({range:'a..b',files:1,
  models:[{name:'Draft',bases:['BaseModel'],file:'pkg/a.py',line:3,changed:['media'],fields:[{name:'media',models:['Media']}]}],
  graphs:[{symbol:'run',moved:false,file:'pkg/a.py',line:9,callers:[{name:'tick'}],total:1,callees:[{name:'Draft'}],tests:[]}]});
 assert.ok(lines.includes('| Draft | BaseModel | pkg/a.py:3 | media | Media |'));
 assert.ok(lines.includes('| run | changed | pkg/a.py:9 | tick | Draft | **none** |'));
 const empty=renderStage({range:'a..b',files:0,models:[],graphs:[]});
 assert.ok(empty.includes('No Pydantic model is defined or used in the changed lines.'));
 assert.ok(empty.includes('No changed function or class is in the CodeGraph index.'));
});
