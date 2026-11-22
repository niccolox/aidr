// SPDX-License-Identifier: AGPL-3.0-only
/** The agent map and its heartbeat (owner, 22 November 2026: "can aidr do an agent map heart beat every 10 minutes? I
 * want to see if agents are running and their heart beat"). Engineer, Operator, AI Agent.
 *
 * Each conversation of the watch is one row of the map, and each subagent that it started is a row under it. Claude
 * Code writes a subagent's transcript to <conversation>/subagents/agent-<id>.jsonl and its settings to
 * agent-<id>.meta.json (the description, the worktree and its branch). When a background subagent ends, the parent
 * transcript gets a task notice with its id and status. The heartbeat of an agent is the time of the last line of
 * its transcript.
 *
 *   running   a line in the last 3 minutes, and no end notice
 *   quiet     the last line 3 to 10 minutes ago, and no end notice
 *   stalled   no line for more than 10 minutes, and no end notice
 *   finished  an end notice with the status completed, a delivered hand-back (SubagentHandback and its result) as
 *             the last step, or finished: true in the meta file
 *   failed    an end notice with another status (failed, killed)
 *
 * Read only: it reads the transcripts, the meta files and, for an agent with a worktree, git in that worktree (with
 * GIT_SAFE: no command of the folder's own configuration). Every text goes through safe(). */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GIT_ENV, GIT_SAFE, safe } from './code-tutor.mjs';

export const HEARTBEAT_MINUTES = 10;
const RUNNING_SECONDS = 180,
  STALLED_SECONDS = 600,
  TAIL = 262_144;
const ID = /^agent-([a-z0-9]+)\.jsonl$/;

/** bytes of a file from a position, as text. */
function slice(file, from, bytes) {
  const buffer = Buffer.alloc(bytes),
    fd = openSync(file, 'r');
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, from)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The last bytes of a file as text (at most TAIL), from the first whole line. */
function tailOf(file, bytes = TAIL) {
  const size = statSync(file).size,
    text = slice(file, Math.max(0, size - bytes), Math.min(size, bytes));
  return size > bytes ? text.slice(text.indexOf('\n') + 1) : text;
}

/** The tool calls in a whole transcript: the count of tool_use parts, read in 1 MB chunks. */
export function toolCalls(file) {
  const size = statSync(file).size,
    mark = '"type":"tool_use"';
  let count = 0,
    carry = '';
  for (let from = 0; from < size; from += 1_048_576) {
    const text = carry + slice(file, from, Math.min(1_048_576, size - from));
    count += text.split(mark).length - 1;
    carry = text.slice(-(mark.length - 1));
  }
  return count;
}

/** The first lines of a file: its first 64 KB. */
const headOf = file => slice(file, 0, Math.min(statSync(file).size, 65_536)).split('\n');

/** The end notices in a parent transcript's text: Map(agent id → status). */
export function endNotices(text) {
  const ends = new Map();
  for (const m of String(text).matchAll(/<task-id>([a-z0-9]+)<\/task-id>[\s\S]{0,400}?<status>([a-z_]+)<\/status>/g))
    ends.set(m[1], m[2]);
  return ends;
}

/** The tool_use ids that have a tool result in a transcript's text. */
export const resultIds = text => [...String(text).matchAll(/"tool_use_id":"(toolu_[A-Za-z0-9]+)"/g)].map(m => m[1]);

/** The state of an agent from its end notice and the seconds since its last line. */
export function stateOf(end, idleSeconds) {
  if (end === 'completed') return 'finished';
  if (end) return 'failed';
  if (idleSeconds <= RUNNING_SECONDS) return 'running';
  return idleSeconds <= STALLED_SECONDS ? 'quiet' : 'stalled';
}

/** The facts of one subagent transcript: started, the last line's time, the tool calls, the last step. */
export function transcriptFacts(lines) {
  let started = null,
    last = null,
    tools = 0,
    step = '',
    tool = '',
    handedBack = false;
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.timestamp) {
      started ??= e.timestamp;
      last = e.timestamp;
    }
    if (e.type === 'assistant' && Array.isArray(e.message?.content))
      for (const p of e.message.content)
        if (p?.type === 'tool_use') {
          tools++;
          tool = p.name;
          handedBack = false;
          const i = p.input || {};
          step = `${p.name}${i.description || i.file_path ? ' | ' + (i.description || i.file_path) : ''}`;
        }
    // A background agent that hands its report back gets no end notice: the delivered result of its last tool call,
    // SubagentHandback, is its end. Work after it (the caller resumed the agent) starts it again.
    if (tool === 'SubagentHandback' && e.type === 'user' && Array.isArray(e.message?.content))
      if (e.message.content.some(p => p?.type === 'tool_result' && !p.is_error)) handedBack = true;
  }
  return { started, last, tools, step: safe(step).slice(0, 120), handedBack };
}

/** Commits on the agent's branch that its parent branch does not have, and the files changed and not committed. */
function worktreeFacts(path, base) {
  if (!path || !existsSync(path)) return null;
  const git = args =>
    execFileSync('git', [...GIT_SAFE, '-C', path, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  try {
    const commits = base ? Number(git(['rev-list', '--count', `${base}..HEAD`]).trim()) : null;
    const open = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
    return { commits, open };
  } catch {
    return null;
  }
}

/** The subagents of one conversation transcript, newest first. now is in milliseconds. */
export function agentsOf(file, { now = Date.now(), base = null } = {}) {
  const dir = join(file.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return [];
  const ends = existsSync(file) ? endNotices(tailOf(file, 8_000_000)) : new Map();
  // An agent that another agent started gets its end notice in that agent's transcript, not in the session's. A
  // foreground agent gets no notice: its result is the tool result of the Agent call that started it (meta.toolUseId).
  const results = new Set(resultIds(existsSync(file) ? tailOf(file, 8_000_000) : ''));
  for (const name of readdirSync(dir).filter(n => ID.test(n))) {
    const text = tailOf(join(dir, name), 2_000_000);
    for (const [id, status] of endNotices(text)) if (!ends.has(id)) ends.set(id, status);
    for (const id of resultIds(text)) results.add(id);
  }
  // A background agent's launch call returns at once, so only a foreground agent ends with its call's result.
  const endOf = (id, meta, facts) =>
    ends.get(id) ||
    (meta.finished === true || facts.handedBack ? 'completed' : null) ||
    (meta.requestShape !== 'background' && results.has(meta.toolUseId) ? 'completed' : null);
  const agents = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(ID);
    if (!m) continue;
    const path = join(dir, name);
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    } catch {}
    // The first line gives the start; the last part gives the heartbeat, the tool calls seen and the last step.
    const facts = transcriptFacts([headOf(path)[0], ...tailOf(path).split('\n')]);
    const lastMs = facts.last ? Date.parse(facts.last) : statSync(path).mtimeMs;
    const idle = Math.max(0, Math.round((now - lastMs) / 1000));
    agents.push({
      id: m[1],
      description: safe(meta.description || meta.agentType || 'agent').slice(0, 80),
      branch: meta.worktreeBranch ? safe(meta.worktreeBranch) : null,
      worktree: meta.worktreePath || null,
      started: facts.started,
      idle,
      tools: toolCalls(path),
      step: facts.step,
      end: endOf(m[1], meta, facts),
      state: stateOf(endOf(m[1], meta, facts), idle),
      git: meta.worktreePath ? worktreeFacts(meta.worktreePath, base) : null,
    });
  }
  return agents.sort((a, b) => String(b.started).localeCompare(String(a.started)));
}

const ICON = { running: '🟢', quiet: '🟡', stalled: '🔴', finished: '✅', failed: '❌' };
const COLOUR = { running: 'green', quiet: 'yellow', stalled: 'red', finished: 'gray', failed: 'red' };
const since = s => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** The map as lines: a heading, then each conversation with its agents. rows: [{folder, title, sessionId, idle,
 * agents}]. look: {icons, paint(kind, text)}. */
export function renderAgentMap(rows, { icons = false, paint = (k, t) => t, clock = '' } = {}) {
  const all = rows.flatMap(r => r.agents),
    count = s => all.filter(a => a.state === s).length;
  const parts = ['running', 'quiet', 'stalled', 'finished', 'failed']
    .filter(s => count(s))
    .map(s => `${count(s)} ${s}`);
  const out = [
    paint(
      'bold',
      `${clock ? clock + '  ' : ''}${icons ? '💓 ' : ''}Agent map: ${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}, ${all.length ? parts.join(', ') : 'no agents'} (every ${HEARTBEAT_MINUTES} min)`,
    ),
  ];
  for (const r of rows) {
    out.push(
      `  ${paint('blue', r.folder)}  ${r.title ? '"' + r.title + '"  ' : ''}${paint('gray', String(r.sessionId || '').slice(0, 8))}  last line ${since(r.idle ?? 0)} ago`,
    );
    r.agents.forEach((a, n) => {
      const branch = n === r.agents.length - 1 ? '└' : '├';
      const git = a.git
        ? `  ${a.git.commits ?? '?'} ${a.git.commits === 1 ? 'commit' : 'commits'}, ${a.git.open} open ${a.git.open === 1 ? 'file' : 'files'}`
        : '';
      const age = a.started ? since(Math.max(0, Math.round((Date.now() - Date.parse(a.started)) / 1000))) : '?';
      out.push(
        `    ${branch} ${icons ? ICON[a.state] + ' ' : ''}${paint(COLOUR[a.state], a.state.padEnd(8))} ${a.description}  ${paint('gray', `age ${age}, ${a.tools} steps, heartbeat ${since(a.idle)} ago${git}`)}`,
      );
      if (a.step && (a.state === 'running' || a.state === 'quiet' || a.state === 'stalled'))
        out.push(`    ${n === r.agents.length - 1 ? ' ' : '│'}   ${paint('gray', 'last step: ' + a.step)}`);
    });
  }
  return out;
}

/** The branch a conversation started on (the gitBranch of its first entry), the base for the agent commit count. */
export function branchOf(file) {
  try {
    for (const line of headOf(file)) {
      try {
        const e = JSON.parse(line);
        if (e.gitBranch) return /^[\w./-]+$/.test(e.gitBranch) ? e.gitBranch : null;
      } catch {}
    }
  } catch {}
  return null;
}

/** The map rows of the conversations of the watch or the list. */
export function mapRows(conversations, now = Date.now()) {
  return conversations
    .filter(c => c.file && existsSync(c.file))
    .map(c => ({
      folder: c.folder || basename(c.cwd || ''),
      title: c.title || null,
      sessionId: c.sessionId,
      idle: Math.round((now - statSync(c.file).mtimeMs) / 1000),
      agents: agentsOf(c.file, { now, base: branchOf(c.file) }),
    }));
}
