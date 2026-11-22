// SPDX-License-Identifier: AGPL-3.0-only
/** The Claude sessions in operation on this computer (aidr list).
 *
 *   aidr list              list the sessions once: the folder, the title, each process and the last step
 *   aidr                     the minimal watch: each new step on one line and each code change as one line
 *                                     with its file and line counts (Ctrl+C)
 *   aidr:agents              the agent map once: each session, its subagents, their state and heartbeat
 *
 * Each flag adds one view, and the flags add up (owner, 22 November 2026: "make aidr run minimal by default, make all
 * aidr flags positive ... make the aidr flags cumulative"); the old --no-* flags stop with the flag that replaces them:
 *   --code, --full-diff     the diff, Claude's reason, notes and a question; --full-diff every changed line
 *   --map, --ontology       the CodeGraph map of a changed function; the Pydantic models of a Python change
 *   --mermaid               the Mermaid text next to the drawings
 *   --stage, --progress     the stage report after a commit (stage-report.mjs); long tool calls and background commands
 *   --agents                the agent map at the start and every 10 minutes (agent-map.mjs; --heartbeat too)
 *   --help, --explain, --example   one line, two paragraphs or an example, about aidr or each flag named (help.mjs)
 *   --commands              the command lines of each shell step (secrets masked)
 *   --changes, --busywork   the change events (planned, in process, completed); every step and text in full
 *   --all                   every view above (aidr --all)
 *   --learn, --learn-code   a Learn card under each code change (learn.mjs; local Claude, else Gemma with your own
 *                           AIDR_CF_ACCOUNT_ID and AIDR_CF_API_TOKEN); --learn-code also sends the changed lines, masked
 *   --security              a Security card under each change at a trust boundary (security.mjs): impact, threat, fix,
 *                           the NIST SSDF v1.1 practice, a link; local Claude only
 *   --global, --outside     every folder; the lines of files outside the session's folder (normally path only)
 *   --plain                 no icons and no colours
 *
 * With --stage, after a commit in a session's folder the watch prints the stage report of aidr stage: the
 * Pydantic models in play and the CodeGraph changes of the new commits (owner, 22 November 2026).
 *
 * The names (owner, 22 November 2026: "call it devekko.aidr", "change all the scripts and namespace to aidr"): the
 * code is in lib/, the scripts are aidr, aidr:change, aidr:busywork, aidr:list and aidr:stage, and the npm
 * package to come is devekko.aidr with the command aidr (WTF-PKG-1 section 9, docs/implementation/wtf-npm-package-spec.md).
 *
 * Read only. It reads the process list, the session transcripts under ~/.claude/projects and, for the code changes,
 * git in the session's folder. It stops no process and writes no file. It prints the tool name and the short
 * description of a step, the first line of a text, the first line of a prompt, and the command lines of a shell step
 * (with --commands), each line through safe(). It never prints a tool result.
 *
 * Code changes (owner, 21 November 2026, after the comprehension debt research): the watch shows each change that an
 * edit tool makes, and each change git sees that a command or a script made, as a short diff with Claude's own reason
 * just before it, plain notes on what kind of change it is, and one question to check your understanding
 * (code-tutor.mjs). With a .codegraph/ index in the session's folder, each change of a function also shows its map:
 * who calls it, what it uses, and how many tests reach it. A private file (.env files, .local/, keys, credentials) is
 * never shown, and a token, key or password in a changed line is masked.
 *
 * Security audit (21 November 2026, WTF-PKG-1 section 4): every text from a transcript, a file or git goes through
 * safe() (code-tutor.mjs) before it is printed: no terminal control bytes, and every secret masked. A file outside the
 * session's folder shows its path and counts only. git runs with no command of the folder's own configuration.
 *
 * The look: in a terminal, each step has an icon and the lines have colours (a lane colour for each line of work).
 * --plain, NO_COLOR, or output to a pipe or a file give plain text. The watch prints a summary every 5 minutes and
 * when Ctrl+C stops it.
 *
 * One conversation can be open in two processes (for example the same conversation in two editor windows). Both then
 * write to one transcript, and the list says so. The watch gives each line of work a letter (A, B): the entries of a
 * transcript link to their parent entry, so two processes make two chains. The letter is not a process ID. */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CodeTally,
  GIT_ENV,
  GIT_SAFE,
  GitChanges,
  changesOf,
  gitChange,
  graphOf,
  insideFolder,
  isPrivatePath,
  renderChange,
  renderGraph,
  safe,
  symbolOfChange,
} from './code-tutor.mjs';
import { ChangeFeed, renderEvent } from './change-feed.mjs';
import { OntologyReader, namesOfChange, renderOntology } from './ontology.mjs';
import { markdownLines } from './markdown-term.mjs';
import { stageLines } from './stage-report.mjs';
import { helpLines, topicLines } from './help.mjs';
import { Learner, renderCard } from './learn.mjs';
import { SecurityReviewer, renderSecurity } from './security.mjs';
import { Progress, clockOf } from './session-progress.mjs';
import { HEARTBEAT_MINUTES, mapRows, renderAgentMap } from './agent-map.mjs';

// Claude Code's transcripts: CLAUDE_CONFIG_DIR when it is set (Claude Code reads the same variable), else ~/.claude.
const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
export const VERSION = '0.1.0';
// The end of a transcript that is read for the title, the last steps and the chains, and the most read at one time
// (security audit F8): a transcript that grew more than this since the last read is read from its last 8 MB.
const TAIL_BYTES = 8_000_000;
const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'fish'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** The rows of `ps -eo pid=,ppid=,etimes=,comm=,args=` as objects. */
export function parseProcesses(text) {
  return String(text || '')
    .split('\n')
    .flatMap(line => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), seconds: Number(m[3]), comm: m[4], args: m[5] }] : [];
    });
}

/** The Claude processes, each with the shell commands that it has in operation. */
export function claudeProcesses(rows) {
  return rows
    .filter(r => r.comm === 'claude')
    .map(r => {
      const commands = rows.filter(c => c.ppid === r.pid && SHELLS.includes(c.comm));
      return { ...r, commands: commands.length, oldestCommand: Math.max(0, ...commands.map(c => c.seconds)) };
    });
}

/** The conversation that a process was started with (--resume or --session-id), or null for a new conversation. */
export function sessionIdOf(args) {
  const m = String(args || '').match(new RegExp('--(?:resume|session-id)[= ](' + UUID.source + ')'));
  return m ? m[1] : null;
}

/** The transcript folder of a working folder: every character that is not a letter or a digit becomes "-". */
export function projectFolder(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// Every text from a transcript goes through safe(): no terminal control bytes, secrets masked (audit F1, F2).
// The whole text as lines (the raw log draws it as Markdown, markdown-term.mjs): each line through safe(), at most 120
// lines and 6,000 characters.
const bodyOf = text => {
  let size = 0;
  const out = [];
  for (const line of String(text || '')
    .trim()
    .split('\n')
    .slice(0, 120)) {
    const clean = safe(line);
    size += clean.length;
    if (size > 6000) {
      out.push('…');
      break;
    }
    out.push(clean);
  }
  return out;
};
const cut = (text, max) => {
  const line = safe(
    String(text || '')
      .trim()
      .split('\n')[0],
  ).trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
};

/** The lines of a shell command: each through safe() and cut at 240 characters; at most 12 lines, or 120 in the raw
 * log (full). */
export function commandOf(text, { full = false } = {}) {
  const max = full ? 120 : 12,
    lines = String(text).trim().split('\n');
  const out = lines.slice(0, max).map(line => {
    const clean = safe(line).trimEnd();
    return clean.length > 240 ? clean.slice(0, 239) + '…' : clean;
  });
  if (lines.length > max) out.push(`… ${lines.length - max} more lines`);
  return out;
}

/** The steps of one transcript entry that a person can follow: a tool call, a text, a prompt. Nothing else.
 * full: the raw log (aidr:busywork) keeps the whole text of Claude and of a prompt, up to 2,000 characters, on one
 * line; otherwise each text is its first line, cut short. */
export function stepsOf(entry, { full = false, commands = false } = {}) {
  const content = entry?.message?.content,
    time = entry?.timestamp || '';
  if (entry?.type === 'assistant' && Array.isArray(content)) {
    return content.flatMap(part => {
      if (part?.type === 'tool_use') {
        const i = part.input || {};
        const step = {
          time,
          kind: 'tool',
          name: String(part.name || 'tool'),
          text: cut(i.description || i.file_path || i.query || i.url || i.skill || '', 140),
        };
        if (commands && step.name === 'Bash' && String(i.command || '').trim())
          step.command = commandOf(i.command, { full });
        return [step];
      }
      if (part?.type === 'text' && String(part.text || '').trim())
        return [
          full
            ? { time, kind: 'says', name: 'SAYS', text: '', body: bodyOf(part.text) }
            : { time, kind: 'says', name: 'SAYS', text: cut(part.text, 140) },
        ];
      return [];
    });
  }
  if (entry?.type === 'user' && !entry.isMeta) {
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content) && content.every(p => p?.type === 'text')
          ? content.map(p => p.text).join(' ')
          : '';
    // Text that the harness adds (reminders, task notices) is not a prompt of the person.
    if (text.trim() && !/^\s*</.test(text))
      return [
        full
          ? { time, kind: 'prompt', name: 'PROMPT', text: '', body: bodyOf(text) }
          : { time, kind: 'prompt', name: 'PROMPT', text: cut(text, 120) },
      ];
  }
  return [];
}

/** Gives each chain of entries a letter. An entry takes the letter of its parent. An entry of the main conversation
 * whose parent is not known starts a new letter: that is the first entry of a process in the part that was read. */
export class Lanes {
  constructor() {
    this.known = new Map();
    this.count = 0;
  }
  of(entry) {
    if (!entry?.uuid) return null;
    let lane = this.known.get(entry.parentUuid);
    if (lane === undefined) {
      lane = entry.isSidechain ? null : String.fromCharCode(65 + (this.count++ % 26));
    }
    this.known.set(entry.uuid, lane);
    return lane;
  }
}

const clock = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false });
};
const ago = seconds =>
  seconds < 90
    ? `${Math.round(seconds)} s`
    : seconds < 5400
      ? `${Math.round(seconds / 60)} min`
      : `${(seconds / 3600).toFixed(1)} h`;

// --- The look: icons and colours (owner, 21 November 2026: "emojis and helpful visual icons") ---

/** No icons and no colours: for a pipe, a file, NO_COLOR, --plain and the tests. */
export const PLAIN = { icons: false, color: false };
/** The look of a terminal. */
export const FANCY = { icons: true, color: true };
/** The look for this output: plain unless it is a terminal, NO_COLOR is not set and --plain is not given. */
export function lookFor({ tty = false, env = {}, plain = false } = {}) {
  if (plain || !tty) return PLAIN;
  return { icons: true, color: !('NO_COLOR' in env) };
}

const ANSI = {
  dim: 2,
  bold: 1,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
  // The code highlights of code-tutor.mjs: one colour for each role of a word.
  keyword: '95',
  definition: '1;94',
  call: '94',
  builtin: '36',
  type: '96',
  string: '93',
  number: '36',
  comment: '3;90',
  decorator: '33',
};
const paint = (look, code, text) => (look.color && text ? `\x1b[${ANSI[code]}m${text}\x1b[0m` : String(text));
const LANE_COLOURS = ['yellow', 'magenta', 'cyan', 'green', 'blue', 'red'];
const laneColour = lane => LANE_COLOURS[(String(lane || 'A').charCodeAt(0) - 65) % LANE_COLOURS.length];

// The icon of a tool. A shell command takes the icon of the first matching word in its description.
const TOOL_ICONS = {
  Bash: '💻',
  Read: '📖',
  Edit: '📝',
  Write: '💾',
  NotebookEdit: '📓',
  Grep: '🔎',
  Glob: '📂',
  Agent: '🤖',
  Task: '🤖',
  Workflow: '🧭',
  WebFetch: '🌐',
  WebSearch: '🔍',
  Skill: '🧩',
  Artifact: '📰',
  TaskStop: '🛑',
  ToolSearch: '🧰',
  AskUserQuestion: '❓',
  SendMessage: '📨',
  ListAgents: '👥',
  ReadNotifications: '🔔',
  ScheduleWakeup: '⏰',
  Monitor: '📈',
  TodoWrite: '✅',
  TaskCreate: '✅',
  TaskUpdate: '✅',
  SendUserFile: '📎',
  ReportFindings: '🐞',
};
const SHELL_ICONS = [
  [/deploy|release/i, '🚀'],
  [/\btests?\b|pytest|node --test/i, '🧪'],
  [/commit|push/i, '📦'],
  [/\blint/i, '🧹'],
  [/install|download/i, '📥'],
  [/restart|start|stop|wait/i, '🔄'],
  [/build|bundle|compile/i, '🏗'],
  [/\bgit\b|branch|diff|log/i, '🌿'],
  [/docker|container/i, '🐳'],
  [/telemetry|logs?\b|query/i, '📡'],
  [/find|search|list|show|read|check/i, '🔎'],
];
const MCP_ICONS = [
  [/playwright/, '🎭'],
  [/codegraph/, '🕸'],
  [/stripe/, '💳'],
  [/gmail|mail/, '📧'],
  [/calendar/, '📅'],
  [/drive|docs/, '📄'],
  [/posthog/, '🦔'],
];

/** The icon of a step: a prompt, a text, or a tool. */
export function iconOf(step) {
  if (step?.kind === 'prompt') return '🙋';
  if (step?.kind === 'says') return '💬';
  const name = String(step?.name || '');
  if (name === 'Bash') return SHELL_ICONS.find(([word]) => word.test(step.text || ''))?.[1] || TOOL_ICONS.Bash;
  if (name.startsWith('mcp__')) return MCP_ICONS.find(([word]) => word.test(name))?.[1] || '🔌';
  return TOOL_ICONS[name] || '🔧';
}

/** A short tool name: mcp__playwright-test__browser_click is playwright browser_click. */
const shortName = name => {
  const m = String(name).match(/^mcp__(?:claude_ai_)?([^_]+(?:[-_][^_]+)*?)__(.+)$/);
  return m ? `${m[1].replace(/-test$/, '')} ${m[2]}` : String(name);
};

/** The state of a conversation from the age of its transcript: working, waiting or idle. */
export function stateOf(idleSeconds) {
  if (idleSeconds === null || idleSeconds === undefined) return { icon: '⚫', word: 'no transcript' };
  if (idleSeconds < 60) return { icon: '🟢', word: 'working' };
  if (idleSeconds < 600) return { icon: '🟡', word: 'waiting' };
  return { icon: '⚪', word: 'idle' };
}

/** The lines of the list. conversations: [{folder, title, sessionId, guessed, processes, lastStep, lastPrompt, idleSeconds}]. */
export function renderList(conversations, look = PLAIN) {
  const icon = (i, text) => (look.icons ? `${i} ${text}` : text);
  if (!conversations.length) return [icon('😴', 'No Claude session is in operation.')];
  const processes = conversations.reduce((n, c) => n + c.processes.length, 0);
  const head = `Claude sessions in operation: ${processes} process${processes === 1 ? '' : 'es'}, ${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`;
  const lines = [paint(look, 'bold', icon('🤖', head))];
  for (const c of conversations) {
    lines.push('');
    const state = stateOf(c.idleSeconds),
      id = c.sessionId ? c.sessionId.slice(0, 8) : 'no transcript found';
    const title = `${paint(look, 'blue', c.folder)}  ${paint(look, 'bold', `"${c.title || 'no title yet'}"`)}  ${paint(look, 'gray', id)}${c.guessed ? ' (newest transcript of the folder)' : ''}`;
    lines.push(look.icons ? `${state.icon} ${title}  ${paint(look, 'dim', state.word)}` : title);
    if (c.processes.length > 1)
      lines.push(
        '  ' +
          paint(
            look,
            'yellow',
            icon('⚠️', `WARNING: ${c.processes.length} processes work on this one conversation. Each can change files.`),
          ),
      );
    for (const p of c.processes) {
      const work = p.commands
        ? `${p.commands} command${p.commands === 1 ? '' : 's'} in operation (oldest ${ago(p.oldestCommand)})`
        : 'no command in operation';
      lines.push(
        '  ' +
          icon(
            '⚙️',
            `process ${p.pid}  started ${ago(p.seconds)} ago  editor host ${p.ppid}  ${look.icons ? (p.commands ? '⏳ ' : '💤 ') : ''}${work}`,
          ),
      );
    }
    if (c.lastPrompt)
      lines.push(
        '  ' +
          icon(
            '🙋',
            `last prompt ${paint(look, 'gray', clock(c.lastPrompt.time))}  ${paint(look, 'magenta', c.lastPrompt.text)}`,
          ),
      );
    if (c.lastStep)
      lines.push(
        '  ' +
          icon(
            iconOf(c.lastStep),
            `last step   ${paint(look, 'gray', clock(c.lastStep.time))}  ${paint(look, 'cyan', look.icons ? shortName(c.lastStep.name) : c.lastStep.name)}${c.lastStep.text ? ' | ' + c.lastStep.text : ''}`,
          ),
      );
    if (c.idleSeconds !== null)
      lines.push('  ' + icon('🕒', paint(look, 'dim', `transcript written ${ago(c.idleSeconds)} ago`)));
  }
  return lines;
}

/** The body of a step (the raw log: Claude's text or a prompt in full) as indented Markdown lines. */
function bodyLines(step, lane, look, width = process.stdout.columns || 120) {
  if (!step.body?.length) return '';
  const fancy = look.icons || look.color,
    pad = fancy ? '           ' : '    ';
  const bar = fancy
    ? paint(look, lane ? laneColour(lane) : step.kind === 'prompt' ? 'magenta' : 'green', '│') + ' '
    : '';
  const lines = markdownLines(step.body, {
    paint: (k, t) => paint(look, k, t),
    width: Math.max(40, width - pad.length - 2),
  });
  return '\n' + lines.map(l => pad + bar + l).join('\n');
}

/** The command lines of a shell step under it: "$ " before the first line, "  " before the next ones. */
function commandLines(step, look) {
  if (!step.command?.length) return '';
  const fancy = look.icons || look.color,
    pad = fancy ? '           ' : '    ';
  return '\n' + step.command.map((l, n) => pad + paint(look, 'gray', (n ? '  ' : '$ ') + l)).join('\n');
}

/** One line of the watch; a shell step adds its command lines under it, and a step with a body (the raw log) adds its
 * text as Markdown under it. */
export function renderStep(folder, lane, step, look = PLAIN) {
  if (!look.icons && !look.color)
    return (
      `${clock(step.time)}  ${folder}${lane ? ' ' + lane : ''}  ${step.name}${step.text ? ' | ' + step.text : ''}` +
      commandLines(step, look) +
      bodyLines(step, lane, look)
    );
  const colour = step.kind === 'prompt' ? 'magenta' : step.kind === 'says' ? 'green' : 'cyan';
  const name = paint(look, step.kind === 'prompt' ? 'bold' : colour, look.icons ? shortName(step.name) : step.name);
  const text = step.text
    ? ' ' + paint(look, 'gray', '|') + ' ' + (step.kind === 'prompt' ? paint(look, 'magenta', step.text) : step.text)
    : '';
  const laneText = lane ? ' ' + paint(look, laneColour(lane), look.icons ? `▌${lane}` : lane) : '';
  return (
    `${paint(look, 'gray', clock(step.time))}  ${paint(look, 'blue', folder)}${laneText}  ${look.icons ? iconOf(step) + ' ' : ''}${name}${text}` +
    commandLines(step, look) +
    bodyLines(step, lane, look)
  );
}

/** The counts of the watch: steps, prompts and the tools used most. */
export class Tally {
  constructor() {
    this.steps = 0;
    this.prompts = 0;
    this.tools = new Map();
    this.icons = new Map();
  }
  add(step) {
    this.steps++;
    if (step.kind === 'prompt') {
      this.prompts++;
      return;
    }
    if (step.kind !== 'tool') return;
    // The tool's own icon: the count is for the tool, not for one command.
    const name = shortName(step.name);
    this.tools.set(name, (this.tools.get(name) || 0) + 1);
    this.icons.set(name, iconOf({ ...step, text: '' }));
  }
  /** One line: "23 steps · 2 prompts · 💻 Bash 9 · 📝 Edit 4 · 📖 Read 3". */
  line(look = PLAIN) {
    const top = [...this.tools]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n, c]) => `${look.icons ? this.icons.get(n) + ' ' : ''}${n} ${c}`);
    return [
      `${this.steps} step${this.steps === 1 ? '' : 's'}`,
      `${this.prompts} prompt${this.prompts === 1 ? '' : 's'}`,
      ...top,
    ].join(' · ');
  }
}

// --- The computer: processes and transcript files ---

/** "[[dd-]hh:]mm:ss" (ps -o etime on macOS) as seconds. */
export function etimeSeconds(text) {
  const m = String(text || '')
    .trim()
    .match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + +m[3] * 60 + +m[4] : 0;
}

/** The rows of macOS `ps -o pid=,ppid=,etime=,comm=,args=`: etime in its clock form, comm a full path. */
export function parseMacProcesses(text) {
  return String(text || '')
    .split('\n')
    .flatMap(line => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      return m
        ? [{ pid: Number(m[1]), ppid: Number(m[2]), seconds: etimeSeconds(m[3]), comm: basename(m[4]), args: m[5] }]
        : [];
    });
}

/** The processes of the current user only (security audit F9): another user's command lines are never read. */
function readProcesses(platform = process.platform) {
  const uid = String(process.getuid?.() ?? ''),
    own = uid ? ['-U', uid] : ['-e'];
  if (platform === 'darwin')
    return parseMacProcesses(
      execFileSync('ps', [...own, '-o', 'pid=,ppid=,etime=,comm=,args='], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
  return parseProcesses(
    execFileSync('ps', [...own, '-o', 'pid=,ppid=,etimes=,comm=,args='], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

/** The working folder from `lsof -a -p <pid> -d cwd -Fn` output (macOS): the line that starts with n. */
export function lsofFolder(text) {
  const line = String(text || '')
    .split('\n')
    .find(l => l.startsWith('n/'));
  return line ? line.slice(1) : null;
}

function workingFolder(pid, platform = process.platform) {
  if (platform === 'darwin') {
    try {
      return lsofFolder(
        execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
    } catch {
      return null;
    }
  }
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function newestTranscript(folder) {
  try {
    const files = readdirSync(folder)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, m: statSync(join(folder, f)).mtimeMs }));
    return files.sort((a, b) => b.m - a.m)[0]?.f.replace(/\.jsonl$/, '') || null;
  } catch {
    return null;
  }
}

/** The entries of a byte range of a transcript; a first part line is left out. Returns {entries, end, rest}. */
export function readEntries(file, from, rest = '', limit = TAIL_BYTES) {
  const size = statSync(file).size;
  if (size <= from) return { entries: [], end: size < from ? size : from, rest: size < from ? '' : rest };
  // More new bytes than the limit: read only the last part, and say how much was left out (audit F8).
  let skipped = 0;
  if (size - from > limit) {
    skipped = size - limit - from;
    from = size - limit;
    rest = '';
  }
  const buffer = Buffer.alloc(size - from),
    fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    closeSync(fd);
  }
  const lines = (rest + buffer.toString('utf8')).split('\n'),
    left = lines.pop();
  const entries = lines.flatMap(line => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
  return { entries, end: size, rest: left, skipped };
}

/** True when a session's folder is the folder of the watch or one of its subfolders. */
export function inFolder(cwd, dir) {
  const c = resolve(String(cwd || '')),
    d = resolve(String(dir || ''));
  return c === d || c.startsWith(d.endsWith(sep) ? d : d + sep);
}

/** The folder of the watch: where the person ran npm (INIT_CWD), or the working folder of the script. */
export function watchFolder(env = process.env, cwd = process.cwd()) {
  return resolve(env.INIT_CWD || cwd);
}

function conversationsNow({ global = false, dir = watchFolder() } = {}) {
  const found = new Map();
  for (const p of claudeProcesses(readProcesses())) {
    const cwd = workingFolder(p.pid);
    if (!cwd || (!global && !inFolder(cwd, dir))) continue;
    const folder = join(PROJECTS, projectFolder(cwd));
    let sessionId = sessionIdOf(p.args),
      guessed = false;
    if (!sessionId) {
      sessionId = newestTranscript(folder);
      guessed = Boolean(sessionId);
    }
    const key = sessionId ? folder + '/' + sessionId : 'pid:' + p.pid;
    const entry = found.get(key) || {
      folder: safe(basename(cwd)),
      cwd,
      sessionId,
      guessed,
      file: sessionId ? join(folder, sessionId + '.jsonl') : null,
      processes: [],
    };
    entry.processes.push(p);
    found.set(key, entry);
  }
  return [...found.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

/** Read the end of a conversation's transcript: the title, the last prompt and step, the chains, and where to go on. */
function load(conversation) {
  const c = conversation;
  c.title = null;
  c.lastStep = null;
  c.lastPrompt = null;
  c.idleSeconds = null;
  c.lanes = new Lanes();
  c.recent = [];
  c.offset = 0;
  c.rest = '';
  if (!c.file || !existsSync(c.file)) return c;
  const stat = statSync(c.file),
    from = Math.max(0, stat.size - TAIL_BYTES);
  const { entries, end, rest } = readEntries(c.file, from);
  // A read that starts inside a line loses that line: JSON.parse fails on it and it is left out.
  for (const entry of entries) {
    if (entry.type === 'ai-title' && entry.aiTitle) c.title = cut(entry.aiTitle, 120);
    if (entry.type === 'custom-title' && entry.customTitle) c.title = cut(entry.customTitle, 120);
    const lane = c.lanes.of(entry);
    for (const step of stepsOf(entry)) {
      if (step.kind === 'prompt') c.lastPrompt = step;
      else c.lastStep = step;
      c.recent.push({ lane, step });
    }
  }
  c.recent = c.recent.slice(-5);
  c.offset = end;
  c.rest = rest;
  c.idleSeconds = Math.max(0, (Date.now() - stat.mtimeMs) / 1000);
  return c;
}

const laneLabel = (conversation, lane) =>
  conversation.processes.length > 1 || conversation.lanes.count > 1 ? lane || '-' : '';

const SUMMARY_TICKS = 600; // 5 minutes of 500 ms ticks
const GIT_TICKS = 10; // git is read every 5 seconds
const PROGRESS_TICKS = 120; // progress lines once a minute
const HEARTBEAT_TICKS = HEARTBEAT_MINUTES * 120; // the agent map every 10 minutes

/** Claude's own words just before a change: the first paragraph of the text of an entry, for the "Why" line. */
export function whyOf(entry) {
  const content = entry?.message?.content;
  if (entry?.type !== 'assistant' || !Array.isArray(content)) return '';
  const text = content
    .filter(p => p?.type === 'text')
    .map(p => String(p.text || ''))
    .join('\n')
    .trim();
  const first = safe(text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ')).trim();
  return first.length > 240 ? first.slice(0, 239) + '…' : first;
}

/** One line for a code change in the minimal watch: the file (relative to the folder) and its line counts. A private
 * file shows its name only. */
export function changeLine(change, cwd, look) {
  const file = safe(String(change.file).replace(cwd + '/', ''));
  const counts = isPrivatePath(change.file)
    ? paint(look, 'gray', 'private')
    : `${paint(look, 'green', '+' + (change.after || []).length)} ${paint(look, 'red', '−' + (change.before || []).length)}`;
  return `  ${paint(look, 'gray', '│')} ${look.icons ? '✏️ ' : ''}${paint(look, 'bold', file)} ${counts}`;
}

/** The skip reasons of a card that was asked for and failed, in words. */
const DROPPED = {
  check: 'the answer failed the check',
  timeout: 'no answer in time',
  claude: 'the claude CLI returned an error',
  'claude answer': 'the claude CLI gave no JSON',
  network: 'no connection to Workers AI',
};
const styleOf = look => ({ paint: (k, t) => paint(look, k, t), icons: look.icons });

async function watch(options, look) {
  const readers = new Map();
  const open = new Map(),
    started = Date.now(),
    total = new Tally(),
    code = new CodeTally(),
    gits = new Map();
  let period = new Tally(),
    periodCode = new CodeTally();
  const say = (icon, text, colour = 'bold') => console.log(paint(look, colour, look.icons ? `${icon} ${text}` : text));
  const style = { paint: (k, t) => paint(look, k, t), icons: look.icons };
  const ontologyOf = async (c, change, symbol) => {
    if (
      !options.ontology ||
      !String(change.file).endsWith('.py') ||
      isPrivatePath(change.file) ||
      !insideFolder(c.cwd, change.file)
    )
      return;
    if (!readers.has(c.cwd)) readers.set(c.cwd, new OntologyReader(c.cwd));
    const reply = await readers.get(c.cwd).ask('', namesOfChange(change, symbol || ''));
    for (const line of renderOntology(reply, change, { ...style, mermaid: options.mermaid })) console.log(line);
    return (reply?.models || []).map(m => m.name);
  };
  // aidr --learn (learn.mjs): the card comes when local Claude or Gemma answers, so the watch does not wait for it; its first line
  // names the file, as it can print after the next step.
  const learner = options.learn ? new Learner({ code: options.learnCode }) : null;
  if (learner?.problem()) say('📚', learner.problem(), 'yellow');
  else if (learner)
    say(
      '📚',
      `--learn: a Learn card by ${learner.label()} under each code change${options.learnCode ? ', with the changed lines' : ''}.`,
      'dim',
    );
  // A card that was asked for and did not come says why in one line; a change with no topic or domain stays quiet.
  const dropped = (icon, name, result, file) => {
    if (!DROPPED[result.skipped] && !String(result.skipped || '').startsWith('http ')) return;
    const why = DROPPED[result.skipped] || `Workers AI answered ${result.skipped.slice(5)}`;
    console.log(
      paint(look, 'dim', `  │ ${look.icons ? icon + ' ' : ''}${name} card not shown for ${safe(file)}: ${why}.`),
    );
  };
  const learn = (c, change, symbol, models) => {
    if (!learner || learner.problem()) return;
    const file = String(change.file).replace(c.cwd + '/', '');
    learner.card(change, { symbol, models }).then(result => {
      if (!result.card) return dropped('📚', 'Learn', result, file);
      for (const line of renderCard(result.card, result.topic, { file, ...style })) console.log(line);
    });
  };
  // aidr --security (security.mjs): a Security card by local Claude, printed when it answers, like the Learn card.
  const reviewer = options.security ? new SecurityReviewer() : null;
  if (reviewer?.problem()) say('🛡️', reviewer.problem(), 'yellow');
  else if (reviewer)
    say('🛡️', `--security: a Security card by ${reviewer.label()} under each change at a trust boundary.`, 'dim');
  const review = (c, change, symbol) => {
    if (!reviewer || reviewer.problem()) return;
    const file = String(change.file).replace(c.cwd + '/', '');
    reviewer.card(change, { cwd: c.cwd, symbol }).then(result => {
      if (!result.card) return dropped('🛡️', 'Security', result, file);
      for (const line of renderSecurity(result.card, result.domain, { file, ...style })) console.log(line);
    });
  };
  const show = async (c, change) => {
    // Without --code: one line with the file and its line counts; the map, the models and the cards follow when asked.
    if (!options.code) {
      console.log(changeLine(change, c.cwd, look));
      const symbol = symbolOfChange(change, c.cwd);
      if (options.map && symbol && !isPrivatePath(change.file) && insideFolder(c.cwd, change.file)) {
        await new Promise(done => setTimeout(done, 1200));
        for (const line of renderGraph(await graphOf(c.cwd, symbol, change.file), {
          ...style,
          mermaid: options.mermaid,
        }))
          console.log(line);
      }
      const models = (await ontologyOf(c, change, symbol)) || [];
      learn(c, change, symbol, models);
      review(c, change, symbol);
      return;
    }
    for (const line of renderChange(change, {
      cwd: c.cwd,
      why: c.why,
      full: options.full,
      outside: options.outside,
      ...style,
    }))
      console.log(line);
    code.add(change);
    periodCode.add(change);
    // The map of the changed function (CodeGraph). Its index follows a write about a second later.
    const symbol = symbolOfChange(change, c.cwd);
    if (options.map && symbol) {
      await new Promise(done => setTimeout(done, 1200));
      for (const line of renderGraph(await graphOf(c.cwd, symbol, change.file), { ...style, mermaid: options.mermaid }))
        console.log(line);
    }
    // The Pydantic models that a Python change defines or uses (ontology.mjs), read with ast from the session folder.
    const models = (await ontologyOf(c, change, symbol)) || [];
    learn(c, change, symbol, models);
    review(c, change, symbol);
  };
  // The stage report after a commit (stage-report.mjs): HEAD of each session folder, read every five seconds.
  const heads = new Map();
  const headOf = cwd => {
    try {
      return execFileSync('git', [...GIT_SAFE, '-C', cwd, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ...GIT_ENV },
      }).trim();
    } catch {
      return null;
    }
  };
  const stageAfterCommit = async () => {
    for (const [cwd, old] of heads) {
      const now = headOf(cwd);
      if (!now || now === old) continue;
      heads.set(cwd, now);
      if (!old || !options.stage) continue;
      if (!readers.has(cwd)) readers.set(cwd, new OntologyReader(cwd));
      let lines;
      try {
        lines = await stageLines(`${old}..${now}`, {
          cwd,
          reader: readers.get(cwd),
          mermaid: options.mermaid,
          drawings: options.drawings,
        });
      } catch {
        continue;
      }
      console.log('');
      say(
        '📦',
        `Stage report of the new commit${lines[0]?.includes('..') ? 's' : ''} ${old.slice(0, 8)}..${now.slice(0, 8)} in ${safe(basename(cwd))}:`,
      );
      for (const line of markdownLines(lines.slice(1), {
        paint: (k, t) => paint(look, k, t),
        width: Math.max(60, (process.stdout.columns || 120) - 6),
      }))
        console.log('   ' + line);
    }
  };
  const codeLines = (tally, cwd) => {
    const out = [tally.line()],
      top = tally.top(cwd),
      untested = tally.untested(cwd);
    if (top.length) out.push((look.icons ? '📚 ' : '') + 'Read first: ' + top.join(', '));
    if (untested.length)
      out.push((look.icons ? '⚠️ ' : '') + 'Code changed with no test change: ' + untested.slice(0, 5).join(', '));
    return out;
  };
  const add = () => {
    for (const c of conversationsNow(options)) {
      if (!c.file || open.has(c.file)) {
        if (c.file) open.get(c.file).processes = c.processes;
        continue;
      }
      load(c);
      open.set(c.file, c);
      c.why = '';
      c.progress = new Progress();
      if (options.code && c.cwd && !gits.has(c.cwd)) {
        const g = new GitChanges(c.cwd);
        g.poll();
        gits.set(c.cwd, { git: g, conversation: c });
      }
      // Read the folder's models now, so the first Python change does not wait for the first full read (about 10 s).
      if (options.ontology && c.cwd && !readers.has(c.cwd)) {
        readers.set(c.cwd, new OntologyReader(c.cwd));
        readers.get(c.cwd).ask('', []);
      }
      if (c.cwd && !heads.has(c.cwd)) heads.set(c.cwd, headOf(c.cwd));
      console.log('');
      // The change events (planned, in process, completed) of the change view and the raw log.
      if (options.events) c.feed = new ChangeFeed();
      say(
        '👀',
        `Following ${c.folder} "${c.title || 'no title yet'}" (${c.processes.length} process${c.processes.length === 1 ? '' : 'es'}). Its last steps:`,
      );
      for (const { lane, step } of c.recent) console.log('  ' + renderStep(c.folder, laneLabel(c, lane), step, look));
    }
  };
  add();
  if (!open.size)
    say(
      '😴',
      options.global
        ? 'No Claude session is in operation. The watch waits for one.'
        : `No Claude session is in operation in ${options.dir}. The watch waits for one (--global watches every folder).`,
      'yellow',
    );
  const heartbeat = () => {
    const rows = mapRows([...open.values()]);
    console.log('');
    for (const line of renderAgentMap(rows, { ...style, clock: clock(new Date().toISOString()) })) console.log(line);
  };
  if (options.heartbeat) heartbeat();
  console.log('');
  say('📡', options.busywork ? 'Raw log, every step (Ctrl+C stops the watch):' : 'New steps (Ctrl+C stops the watch):');
  process.once('SIGINT', () => {
    console.log('');
    say('👋', `Watch stopped after ${ago((Date.now() - started) / 1000)}: ${total.line(look)}`);
    if (options.code) for (const line of codeLines(code, [...open.values()][0]?.cwd)) say('🧑‍🏫', line, 'dim');
    for (const reader of readers.values()) reader.close();
    process.exit(0);
  });
  let tick = 0;
  for (;;) {
    await new Promise(done => setTimeout(done, 500));
    if (++tick % 10 === 0) add();
    if (tick % SUMMARY_TICKS === 0 && period.steps) {
      say('📊', `Last 5 min: ${period.line(look)}`, 'dim');
      period = new Tally();
      if (options.code && periodCode.files.size)
        for (const line of codeLines(periodCode, [...open.values()][0]?.cwd)) say('🧑‍🏫', line, 'dim');
      periodCode = new CodeTally();
    }
    if (tick % GIT_TICKS === 0) await stageAfterCommit();
    if (options.heartbeat && tick % HEARTBEAT_TICKS === 0) heartbeat();
    // Progress of long-running work, once a minute (owner: "show progress of long running process").
    if (options.progress && tick % PROGRESS_TICKS === 0)
      for (const c of open.values())
        for (const r of c.progress.running()) {
          console.log(
            `${paint(look, 'gray', clock(new Date().toISOString()))}  ${paint(look, 'blue', c.folder)}  ${look.icons ? '⏳ ' : ''}${paint(look, 'yellow', r.kind === 'background' ? 'Still running in the background' : 'Still running')} ${paint(look, 'bold', clockOf(r.seconds))} ${paint(look, 'gray', '|')} ${r.text || r.name}${r.last ? ' ' + paint(look, 'gray', '→ ' + r.last) : ''}`,
          );
        }
    if (options.code && tick % GIT_TICKS === 0)
      for (const { git, conversation } of gits.values()) {
        const found = git.poll();
        if (found.length) {
          console.log('');
          say(
            '🔍',
            `Changed outside an edit tool (a command, a script or another session) in ${conversation.folder}:`,
            'dim',
          );
        }
        for (const change of found) await show(conversation, gitChange(git.cwd, change));
      }
    for (const c of open.values()) {
      let read;
      try {
        read = readEntries(c.file, c.offset, c.rest);
      } catch {
        continue;
      }
      c.offset = read.end;
      c.rest = read.rest;
      if (read.skipped)
        say(
          '⏭️',
          `${c.folder}: ${Math.round(read.skipped / 1e6)} MB of new transcript left out (more than 8 MB at one time).`,
          'yellow',
        );
      for (const entry of read.entries) {
        const lane = c.lanes.of(entry);
        for (const done of c.progress.feed(entry))
          if (options.progress)
            console.log(
              `${paint(look, 'gray', clock(entry.timestamp))}  ${paint(look, 'blue', c.folder)}  ${look.icons ? (done.status === 'completed' ? '🏁 ' : '💥 ') : ''}${paint(look, done.status === 'completed' ? 'green' : 'red', done.status === 'completed' ? 'Background finished' : 'Background ' + safe(done.status))} ${paint(look, 'bold', clockOf(done.seconds))} ${paint(look, 'gray', '|')} ${done.text}`,
            );
        const why = whyOf(entry);
        if (why) c.why = why;
        // --changes prints the change events next to the steps; the prompt itself is already a step, so the "asked"
        // event is left out.
        const events = options.events ? c.feed.events(entry).filter(e => e.kind !== 'asked') : [];
        for (const step of stepsOf(entry, { full: options.busywork, commands: options.commands })) {
          if (step.kind === 'prompt') {
            console.log('');
            c.why = '';
          }
          console.log(renderStep(c.folder, laneLabel(c, lane), step, look));
          total.add(step);
          period.add(step);
        }
        for (const event of events)
          for (const line of renderEvent(event, { folder: c.folder, clock, ...styleOf(look) })) console.log(line);
        for (const change of changesOf(entry)) {
          await show(c, change);
          gits.get(c.cwd)?.git.shown(change.file);
        }
      }
    }
  }
}

/** aidr journal [day|week|month|project] [--date YYYY-MM-DD] (journal.mjs, spec 9.12): Markdown on standard output.
 * In a terminal it is drawn with markdown-term.mjs; in a pipe or a file it stays plain Markdown. */
async function journal(args, cwd) {
  const { PERIODS_OF, collect, collectProject, dateOf, renderJournal, renderLifecycle } = await import('./journal.mjs');
  const at = args.indexOf('--date');
  let date = new Date();
  try {
    if (at >= 0) {
      date = dateOf(args[at + 1]);
      args.splice(at, 2);
    }
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const words = args.filter(a => !a.startsWith('--')),
    period = words[0] || 'day';
  const unknown = args.filter(a => a.startsWith('--') && !['--plain', '--learn', '--security'].includes(a));
  if (!PERIODS_OF.includes(period) || words.length > 1 || unknown.length) {
    console.error(`Run aidr journal [${PERIODS_OF.join('|')}] [--date YYYY-MM-DD] [--learn] [--security].`);
    return 2;
  }
  const cards = args.includes('--learn') || args.includes('--security');
  if (cards && period !== 'day') {
    console.error('The cards (--learn, --security) are for one day: aidr journal day --learn --security.');
    return 2;
  }
  const dir = cwd ? resolve(cwd) : watchFolder();
  // A note on standard error before a long read, so the wait has a reason; a pipe or a file gets only the journal.
  const note = text => process.stderr.isTTY && console.error(text);
  const options = { cwd: dir, date, projects: PROJECTS, folderName: projectFolder(dir), note };
  let lines;
  if (period === 'project') lines = renderLifecycle(await collectProject(options));
  else {
    const reader = new OntologyReader(dir);
    try {
      const j = await collect({ ...options, period, reader });
      lines = renderJournal(j);
      // The cards of the day, made again by local Claude (or Gemma for Learn) when the journal is read.
      if (cards) {
        const { cardsOf, cardLines } = await import('./journal.mjs');
        const at = { now: 0 };
        const learner = args.includes('--learn') ? new Learner({ now: () => at.now }) : null;
        const reviewer = args.includes('--security') ? new SecurityReviewer() : null;
        for (const problem of [learner?.problem(), reviewer?.problem()].filter(Boolean)) note(problem);
        const day = [...j.days.values()][0];
        if (day) {
          note('Asking for the cards of the day…');
          lines = [...lines, '', ...cardLines(await cardsOf(day, { cwd: dir, learner, reviewer, at }), dir)];
        }
      }
    } finally {
      reader.close();
    }
  }
  const look = lookFor({ tty: Boolean(process.stdout.isTTY), env: process.env, plain: args.includes('--plain') });
  if (look === PLAIN) for (const line of lines) console.log(line);
  else
    for (const line of markdownLines(lines, {
      paint: (k, t) => paint(look, k, t),
      width: Math.min(140, (process.stdout.columns || 120) - 2),
    }))
      console.log(line);
  return 0;
}

/** Where the diagrams go. A terminal cannot draw Mermaid text, so in a terminal aidr draws the code graph and the
 * models itself (box drawing); --mermaid adds the Mermaid text, ready to paste where Mermaid is drawn (GitHub, a
 * document). report: true for aidr stage, whose Markdown in a pipe or a file has the Mermaid text by default. */
export function mermaidMode({ argv = [], tty = false, report = false } = {}) {
  const text = argv.includes('--mermaid') || (report && !tty);
  return { text, drawings: tty || !text };
}

/** The view flags: each one adds one thing to the watch, and they add up (owner, 22 November 2026: "make aidr run
 * minimal by default, make all aidr flags positive ... make the aidr flags cumulative"). --all turns on every view
 * flag; the cards (--learn, --security) stay off unless named, as they call a model. */
export const VIEWS = [
  'code',
  'full-diff',
  'map',
  'ontology',
  'stage',
  'progress',
  'agents',
  'commands',
  'changes',
  'busywork',
];
const CARDS = ['learn', 'learn-code', 'security'];
// --heartbeat is the first name of --agents.
const SCOPE = ['global', 'outside', 'plain', 'mermaid', 'all', 'watch', 'heartbeat'];
export const FLAGS = [...VIEWS, ...CARDS, ...SCOPE].map(f => '--' + f);

/** The old negative flags: the view is now off by default, and the message names the flag that turns it on. */
export const REMOVED = {
  '--no-code': '--code',
  '--no-map': '--map',
  '--no-ontology': '--ontology',
  '--no-mermaid': null,
  '--no-stage': '--stage',
  '--no-progress': '--progress',
  '--no-heartbeat': '--agents',
  '--no-commands': '--commands',
  '--here': null,
};

/** The options of the watch. With no flag, the watch is minimal: each step on one line, and each code change as one
 * line with its file and its line counts. */
export function optionsOf(argv, { dir = '', tty = false } = {}) {
  const all = argv.includes('--all');
  const on = name => argv.includes('--' + name) || (all && VIEWS.includes(name));
  const full = on('full-diff');
  return {
    global: on('global'),
    dir,
    // The code view: the diff, Claude's reason, the notes and a question; --full-diff implies it.
    code: on('code') || full,
    full,
    map: on('map'),
    ontology: on('ontology'),
    outside: on('outside'),
    // The change events (planned, in process, completed), next to the steps.
    changes: on('changes'),
    events: on('changes'),
    // Every step, Claude's text and each prompt in full.
    busywork: on('busywork'),
    mermaid: mermaidMode({ argv, tty }).text,
    drawings: mermaidMode({ argv, tty }).drawings,
    stage: on('stage'),
    progress: on('progress'),
    // The agent map at the start of the watch and every 10 minutes.
    heartbeat: on('agents') || on('heartbeat'),
    // The command lines of each shell step (secrets masked).
    commands: on('commands'),
    // The cards call a model: on only when named (spec 9.9, Q9); --learn-code implies --learn (Q12).
    learn: on('learn') || on('learn-code'),
    learnCode: on('learn-code'),
    security: on('security'),
  };
}

/** aidr --help: the usage line and one line for each command and flag (help.mjs). */
export const HELP = helpLines(VERSION).join('\n');

/** The command line: a subcommand (watch, list or stage), the options, and --cwd <folder>. */
export function parseArgs(argv) {
  const args = [...argv];
  let cwd = null;
  const at = args.indexOf('--cwd');
  if (at >= 0) {
    cwd = args[at + 1] || null;
    args.splice(at, 2);
  }
  const sub = ['list', 'stage', 'watch', 'journal', 'agents'].includes(args[0]) ? args.shift() : 'watch';
  return { sub, cwd, args };
}

/** The flags that npm kept for itself. `aidr --all` gives --all to npm, not to aidr; npm then sets
 * npm_config_all=true for the script. Read only when npm starts an aidr script, and only for aidr's own flags. */
export function npmFlags(env = process.env) {
  if (!String(env.npm_lifecycle_event || '').startsWith('aidr')) return [];
  return [...FLAGS, '--explain', '--example']
    .filter(f => env['npm_config_' + f.slice(2).replace(/-/g, '_')] === 'true')
    .filter(f => f !== '--watch');
}

/** The views that the watch shows, for its first line. */
export function viewsLine(options) {
  const on = [
    ['code', options.code && !options.full],
    ['full-diff', options.full],
    ['map', options.map],
    ['ontology', options.ontology],
    ['mermaid', options.mermaid],
    ['stage', options.stage],
    ['progress', options.progress],
    ['agents', options.heartbeat],
    ['commands', options.commands],
    ['changes', options.changes],
    ['busywork', options.busywork],
    ['learn', options.learn && !options.learnCode],
    ['learn-code', options.learnCode],
    ['security', options.security],
  ]
    .filter(([, v]) => v)
    .map(([k]) => '--' + k);
  return on.length
    ? `Views: ${on.join(' ')}.`
    : 'Views: none, the minimal watch. Add flags for more, for example --all, or --code --agents --commands.';
}

export async function main(argv) {
  argv = [...argv, ...npmFlags().filter(f => !argv.includes(f))];
  // --help, --explain and --example: about aidr, or about each flag and command named with them (help.mjs).
  const mode =
    argv.includes('--help') || argv.includes('-h')
      ? 'help'
      : argv.includes('--explain')
        ? 'explain'
        : argv.includes('--example')
          ? 'example'
          : null;
  if (mode) {
    const lines = topicLines(mode, argv, VERSION);
    if (!lines) {
      console.error(
        `Unknown option: ${argv.filter(a => a.startsWith('--') && !FLAGS.includes(a) && !['--help', '--explain', '--example', '--cwd'].includes(a)).join(' ')}. Run aidr --help.`,
      );
      return 2;
    }
    for (const line of lines) console.log(line);
    return 0;
  }
  if (argv.includes('--version')) {
    console.log(VERSION);
    return 0;
  }
  const { sub, cwd, args } = parseArgs(argv);
  if (cwd === null && argv.includes('--cwd')) {
    console.error('--cwd needs a folder.');
    return 2;
  }
  if (sub === 'journal') return journal(args, cwd);
  if (sub === 'stage') {
    const { stageLines, rangeOf } = await import('./stage-report.mjs');
    let range;
    try {
      range = rangeOf(args.find(a => !a.startsWith('--')));
    } catch (error) {
      console.error(error.message);
      return 2;
    }
    const tty = Boolean(process.stdout.isTTY),
      mode = mermaidMode({ argv: args, tty, report: true });
    const lines = await stageLines(range, {
      cwd: cwd ? resolve(cwd) : watchFolder(),
      mermaid: mode.text,
      drawings: mode.drawings,
    });
    // In a terminal the report is drawn (tables, the drawings); in a pipe or a file it stays Markdown with Mermaid.
    const look = lookFor({ tty, env: process.env, plain: args.includes('--plain') });
    if (!tty) for (const line of lines) console.log(line);
    else
      for (const line of markdownLines(lines, {
        paint: (k, t) => paint(look, k, t),
        width: Math.max(60, (process.stdout.columns || 120) - 2),
      }))
        console.log(line);
    return 0;
  }
  // --watch was the old way to start the watch; the watch is now the default and the option stays accepted.
  argv = args;
  const removed = argv.filter(a => Object.hasOwn(REMOVED, a));
  if (removed.length) {
    const a = removed[0];
    console.error(
      REMOVED[a]
        ? `${a} is gone: the watch is minimal by default, and ${REMOVED[a]} turns that view on.`
        : `${a} is gone: it is the default now.`,
    );
    return 2;
  }
  const unknown = argv.filter(a => !FLAGS.includes(a));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(' ')}. Run aidr --help.`);
    return 2;
  }
  const options = optionsOf(argv, { dir: cwd ? resolve(cwd) : watchFolder(), tty: Boolean(process.stdout.isTTY) });
  const look = lookFor({ tty: Boolean(process.stdout.isTTY), env: process.env, plain: argv.includes('--plain') });
  console.log(
    paint(
      look,
      'dim',
      options.global
        ? 'Every folder (--global).'
        : `Folder: ${options.dir} and its subfolders (--global shows every folder).`,
    ),
  );
  const now = conversationsNow(options).map(load);
  if (sub === 'agents') {
    for (const line of renderAgentMap(mapRows(now), { ...styleOf(look), clock: clock(new Date().toISOString()) }))
      console.log(line);
    return 0;
  }
  for (const line of renderList(now, look)) console.log(line);
  if (sub === 'watch') {
    console.log(paint(look, 'dim', viewsLine(options)));
    await watch(options, look);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main(process.argv.slice(2));
