// SPDX-License-Identifier: AGPL-3.0-only
/** The Pydantic ontology at play in a code change (aidr). Owner, 21 November 2026: "update npm local wtf to show
 * the relevant Python Pydantic Ontology at play, focus on Ontology, is it possible to show mermaid in terminal?"
 *
 * For a Python change, the watch names the Pydantic models that the change defines or uses: the CamelCase names in the
 * changed lines and the class that holds the change. ontology.py (one process for the whole watch) reads the folder
 * with Python's ast, so no code of the folder is imported or run, and answers with each model's fields and the models
 * each field links to. The terminal shows them as a small tree with arrows; --mermaid also prints the same models as a
 * mermaid classDiagram, ready to paste into a document. A terminal cannot draw mermaid itself: mermaid-ascii draws only
 * flowcharts as text, and images need a terminal with an image protocol (kitty, iTerm2, sixel) and mmdc with a browser.
 * Every printed name and doc line goes through safe() (code-tutor.mjs). */
import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {safe} from './code-tutor.mjs';

const SCRIPT=join(dirname(fileURLToPath(import.meta.url)),'ontology.py');
const FIRST_SECONDS=60,NEXT_SECONDS=15;
const IGNORE=new Set(['None','True','False','Literal','Optional','Annotated','Field','BaseModel','ConfigDict','Any','Self','Exception','ValueError','TypeError','Path','UUID','Decimal','Fraction','datetime','date','Agent','RunContext','ModelRetry']);

/** The CamelCase names of a change and of the class that holds it: the candidates for models. */
export function namesOfChange(change,enclosingName=''){
 const out=new Set();
 for(const line of [...change.before,...change.after])for(const m of String(line).matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][a-z]{2,}\b/g))if(!IGNORE.has(m[0]))out.add(m[0]);
 if(/^[A-Z]/.test(enclosingName))out.add(enclosingName);
 return [...out].slice(0,40);
}

/** One ontology.py process for a folder; ask() sends one request and gets one reply line. */
export class OntologyReader{
 constructor(cwd,{python='python3',start=spawn}={}){this.cwd=cwd;this.python=python;this.start=start;this.child=null;this.waiting=[];this.buffer='';this.asked=0;this.dead=false;}
 #open(){
  if(this.child||this.dead)return;
  this.child=this.start(this.python,['-I',SCRIPT,'--serve',this.cwd],{cwd:this.cwd,stdio:['pipe','pipe','ignore']});
  this.child.on('error',()=>{this.dead=true;this.#fail();});
  this.child.on('exit',()=>{this.dead=true;this.child=null;this.#fail();});
  this.child.stdout.setEncoding('utf8');
  this.child.stdout.on('data',chunk=>{
   this.buffer+=chunk;let at;
   while((at=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,at);this.buffer=this.buffer.slice(at+1);const next=this.waiting.shift();if(next){clearTimeout(next.timer);try{next.done(JSON.parse(line));}catch{next.done(null);}}}
  });
 }
 #fail(){for(const w of this.waiting.splice(0)){clearTimeout(w.timer);w.done(null);}}
 /** The models among names, or null when the reader is not available or too slow. */
 ask(file,names){
  this.#open();if(this.dead||!this.child)return Promise.resolve(null);
  const seconds=this.asked++?NEXT_SECONDS:FIRST_SECONDS;
  return new Promise(done=>{
   const entry={done,timer:setTimeout(()=>{const k=this.waiting.indexOf(entry);if(k>=0)this.waiting.splice(k,1);done(null);},seconds*1000)};
   this.waiting.push(entry);
   this.child.stdin.write(JSON.stringify({file,names})+'\n');
  });
 }
 close(){if(this.child){this.child.stdin.end();this.child.kill();this.child=null;}}
}

const FIELDS=8;
const fieldText=f=>f.literals?.length?f.literals.map(v=>JSON.stringify(v)).join(' | '):f.annotation;

/** The ontology panel of a change: each model, its base, its place, and its fields with arrows to linked models.
 * Fields that the change names come first, then fields that link to another model. */
export function renderOntology(reply,change,{paint=(c,t)=>t,icons=false,mermaid=false}={}){
 if(!reply?.models?.length)return [];
 const bar=paint('gray','│'),words=new Set([...change.before,...change.after].join(' ').match(/\b[a-z_][a-z0-9_]*\b/g)||[]);
 const out=[`  ${bar} ${paint('magenta',(icons?'🧬 ':'')+'Ontology at play:')} ${paint('bold',`${reply.models.length} Pydantic model${reply.models.length===1?'':'s'}`)} ${paint('gray',`(of ${reply.count} in the folder)`)}`];
 for(const m of reply.models.slice(0,4)){
  out.push(`  ${bar}   ${paint('definition',safe(m.name))} ${paint('gray','('+m.bases.map(safe).join(', ')+')')}  ${paint('gray',safe(m.file)+':'+m.line)}`);
  if(m.doc)out.push(`  ${bar}     ${paint('comment',safe(m.doc).slice(0,140))}`);
  const ranked=[...m.fields].sort((a,b)=>(words.has(b.name)-words.has(a.name))||((b.models.length>0)-(a.models.length>0)));
  const shown=ranked.slice(0,FIELDS);
  shown.forEach((f,k)=>{
   const last=k===shown.length-1&&m.fields.length<=FIELDS,branch=last?'└─':'├─',mark=words.has(f.name)?paint('yellow',icons?' ✎':' (changed)'):'';
   const link=f.models.length?` ${paint('gray','──▶')} ${f.models.map(x=>paint('type',safe(x))).join(', ')}`:` ${paint('gray',':')} ${paint('string',safe(fieldText(f)).slice(0,70))}`;
   out.push(`  ${bar}     ${paint('gray',branch)} ${safe(f.name)}${link}${mark}`);
  });
  if(m.fields.length>FIELDS)out.push(`  ${bar}     ${paint('gray',`└─ … ${m.fields.length-FIELDS} more fields`)}`);
 }
 if(reply.models.length>4)out.push(`  ${bar}   ${paint('gray',`… and ${reply.models.length-4} more: ${reply.models.slice(4,10).map(m=>safe(m.name)).join(', ')}`)}`);
 if(mermaid)for(const line of mermaidLines(reply.models))out.push(`  ${bar}   ${paint('gray',line)}`);
 return out;
}

/** A field type that mermaid's class syntax reads: Literal for a fixed value list, generics with ~, no | or quotes. */
export function memberType(f){
 if(f.literals?.length)return 'Literal';
 return safe(f.annotation).replace(/\[/g,'~').replace(/\]/g,'~').replace(/\s*\|\s*/g,' or ').replace(/[^A-Za-z0-9_~ ,.]/g,'').replace(/\s+/g,' ').trim().slice(0,40)||'Any';
}

/** The models as a mermaid classDiagram: one class block each, and an arrow for each field that links a model. */
export function mermaidLines(models){
 const id=n=>safe(n).replace(/[^A-Za-z0-9_]/g,'_');
 const out=['```mermaid','classDiagram'];
 for(const m of models.slice(0,8)){
  out.push(`  class ${id(m.name)} {`);
  for(const f of m.fields.slice(0,12))out.push(`    ${id(f.name)} ${memberType(f)}`);
  out.push('  }');
 }
 for(const m of models.slice(0,8))for(const f of m.fields)for(const target of f.models)out.push(`  ${id(m.name)} --> ${id(target)} : ${id(f.name)}`);
 for(const m of models.slice(0,8))for(const b of m.bases)if(models.some(x=>x.name===b))out.push(`  ${id(b)} <|-- ${id(m.name)}`);
 out.push('```');
 return out;
}
