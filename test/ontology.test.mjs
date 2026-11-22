// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OntologyReader,memberType,mermaidLines,namesOfChange,renderOntology} from '../lib/ontology.mjs';

const REPLY={count:3,models:[
 {name:'DirectoryDraft',file:'pkg/draft.py',line:10,bases:['BaseModel'],doc:'One draft.',fields:[
  {name:'schema_version',annotation:'Literal[1, 2]',literals:[1,2],models:[]},
  {name:'media',annotation:'DraftMedia | None',literals:[],models:['DraftMedia']},
  {name:'note',annotation:'str | None',literals:[],models:[]}]},
 {name:'DraftMedia',file:'pkg/draft.py',line:3,bases:['BaseModel'],doc:'',fields:[{name:'url',annotation:'str',literals:[],models:[]}]}]};

test('the names of a change are its CamelCase words and the class that holds it',()=>{
 const change={before:['    note: str | None = None'],after:['    media: DraftMedia | None = None','    x = Literal["a"]']};
 assert.deepEqual(namesOfChange(change,'DirectoryDraft'),['DraftMedia','DirectoryDraft']);
 assert.deepEqual(namesOfChange(change,'draft_unit'),['DraftMedia']);
});

test('the ontology panel shows each model, its place and its fields, changed fields and links first',()=>{
 const change={before:[],after:['    media: DraftMedia | None = None']};
 const lines=renderOntology(REPLY,change);
 assert.match(lines[0],/Ontology at play: 2 Pydantic models \(of 3 in the folder\)/);
 assert.match(lines[1],/DirectoryDraft \(BaseModel\)  pkg\/draft\.py:10/);
 assert.match(lines[3],/├─ media ──▶ DraftMedia \(changed\)/);
 assert.match(lines.join('\n'),/schema_version : 1 \| 2/);
 assert.deepEqual(renderOntology({models:[],count:0},change),[]);
 assert.deepEqual(renderOntology(null,change),[]);
 // Escape bytes in a doc line never reach the terminal.
 const evil={count:1,models:[{...REPLY.models[1],doc:'x\u001b]0;owned\u0007y'}]};
 assert.ok(renderOntology(evil,change).every(l=>!l.includes('\u001b')));
});

test('the mermaid classDiagram uses only syntax that mermaid reads',()=>{
 const lines=mermaidLines(REPLY.models);
 assert.equal(lines[0],'```mermaid');assert.equal(lines[1],'classDiagram');assert.equal(lines.at(-1),'```');
 assert.ok(lines.includes('    schema_version Literal'));
 assert.ok(lines.includes('    media DraftMedia or None'));
 assert.ok(lines.includes('  DirectoryDraft --> DraftMedia : media'));
 assert.equal(memberType({annotation:'list[PageRef]',literals:[]}),'list~PageRef~');
 assert.ok(lines.every(l=>!/["|{}]/.test(l.replace(/^  class \w+ \{$|^  \}$/,''))));
});

test('ontology.py reads models with ast: the folder code never runs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'wtf-onto-'));
 try{
  mkdirSync(join(dir,'pkg'));
  writeFileSync(join(dir,'pkg','base.py'),'from pydantic import BaseModel\nclass Record(BaseModel):\n    """A record."""\n    id: str\n');
  writeFileSync(join(dir,'pkg','draft.py'),`import pathlib\npathlib.Path(${JSON.stringify(join(dir,'ran'))}).write_text('x')\nfrom pkg.base import Record\nfrom typing import Literal\nclass Media(Record):\n    url: str\nclass Draft(Record):\n    kind: Literal['a', 'b']\n    media: Media | None = None\nclass Plain:\n    x: int\n`);
  const reader=new OntologyReader(dir);
  const reply=await reader.ask('',['Draft','Plain','Missing']);
  reader.close();
  assert.equal(existsSync(join(dir,'ran')),false,'the folder code ran');
  assert.equal(reply.count,3);
  assert.deepEqual(reply.models.map(m=>m.name),['Draft']);
  const [draft]=reply.models;
  assert.deepEqual(draft.bases,['Record']);
  assert.deepEqual(draft.fields.map(f=>[f.name,f.literals,f.models]),[['kind',['a','b'],[]],['media',[],['Media']]]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
