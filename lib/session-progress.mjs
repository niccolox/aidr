// SPDX-License-Identifier: AGPL-3.0-only
/** Progress of long-running work in a Claude session (aidr). Owner, 22 November 2026: "allow aiwtf to show
 * progress of long running process".
 *
 * A tool call is running from its tool_use entry until its tool_result. A background command (Bash with
 * run_in_background) is running from its "Command running in background with ID" result until a task notice with that
 * ID says completed, failed or killed. The watch prints one line a minute for each that has run for more than 30
 * seconds, with the last line of a background command's output file (through safe()), and one line when it ends. */
import {closeSync,openSync,readSync,statSync} from 'node:fs';
import {safe} from './code-tutor.mjs';

const BACKGROUND=/Command running in background with ID: (\w+)\.[\s\S]*?Output is being written to: (\S+\.output)/;
const NOTICE=/<task-id>(\w+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g;
const text=part=>typeof part?.content==='string'?part.content:Array.isArray(part?.content)?part.content.map(p=>p?.text||'').join('\n'):'';

/** The running work of one conversation, fed entry by entry. */
export class Progress{
 constructor(){this.calls=new Map();this.background=new Map();}
 /** Feed one transcript entry; returns the background commands that ended with this entry: [{id, text, status, seconds}]. */
 feed(entry,now=Date.now()){
  const content=entry?.message?.content,ended=[];
  const at=Date.parse(entry?.timestamp||'')||now;
  if(entry?.type==='assistant'&&Array.isArray(content)){
   for(const p of content)if(p?.type==='tool_use'&&p.id)this.calls.set(p.id,{name:String(p.name||'tool'),text:safe(String(p.input?.description||p.input?.command||'').split('\n')[0]).slice(0,120),started:at});
  }
  if(entry?.type==='user'){
   const parts=Array.isArray(content)?content:[{type:'text',text:String(content||'')}];
   for(const p of parts){
    if(p?.type==='tool_result'){
     const call=this.calls.get(p.tool_use_id);this.calls.delete(p.tool_use_id);
     const bg=text(p).match(BACKGROUND);
     if(bg&&call)this.background.set(bg[1],{...call,path:bg[2],started:at});
    }
    const raw=p?.type==='text'?String(p.text||''):p?.type==='tool_result'?text(p):'';
    for(const m of raw.matchAll(NOTICE)){
     const job=this.background.get(m[1]);
     if(job&&m[2]!=='running'){this.background.delete(m[1]);ended.push({id:m[1],text:job.text,status:m[2],seconds:Math.round((at-job.started)/1000)});}
    }
   }
  }
  return ended;
 }
 /** The work that has run for more than min seconds: [{kind, name, text, seconds, last}]. */
 running(now=Date.now(),{min=30,tail=lastLine}={}){
  const out=[];
  for(const c of this.calls.values()){const s=Math.round((now-c.started)/1000);if(s>=min)out.push({kind:'call',name:c.name,text:c.text,seconds:s,last:''});}
  for(const [id,b] of this.background){const s=Math.round((now-b.started)/1000);if(s>=min)out.push({kind:'background',name:id,text:b.text,seconds:s,last:tail(b.path)});}
  return out;
 }
}

/** The last non-empty line of a background command's output file, filtered: only a file under a tasks folder. */
export function lastLine(path){
 if(!/\/tasks\/\w+\.output$/.test(String(path||'')))return '';
 try{
  const size=statSync(path).size,length=Math.min(size,4096),buffer=Buffer.alloc(length),fd=openSync(path,'r');
  try{readSync(fd,buffer,0,length,size-length);}finally{closeSync(fd);}
  const lines=buffer.toString('utf8').split('\n').map(l=>safe(l).trim()).filter(Boolean);
  return (lines.at(-1)||'').slice(0,120);
 }catch{return '';}
}

export const clockOf=seconds=>seconds<60?`${seconds} s`:seconds<3600?`${Math.floor(seconds/60)} min ${seconds%60} s`:`${Math.floor(seconds/3600)} h ${Math.floor(seconds%3600/60)} min`;
