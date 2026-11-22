// SPDX-License-Identifier: AGPL-3.0-only
/** aidr journal: a daily, weekly and monthly journal of a folder, and its project lifecycle (WTF-PKG-1 section 9.12).
 *
 *   aidr journal                    today (aidr -- journal week for the week)
 *   aidr -- journal week           this week (Monday to Sunday, local time)
 *   aidr -- journal month          this month
 *   aidr -- journal project        the lifecycle of the folder: one row for each month, tags, top folders, tasks
 *   aidr -- journal week --date 2026-11-17     the week of that day
 *
 * Owner, 22 November 2026: "make aidr create a journal, a daily, weekly, monthly and project lifecycle"; "build aidr
 * journal" (Q13 to Q15 with the recommendations: print only, no model, a week starts on Monday).
 *
 * Read only: the transcripts of the folder (~/.claude/projects/<folder>) and read-only git. The journal prints
 * Markdown; `aidr journal week > journal.md` keeps it, aidr writes no file. Every text goes through safe(); a private
 * file is never named. Fixed rules only: the journal counts and lists, no model writes a summary. */
import { execFileSync } from 'node:child_process';
import { closeSync, createReadStream, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { GIT_ENV, GIT_SAFE, changesOf, isPrivatePath, safe } from './code-tutor.mjs';
import { ChangeFeed } from './change-feed.mjs';

const PERIODS = ['day', 'week', 'month', 'project'];
export const PERIODS_OF = PERIODS;
const LONG_SECONDS = 120;
const TEST_COMMAND =
  /\b(?:node --test|pytest|npm (?:run )?test\b|npm run test:|vitest|jest|playwright test|make test|go test|cargo test|uv run pytest)/;
const CODE = /\.(?:py|mjs|js|ts|tsx|go|rs|java|rb|php|cs|kt|swift)$/;

const cut = (text, max) => {
  const line = safe(String(text || '').replace(/\s+/g, ' ')).trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
};
const pad = n => String(n).padStart(2, '0');
/** The local date of a time as YYYY-MM-DD. */
export const dayKey = time => {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const clock = time => {
  const d = new Date(time);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const longDate = time =>
  new Date(time).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthName = time => new Date(time).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The start and end (local time) of a period around a date. A week starts on Monday (Q15). */
export function periodOf(period, date = new Date()) {
  if (!PERIODS.includes(period)) throw new Error(`Give one of: ${PERIODS.join(', ')}.`);
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (period === 'day') return { start: d, end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) };
  if (period === 'week') {
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    return { start: monday, end: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7) };
  }
  if (period === 'month')
    return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: new Date(d.getFullYear(), d.getMonth() + 1, 1) };
  return { start: new Date(0), end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) };
}

/** --date YYYY-MM-DD as a local date; a bad value is an error. */
export function dateOf(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  const d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!d || d.getMonth() !== Number(m[2]) - 1) throw new Error('Give --date as YYYY-MM-DD.');
  return d;
}

// --- The transcripts ---

/** The time of one transcript line, read without parsing the line: Claude Code writes "timestamp" after the message. */
export function lineTime(line) {
  const at = line.lastIndexOf('"timestamp":"');
  if (at < 0) return NaN;
  const end = line.indexOf('"', at + 13);
  return Date.parse(line.slice(at + 13, end));
}

const CHUNK = 4 * 1024 * 1024;
/** Where to start reading a transcript for a period that starts at start: Claude Code appends entries in time order,
 * so the search goes back from the end in 4 MB steps until it finds a time before start. A text inside a message that
 * looks like a timestamp can only make the start earlier, and every line is checked again when it is read. */
export function startOffset(file, start, chunk = CHUNK) {
  const size = statSync(file).size;
  const fd = openSync(file, 'r'),
    buffer = Buffer.alloc(chunk);
  try {
    for (let pos = size; pos > 0; ) {
      pos = Math.max(0, pos - chunk);
      const read = readSync(fd, buffer, 0, chunk, pos),
        text = buffer.toString('utf8', 0, read);
      const at = text.indexOf('"timestamp":"');
      if (at >= 0 && Date.parse(text.slice(at + 13, text.indexOf('"', at + 13))) < start.getTime()) return pos;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

// API list prices in USD per million tokens (the Claude API price table of 3 November 2026). Cache writes use the
// standard multipliers: 1.25 times input for 5 minutes, 2 times input for 1 hour. Fast mode costs 2 times. A Claude
// Code subscription is billed differently, so the journal calls the sum the cost at API list price.
export const PRICES = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/** The token counts of one reply's usage, and its cost at API list price (null for a model with no price). */
export function usageOf(model, usage = {}) {
  const n = v => (Number.isFinite(v) && v > 0 ? v : 0);
  const split = usage.cache_creation || {};
  const write1h = n(split.ephemeral_1h_input_tokens);
  const write5m =
    split.ephemeral_5m_input_tokens != null
      ? n(split.ephemeral_5m_input_tokens)
      : n(usage.cache_creation_input_tokens) - write1h;
  const t = {
    input: n(usage.input_tokens),
    cacheWrite5m: Math.max(0, write5m),
    cacheWrite1h: write1h,
    cacheRead: n(usage.cache_read_input_tokens),
    output: n(usage.output_tokens),
  };
  const price = PRICES[String(model || '').replace(/-\d{8}$/, '')];
  if (!price) return { ...t, cost: null };
  const speed = usage.speed === 'fast' ? 2 : 1;
  const cost =
    (speed *
      (t.input * price.input +
        t.cacheWrite5m * price.input * 1.25 +
        t.cacheWrite1h * price.input * 2 +
        t.cacheRead * price.cacheRead +
        t.output * price.output)) /
    1e6;
  return { ...t, cost };
}

const TOKEN_KEYS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];
const addTokens = (into, u) => {
  for (const k of TOKEN_KEYS) into[k] = (into[k] || 0) + (u[k] || 0);
  into.cost = (into.cost || 0) + (u.cost || 0);
  if (u.cost === null || u.unpriced) into.unpriced = true;
  return into;
};
export const tokenTotal = (t = {}) => TOKEN_KEYS.reduce((a, k) => a + (t[k] || 0), 0);

const newDay = key => ({
  key,
  tokens: new Map(),
  agentTokens: {},
  sessions: new Map(),
  prompts: [],
  events: [],
  edits: 0,
  tests: [],
  long: [],
  commits: [],
});

/** Reads one transcript and adds the entries between start and end to the days. Lines outside the period are not
 * parsed, so a large transcript costs one search for each line. */
export async function readTranscript(file, { start, end, days }) {
  const feed = new ChangeFeed(),
    pending = new Map(),
    seen = new Set(),
    // An agent's transcript (<session>/subagents/agent-<id>.jsonl) adds only its tokens: its brief is not a prompt.
    agent = file.includes(`${sep}subagents${sep}`);
  const from = startOffset(file, start);
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8', start: from }),
    crlfDelay: Infinity,
  });
  let first = from > 0;
  for await (const line of lines) {
    // A read that starts inside the file begins in the middle of a line.
    if (first) {
      first = false;
      continue;
    }
    const time = lineTime(line);
    if (!(time >= start.getTime() && time < end.getTime())) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const key = dayKey(time);
    if (!days.has(key)) days.set(key, newDay(key));
    const day = days.get(key),
      content = entry?.message?.content;
    const session = String(entry.sessionId || basename(file, '.jsonl')).slice(0, 8);
    // Claude Code writes one entry for each content block of a reply, each with the same usage: count a reply once.
    const message = entry?.message;
    let used = null;
    if (entry.type === 'assistant' && message?.usage && message.id && !seen.has(message.id)) {
      seen.add(message.id);
      used = usageOf(message.model, message.usage);
      const model = String(message.model || 'unknown');
      day.tokens.set(model, addTokens(day.tokens.get(model) || {}, used));
      if (agent) addTokens(day.agentTokens, used);
    }
    if (agent) continue;
    const s = day.sessions.get(session) || { first: time, last: time, prompts: 0, tokens: {} };
    if (used) addTokens(s.tokens, used);
    s.first = Math.min(s.first, time);
    s.last = Math.max(s.last, time);
    day.sessions.set(session, s);
    if (entry.type === 'user' && !entry.isMeta) {
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content) && content.every(p => p?.type === 'text')
            ? content.map(p => p.text).join(' ')
            : '';
      // Text that the harness adds (reminders, task notices) is not a prompt of the person.
      if (text.trim() && !/^\s*</.test(text) && !text.startsWith('[Request interrupted')) {
        day.prompts.push({ time, text: cut(text, 120), session });
        s.prompts++;
      }
    }
    if (entry.type === 'assistant' && Array.isArray(content))
      for (const part of content) {
        if (part?.type !== 'tool_use') continue;
        const input = part.input || {},
          command = String(input.command || '');
        pending.set(part.id, {
          time,
          name: String(part.name || ''),
          text: cut(input.description || input.file_path || command.split('\n')[0] || part.name, 120),
          test: part.name === 'Bash' && TEST_COMMAND.test(command),
        });
      }
    for (const change of changesOf(entry)) {
      if (isPrivatePath(change.file)) continue;
      day.edits++;
    }
    if (entry.type === 'user' && Array.isArray(content))
      for (const part of content) {
        if (part?.type !== 'tool_result' || !pending.has(part.tool_use_id)) continue;
        const call = pending.get(part.tool_use_id);
        pending.delete(part.tool_use_id);
        const seconds = Math.round((time - call.time) / 1000);
        if (call.test) day.tests.push({ time: call.time, text: call.text, ok: !part.is_error });
        if (seconds >= LONG_SECONDS) day.long.push({ time: call.time, text: call.text, seconds, name: call.name });
      }
    for (const event of feed.events(entry))
      if (event.kind !== 'asked') day.events.push({ ...event, time: Date.parse(event.time) || time });
  }
}

/** The transcripts of a folder that can hold entries after start: the files changed since then. */
export function transcriptsOf(projects, folderName, start) {
  const dir = join(projects, folderName);
  if (!existsSync(dir)) return [];
  const top = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => join(dir, f));
  // The agents a session started write their own transcripts under <session>/subagents/.
  const agents = top.flatMap(f => {
    const folder = join(f.replace(/\.jsonl$/, ''), 'subagents');
    return existsSync(folder)
      ? readdirSync(folder)
          .filter(n => n.endsWith('.jsonl'))
          .map(n => join(folder, n))
      : [];
  });
  return [...top, ...agents].filter(f => statSync(f).mtimeMs >= start.getTime());
}

// --- git ---

const runGit = (cwd, args) => {
  try {
    return execFileSync('git', [...GIT_SAFE, '-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...GIT_ENV },
    });
  } catch {
    return '';
  }
};

/** The commits between start and end, each with its files (private files left out). */
export function commitsOf(cwd, { start, end, git = runGit }) {
  const out = git(cwd, [
    'log',
    `--since=${start.toISOString()}`,
    `--until=${end.toISOString()}`,
    '--no-renames',
    '--numstat',
    '--format=%x1e%H%x1f%aI%x1f%s',
  ]);
  return out
    .split('\x1e')
    .filter(Boolean)
    .map(block => {
      const [head, ...rest] = block.split('\n');
      const [hash, date, subject] = head.split('\x1f');
      const files = rest
        .map(l => l.split('\t'))
        .filter(p => p.length === 3 && !isPrivatePath(p[2]))
        .map(([a, r, file]) => ({ file, added: Number(a) || 0, removed: Number(r) || 0 }));
      return { hash: hash.slice(0, 8), time: Date.parse(date), subject: cut(subject, 120), files };
    })
    .filter(c => c.hash && c.time >= start.getTime() && c.time < end.getTime());
}

const SYMBOL =
  /(?:\bdef|\bclass|\bfunction\*?|\bfunc)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;
/** The functions and classes that the commits of a period changed: the names in the hunk headers of git, and the
 * names that added lines define. name -> { file, changes }. */
export function symbolsOf(cwd, { start, end, git = runGit }) {
  const out = git(cwd, [
    'log',
    `--since=${start.toISOString()}`,
    `--until=${end.toISOString()}`,
    '-p',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '--format=%x1e',
  ]);
  const symbols = new Map();
  let file = null;
  const add = name => {
    if (!name || !file) return;
    const known = symbols.get(name) || { file, changes: 0 };
    known.changes++;
    symbols.set(name, known);
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = line.split(' b/').pop();
      file = CODE.test(path) && !isPrivatePath(path) ? path : null;
    } else if (line.startsWith('@@')) {
      const m = SYMBOL.exec(line.replace(/^@@[^@]*@@/, ''));
      add(m && (m[1] || m[2]));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      const m = SYMBOL.exec(line.slice(1));
      if (m && /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|const|let|var|func)\b/.test(line.slice(1)))
        add(m[1] || m[2]);
    }
  }
  return symbols;
}

/** The Pydantic models among the changed symbols: the ontology reader (ontology.py, Python's ast) knows which
 * classes are models. Without python3 the list is empty. */
export async function modelsOf(cwd, symbols, reader) {
  if (!reader) return [];
  const byFile = new Map();
  for (const [name, s] of symbols)
    if (s.file.endsWith('.py')) byFile.set(s.file, [...(byFile.get(s.file) || []), name]);
  const models = new Set();
  for (const [file, names] of [...byFile].slice(0, 80)) {
    const reply = await reader.ask(join(cwd, file), names);
    for (const m of reply?.models || []) if (names.includes(m.name)) models.add(m.name);
  }
  return [...models].sort();
}

// --- The journal of a period ---

/** Everything the journal shows for one period of one folder. */
export async function collect({
  cwd,
  period,
  date = new Date(),
  projects,
  folderName,
  git = runGit,
  reader = null,
  note = () => {},
  now = new Date(),
}) {
  const { start, end } = periodOf(period, date);
  const days = new Map();
  const files = transcriptsOf(projects, folderName, start);
  const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
  if (bytes > 100 * 1024 * 1024)
    note(`Reading ${plural(files.length, 'transcript')} (${Math.round(bytes / 1024 / 1024)} MB) of this folder…`);
  for (const file of files) await readTranscript(file, { start, end, days });
  const commits = commitsOf(cwd, { start, end, git });
  for (const c of [...commits].sort((a, b) => a.time - b.time)) {
    const key = dayKey(c.time);
    if (!days.has(key)) days.set(key, newDay(key));
    days.get(key).commits.push(c);
  }
  const changed = new Map();
  for (const c of commits)
    for (const f of c.files) {
      const known = changed.get(f.file) || { added: 0, removed: 0, commits: 0 };
      known.added += f.added;
      known.removed += f.removed;
      known.commits++;
      changed.set(f.file, known);
    }
  const symbols = period === 'project' ? new Map() : symbolsOf(cwd, { start, end, git });
  const models = await modelsOf(cwd, symbols, reader);
  return { folder: basename(cwd), period, start, end, now, days, files: changed, symbols, models };
}

/** The final stage of each task or change in a list of change events, in the order of their first event. */
export function stagesOf(events) {
  const last = new Map();
  for (const e of [...events].sort((a, b) => a.time - b.time)) {
    const key = `${e.kind}|${e.text}`;
    last.set(key, { ...e, first: last.get(key)?.first ?? e.time });
  }
  const groups = { planned: [], process: [], done: [], failed: [] };
  for (const e of last.values()) (groups[e.stage] || groups.planned).push(e);
  return groups;
}

const KIND = {
  plan: 'Plan',
  task: 'Task',
  commit: 'Commit',
  push: 'Push',
  pr: 'Pull request',
  merge: 'Merge',
  deploy: 'Deploy',
};
const list = (items, max, line) => {
  const out = items.slice(0, max).map(line);
  if (items.length > max) out.push(`- … and ${items.length - max} more`);
  return out;
};
const sum = (days, pick) => days.reduce((n, d) => n + pick(d), 0);

const tokensText = n =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)} B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)} k`
        : String(n);
const usd = v => `$${(v || 0).toFixed(2)}`;

/** The tokens and cost of a list of days, all models together. */
function daysTokens(days) {
  const all = {};
  for (const d of days) for (const t of d.tokens?.values() ?? []) addTokens(all, t);
  return all;
}

/** The token table of one day: one row for each model, then the share of the agents. */
function tokenLines(day) {
  if (!day.tokens?.size) return [];
  const rows = [...day.tokens].sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  const out = [
    '## Tokens and cost',
    '',
    '| Model | Input | Cache write | Cache read | Output | Cost |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      ([m, t]) =>
        `| \`${safe(m)}\` | ${tokensText(t.input)} | ${tokensText(t.cacheWrite5m + t.cacheWrite1h)} | ${tokensText(t.cacheRead)} | ${tokensText(t.output)} | ${t.unpriced ? 'no price' : usd(t.cost)} |`,
    ),
    '',
  ];
  if (tokenTotal(day.agentTokens))
    out.push(
      `Agents started by the sessions: ${tokensText(tokenTotal(day.agentTokens))} tokens, ${usd(day.agentTokens.cost)}.`,
      '',
    );
  out.push('Cost at API list price. A Claude Code subscription is billed differently.', '');
  return out;
}

function countsLine(days, files) {
  const sessions = new Set(days.flatMap(d => [...d.sessions.keys()])).size;
  const used = daysTokens(days);
  const money = tokenTotal(used) ? ` · ${tokensText(tokenTotal(used))} tokens · ${usd(used.cost)}` : '';
  const tests = days.flatMap(d => d.tests),
    failed = tests.filter(t => !t.ok).length;
  return `**${plural(sessions, 'session')} · ${plural(
    sum(days, d => d.prompts.length),
    'prompt',
  )} · ${plural(
    sum(days, d => d.commits.length),
    'commit',
  )} · ${plural(files.size, 'file')} changed · ${plural(
    sum(days, d => d.edits),
    'edit',
  )} · ${plural(tests.length, 'test run')}${failed ? ` (${failed} failed)` : ''}${money}**`;
}

function filesTable(files, max = 10) {
  if (!files.size) return [];
  const rows = [...files].sort((a, b) => b[1].added + b[1].removed - (a[1].added + a[1].removed)).slice(0, max);
  return [
    '## Files changed most',
    '',
    '| File | Added | Removed | Commits |',
    '| --- | --- | --- | --- |',
    ...rows.map(([f, c]) => `| ${cut(f, 80).replace(/\|/g, '\\|')} | ${c.added} | ${c.removed} | ${c.commits} |`),
    '',
  ];
}

function symbolsPart(j) {
  if (!j.symbols.size && !j.models.length) return [];
  const top = [...j.symbols].sort((a, b) => b[1].changes - a[1].changes).slice(0, 20);
  const out = ['## Symbols and models', ''];
  if (top.length)
    out.push(
      `Changed most: ${top.map(([n, s]) => `\`${cut(n, 60)}\` (${s.changes})`).join(', ')}${j.symbols.size > 20 ? `, and ${j.symbols.size - 20} more` : ''}.`,
      '',
    );
  if (j.models.length) out.push(`Pydantic models: ${j.models.map(m => `\`${cut(m, 60)}\``).join(', ')}.`, '');
  return out;
}

function stagesPart(events, max, heading = '##') {
  const g = stagesOf(events);
  const line = e => `- ${clock(e.time)} ${KIND[e.kind] || e.kind}: ${e.text}`;
  const out = [];
  for (const [stage, title] of [
    ['planned', 'Planned'],
    ['process', 'In process'],
    ['done', 'Completed'],
    ['failed', 'Not completed'],
  ])
    if (g[stage].length) out.push(`${heading} ${title}`, '', ...list(g[stage], max, line), '');
  return out;
}

/** The full journal of one day. */
function dayLines(day) {
  const out = [];
  if (!day.sessions.size && !day.commits.length) return ['No Claude session and no commit on this day.', ''];
  if (day.sessions.size) {
    out.push('## Sessions', '');
    for (const [id, s] of day.sessions)
      out.push(
        `- \`${id}\` · ${clock(s.first)} to ${clock(s.last)} · ${plural(s.prompts, 'prompt')}${tokenTotal(s.tokens) ? ` · ${tokensText(tokenTotal(s.tokens))} tokens · ${usd(s.tokens.cost)}` : ''}`,
      );
    out.push('');
  }
  out.push(...tokenLines(day));
  if (day.prompts.length) out.push('## Prompts', '', ...list(day.prompts, 30, p => `- ${clock(p.time)} ${p.text}`), '');
  const stages = stagesPart(day.events, 20, '###');
  if (stages.length) out.push('## Changes', '', ...stages);
  if (day.commits.length)
    out.push('## Commits', '', ...list(day.commits, 30, c => `- ${clock(c.time)} \`${c.hash}\` ${c.subject}`), '');
  if (day.tests.length) {
    const failed = day.tests.filter(t => !t.ok).length;
    out.push(
      '## Tests',
      '',
      `${plural(day.tests.length, 'test run')}, ${day.tests.length - failed} passed, ${failed} failed.`,
      '',
      ...list(day.tests, 15, t => `- ${clock(t.time)} ${t.ok ? 'passed' : '**failed**'} · ${t.text}`),
      '',
    );
  }
  if (day.long.length)
    out.push(
      '## Long commands',
      '',
      ...list(day.long, 10, l => `- ${clock(l.time)} · ${Math.round(l.seconds / 60)} min · ${l.name}: ${l.text}`),
      '',
    );
  return out;
}

/** A short section of one day in a week or a month. */
function shortDayLines(day) {
  const done = stagesOf(day.events).done;
  const out = [
    `${plural(day.sessions.size, 'session')} · ${plural(day.prompts.length, 'prompt')} · ${plural(day.commits.length, 'commit')} · ${plural(done.length, 'completed change')}`,
    '',
  ];
  if (day.commits.length) out.push(...list(day.commits, 8, c => `- ${clock(c.time)} \`${c.hash}\` ${c.subject}`), '');
  if (done.length) out.push(...list(done, 6, e => `- ${clock(e.time)} completed · ${e.text}`), '');
  if (day.prompts.length) out.push(...list(day.prompts, 4, p => `- ${clock(p.time)} asked · ${p.text}`), '');
  return out;
}

/** The Markdown lines of a day, week or month journal. */
export function renderJournal(j) {
  const days = [...j.days.values()].sort((a, b) => a.key.localeCompare(b.key));
  const label =
    j.period === 'day'
      ? longDate(j.start)
      : j.period === 'week'
        ? `the week of ${longDate(j.start)}`
        : monthName(j.start);
  const out = [`# Journal of ${safe(j.folder)}: ${label}`, '', countsLine(days, j.files), ''];
  if (j.period === 'day') {
    out.push(...dayLines(days[0] || newDay(dayKey(j.start))));
    out.push(...filesTable(j.files), ...symbolsPart(j));
    return trim(out);
  }
  out.push(...filesTable(j.files), ...symbolsPart(j));
  const all = days.flatMap(d => d.events);
  const stages = stagesPart(all, 15, '###');
  if (stages.length) out.push('## Changes of the period', '', ...stages);
  const idle = [];
  for (
    let t = new Date(j.start);
    t < j.end && t <= (j.now || new Date());
    t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)
  ) {
    const day = j.days.get(dayKey(t));
    if (!day || (!day.sessions.size && !day.commits.length)) {
      idle.push(t.getDate());
      continue;
    }
    out.push(`## ${longDate(t)}`, '', ...shortDayLines(day));
  }
  if (idle.length) out.push(`Days with no session and no commit: ${idle.join(', ')}.`, '');
  return trim(out);
}

// --- The project lifecycle ---

/** The lifecycle of a folder: months, tags, top folders and tasks, from all of git and all transcripts. */
export async function collectProject({ cwd, projects, folderName, git = runGit, date = new Date(), note, now }) {
  const j = await collect({ cwd, period: 'project', date, projects, folderName, git, note, now });
  const tags = git(cwd, [
    'for-each-ref',
    'refs/tags',
    '--sort=creatordate',
    '--format=%(refname:short)%1f%(creatordate:iso-strict)',
  ])
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [name, when] = l.split('\x1f');
      return { name: cut(name, 60), time: Date.parse(when) };
    })
    .filter(t => !Number.isNaN(t.time));
  return { ...j, tags };
}

const monthKey = time => dayKey(time).slice(0, 7);

/** The Markdown lines of the lifecycle. */
export function renderLifecycle(p) {
  const days = [...p.days.values()].sort((a, b) => a.key.localeCompare(b.key));
  const commits = days.flatMap(d => d.commits).sort((a, b) => a.time - b.time);
  const sessionDays = days.filter(d => d.sessions.size);
  const out = [`# Lifecycle of ${safe(p.folder)}`, ''];
  if (!commits.length && !sessionDays.length)
    return ['# Lifecycle of ' + safe(p.folder), '', 'No commit and no Claude session yet.'];
  const facts = [];
  if (commits.length)
    facts.push(`first commit ${longDate(commits[0].time)}`, `last commit ${longDate(commits.at(-1).time)}`);
  if (sessionDays.length) facts.push(`first Claude session ${longDate(Date.parse(sessionDays[0].key + 'T12:00:00'))}`);
  facts.push(plural(p.tags.length, 'tag'));
  out.push(`${facts.join(' · ')}.`, '', countsLine(days, p.files), '');
  // One row for each month.
  const months = new Map();
  const row = key => {
    if (!months.has(key))
      months.set(key, {
        commits: 0,
        files: new Set(),
        added: 0,
        removed: 0,
        sessions: new Set(),
        prompts: 0,
        done: 0,
        tags: [],
      });
    return months.get(key);
  };
  for (const c of commits) {
    const r = row(monthKey(c.time));
    r.commits++;
    for (const f of c.files) {
      r.files.add(f.file);
      r.added += f.added;
      r.removed += f.removed;
    }
  }
  for (const d of days) {
    const r = row(d.key.slice(0, 7));
    for (const id of d.sessions.keys()) r.sessions.add(id);
    r.prompts += d.prompts.length;
  }
  const stages = stagesOf(days.flatMap(d => d.events));
  for (const e of stages.done) row(monthKey(e.time)).done++;
  for (const t of p.tags) row(monthKey(t.time)).tags.push(t.name);
  out.push(
    '## Months',
    '',
    '| Month | Commits | Files changed | Added | Removed | Sessions | Prompts | Completed changes | Tags |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const [key, r] of [...months].sort((a, b) => a[0].localeCompare(b[0])))
    out.push(
      `| ${monthName(Date.parse(key + '-15T12:00:00'))} | ${r.commits} | ${r.files.size} | ${r.added} | ${r.removed} | ${r.sessions.size} | ${r.prompts} | ${r.done} | ${r.tags.slice(0, 4).join(', ')}${r.tags.length > 4 ? ` +${r.tags.length - 4}` : ''} |`,
    );
  out.push('');
  if (p.tags.length)
    out.push(
      '## Tags and releases',
      '',
      ...list([...p.tags].reverse(), 20, t => `- ${dayKey(t.time)} \`${t.name}\``),
      '',
    );
  // The first and last change of each top folder.
  const folders = new Map();
  for (const c of commits)
    for (const f of c.files) {
      const top = f.file.includes('/') ? f.file.split('/')[0] + '/' : '(root)';
      const known = folders.get(top) || { first: c.time, last: c.time, commits: new Set() };
      known.first = Math.min(known.first, c.time);
      known.last = Math.max(known.last, c.time);
      known.commits.add(c.hash);
      folders.set(top, known);
    }
  if (folders.size)
    out.push(
      '## Top folders',
      '',
      '| Folder | First change | Last change | Commits |',
      '| --- | --- | --- | --- |',
      ...[...folders]
        .sort((a, b) => a[1].first - b[1].first)
        .slice(0, 25)
        .map(([f, s]) => `| ${cut(f, 60)} | ${dayKey(s.first)} | ${dayKey(s.last)} | ${s.commits.size} |`),
      '',
    );
  const open = [...stages.planned, ...stages.process].sort((a, b) => b.time - a.time);
  out.push(
    '## Tasks',
    '',
    `${plural(stages.done.length, 'completed change')} · ${stages.process.length} in process · ${stages.planned.length} planned · ${stages.failed.length} not completed.`,
    '',
  );
  if (open.length)
    out.push(
      'Open, newest first:',
      '',
      ...list(
        open,
        15,
        e =>
          `- ${dayKey(e.time)} ${e.stage === 'process' ? 'in process' : 'planned'} · ${KIND[e.kind] || e.kind}: ${e.text}`,
      ),
      '',
    );
  return trim(out);
}

function trim(lines) {
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}
