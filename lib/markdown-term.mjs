// SPDX-License-Identifier: AGPL-3.0-only
/** Claude's Markdown as terminal lines (aidr --busywork). Owner, 21 November 2026: "format in npm aiwtf, use the
 * appropriate pretty display".
 *
 * Headings, bullet and numbered lists, bold and code spans, links, tables (columns lined up) and fenced code blocks
 * (coloured by code-tutor.mjs highlight). Long lines wrap at the terminal width under their own indent. The caller has
 * already passed every line through safe() (no control bytes, secrets masked); this module adds only its own colours.
 */
import {highlight,langOf} from './code-tutor.mjs';

// oxlint-disable-next-line no-control-regex -- it removes the watch's own colour codes to count visible characters.
const visible=text=>String(text).replace(/\u001b\[[0-9;]*m/g,'');

/** One line of inline Markdown: **bold**, `code`, [text](url), *italic*. */
export function inline(text,paint=(c,t)=>t){
 return String(text)
  .replace(/`([^`]+)`/g,(_,code)=>paint('string',code))
  .replace(/\*\*([^*]+)\*\*/g,(_,b)=>paint('bold',b))
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(_,t,u)=>t+' '+paint('gray','('+u+')'))
  .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g,(_,pre,i)=>pre+paint('dim',i));
}

/** Word wrap that counts only visible characters. */
export function wrap(text,width){
 if(width<20||visible(text).length<=width)return [text];
 const out=[];let line='';
 for(const word of String(text).split(' ')){
  if(line&&visible(line).length+1+visible(word).length>width){out.push(line);line=word;}
  else line=line?line+' '+word:word;
 }
 if(line)out.push(line);
 return out;
}

function table(rows,paint){
 const cells=rows.filter(r=>!/^\s*\|?\s*:?-{2,}/.test(r)).map(r=>r.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim()));
 const count=Math.max(...cells.map(r=>r.length));
 const widths=Array.from({length:count},(_,k)=>Math.min(40,Math.max(...cells.map(r=>visible(inline(r[k]??'')).length))));
 const cut=(t,w)=>{const v=visible(t);return v.length>w?v.slice(0,w-1)+'…':t+' '.repeat(w-v.length);};
 return cells.map((r,i)=>{
  const line=r.map((c,k)=>cut(inline(c,paint),widths[k])).join(paint('gray',' │ '));
  return i===0?paint('bold',line):line;
 }).flatMap((line,i)=>i===0?[line,paint('gray',widths.map(w=>'─'.repeat(w)).join('─┼─'))]:[line]);
}

/** The lines of a Markdown text for the terminal, without indent. width: the room for the text. */
export function markdownLines(lines,{paint=(c,t)=>t,width=100}={}){
 const out=[];let fence=null,rows=[],blank=false;
 const flush=()=>{if(rows.length){out.push(...table(rows,paint));rows=[];}};
 for(const raw of lines){
  const line=String(raw).replace(/\s+$/,'');
  if(fence!==null){
   if(/^\s*```/.test(line)){fence=null;continue;}
   out.push(paint('gray','  ')+highlight(line,fence,paint));continue;
  }
  const open=line.match(/^\s*```\s*([\w.+-]*)/);
  if(open){flush();blank=false;fence=langOf('x.'+(open[1]==='python'?'py':open[1]||'txt'));continue;}
  if(/^\s*\|.*\|\s*$/.test(line)){rows.push(line);blank=false;continue;}
  flush();
  if(!line.trim()){if(!blank&&out.length)out.push('');blank=true;continue;}
  blank=false;
  const heading=line.match(/^(#{1,6})\s+(.*)$/);
  if(heading){out.push(paint('magenta',paint('bold',(heading[1].length<=2?'▍ ':'')+visible(inline(heading[2])))));continue;}
  const bullet=line.match(/^(\s*)[-*+]\s+(.*)$/),number=line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
  if(bullet||number){
   const depth=Math.floor((bullet?.[1]??number[1]).length/2),mark=bullet?'•':number[2]+'.',pad='  '.repeat(depth);
   const body=wrap(inline(bullet?bullet[2]:number[3],paint),width-pad.length-mark.length-1);
   body.forEach((part,k)=>out.push(pad+(k?' '.repeat(mark.length):paint('cyan',mark))+' '+part));
   continue;
  }
  out.push(...wrap(inline(line,paint),width));
 }
 flush();
 while(out.length&&out.at(-1)==='')out.pop();
 return out;
}
