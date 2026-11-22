// SPDX-License-Identifier: AGPL-3.0-only
/** The change view of the watch (aidr --changes): only the changes of a Claude session, in three groups.
 *
 * - Planned: the request of the person, a plan (ExitPlanMode) and new task-list items (TodoWrite, TaskCreate).
 * - In process: a task-list item that starts, and each code edit (the edits come from code-tutor.mjs changesOf).
 * - Completed: a task-list item that is done, a commit, a push, a pull request, a merge and a deploy.
 *
 * Reads, searches, commands that change nothing and Claude's text between steps are not shown: they are the
 * work around a change, not the change.
 */

import { safe } from './code-tutor.mjs';

// Every text from a transcript goes through safe(): no terminal control bytes, secrets masked (audit F1, F2).
const cut = (text, max) => {
  const line = safe(String(text || '').replace(/\s+/g, ' ')).trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
};

/** The commands whose result is a completed change. Each has the label of its line. */
const DONE_COMMANDS = [
  { kind: 'commit', pattern: /\bgit\b[^|;&]*\bcommit\b/ },
  { kind: 'push', pattern: /\bgit\b[^|;&]*\bpush\b/ },
  { kind: 'pr', pattern: /\bgh pr create\b/ },
  { kind: 'merge', pattern: /\bgh pr merge\b/ },
  { kind: 'deploy', pattern: /\brelease\.py\s+deploy\s+(\w+)|\bwrangler\s+deploy\b/ },
];

/** The text of a tool result: a string, or the text parts of a list. */
function resultText(part) {
  const c = part?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .filter(p => p?.type === 'text')
      .map(p => String(p.text || ''))
      .join('\n');
  return '';
}

/** The first lines of a plan that a person reads first: its headings and its list items. */
export function planLines(plan, max = 8) {
  const lines = String(plan || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^(#{1,4}\s|[-*]\s|\d+[.)]\s)/.test(l));
  const out = lines.slice(0, max).map(l => cut(l.replace(/^#{1,4}\s+/, ''), 140));
  if (lines.length > max) out.push(`… ${lines.length - max} more lines`);
  return out;
}

/** Turns the entries of one transcript into change events. It keeps the state of one conversation: the task list,
 * the task names and the commands that wait for their result. */
export class ChangeFeed {
  constructor() {
    this.todos = new Map();
    this.tasks = new Map();
    this.waiting = new Map();
  }

  /** The change events of one transcript entry, in order. */
  events(entry) {
    const content = entry?.message?.content,
      time = entry?.timestamp || '';
    if (entry?.type === 'assistant' && Array.isArray(content))
      return content.flatMap(part => (part?.type === 'tool_use' ? this.#tool(part, time) : []));
    if (entry?.type !== 'user' || entry.isMeta) return [];
    if (Array.isArray(content) && content.some(p => p?.type === 'tool_result'))
      return content.flatMap(part => (part?.type === 'tool_result' ? this.#result(part, time) : []));
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content) && content.every(p => p?.type === 'text')
          ? content.map(p => p.text).join(' ')
          : '';
    // Text that the harness adds (reminders, task notices) is not a request of the person.
    if (text.trim() && !/^\s*</.test(text)) return [{ time, stage: 'planned', kind: 'asked', text: cut(text, 200) }];
    return [];
  }

  #tool(part, time) {
    const name = String(part.name || ''),
      input = part.input || {};
    if (name === 'ExitPlanMode')
      return [{ time, stage: 'planned', kind: 'plan', text: 'A plan', lines: planLines(input.plan) }];
    if (name === 'TodoWrite') return this.#todos(Array.isArray(input.todos) ? input.todos : [], time);
    if (name === 'TaskCreate') {
      const subject = cut(input.subject || input.description || '', 140);
      if (part.id) this.waiting.set(part.id, { kind: 'task', subject });
      return subject ? [{ time, stage: 'planned', kind: 'task', text: subject }] : [];
    }
    if (name === 'TaskUpdate') {
      const subject = this.tasks.get(String(input.taskId)) || `task ${input.taskId}`;
      if (input.status === 'in_progress') return [{ time, stage: 'process', kind: 'task', text: subject }];
      if (input.status === 'completed') return [{ time, stage: 'done', kind: 'task', text: subject }];
      return [];
    }
    if (name === 'Bash' && part.id) {
      const command = String(input.command || '');
      const found = DONE_COMMANDS.filter(d => d.pattern.test(command)).map(d => ({
        kind: d.kind,
        target: (command.match(d.pattern) || [])[1] || '',
      }));
      if (found.length)
        this.waiting.set(part.id, { kind: 'commands', found, description: cut(input.description || '', 140) });
    }
    return [];
  }

  #todos(todos, time) {
    const out = [];
    for (const t of todos) {
      const text = cut(t?.content || '', 140),
        status = String(t?.status || 'pending');
      if (!text) continue;
      const was = this.todos.get(text);
      this.todos.set(text, status);
      if (was === status) continue;
      if (status === 'pending' && was === undefined) out.push({ time, stage: 'planned', kind: 'task', text });
      else if (status === 'in_progress')
        out.push({ time, stage: 'process', kind: 'task', text: cut(t.activeForm || text, 140) });
      else if (status === 'completed') out.push({ time, stage: 'done', kind: 'task', text });
    }
    return out;
  }

  #result(part, time) {
    const wait = this.waiting.get(part.tool_use_id);
    if (!wait) return [];
    this.waiting.delete(part.tool_use_id);
    const text = resultText(part);
    if (wait.kind === 'task') {
      const id = text.match(/#?(\d+)/);
      if (id) this.tasks.set(id[1], wait.subject);
      return [];
    }
    const out = [];
    for (const { kind, target } of wait.found) {
      if (kind === 'commit') {
        // "[master 1de962a6] feat(local): ..." is the line git prints for a new commit.
        const m = text.match(/^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/m);
        if (m) out.push({ time, stage: 'done', kind, text: `${m[2]} ${cut(m[3], 140)}`, detail: cut(m[1], 60) });
      } else if (kind === 'push') {
        const m = text.match(/([0-9a-f]{7,}\.\.[0-9a-f]{7,})\s+(\S+)\s+->\s+(\S+)/);
        if (m) out.push({ time, stage: 'done', kind, text: cut(`${m[2]} to ${m[3]} (${m[1]})`, 140) });
      } else if (kind === 'pr') {
        const m = text.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
        if (m) out.push({ time, stage: 'done', kind, text: cut(m[0], 140) });
      } else if (kind === 'merge') {
        if (!part.is_error) out.push({ time, stage: 'done', kind, text: wait.description || 'A pull request merged' });
      } else if (kind === 'deploy') {
        // A failed deploy is a change that did not complete: it is shown, so the person does not think it is live.
        out.push({
          time,
          stage: part.is_error ? 'failed' : 'done',
          kind,
          text: target
            ? `${cut(target, 40)} ${part.is_error ? 'did not deploy' : 'deployed'}`
            : wait.description || 'A deploy',
        });
      }
    }
    return out;
  }
}

const LABEL = {
  planned: { icon: '🗺️ ', word: 'Planned', colour: 'magenta' },
  process: { icon: '🔧', word: 'In process', colour: 'cyan' },
  done: { icon: '✅', word: 'Completed', colour: 'green' },
  failed: { icon: '❌', word: 'Not completed', colour: 'red' },
};
const KIND = {
  asked: 'Asked',
  plan: 'Plan',
  task: 'Task',
  commit: 'Commit',
  push: 'Push',
  pr: 'Pull request',
  merge: 'Merge',
  deploy: 'Deploy',
};

/** The lines of one change event. */
export function renderEvent(event, { folder = '', clock = t => t, paint = (c, t) => t, icons = false } = {}) {
  const l = LABEL[event.stage] || LABEL.process;
  const head = `${paint('gray', clock(event.time))}  ${folder ? paint('blue', folder) + '  ' : ''}${icons ? l.icon + ' ' : ''}${paint(l.colour, l.word)} ${paint('gray', '·')} ${paint('bold', KIND[event.kind] || event.kind)}`;
  const out = [
    `${head}${event.text ? ' ' + paint('gray', '|') + ' ' + (event.kind === 'asked' ? paint('magenta', event.text) : event.text) : ''}`,
  ];
  for (const line of event.lines || []) out.push(`  ${paint('gray', '│')} ${line}`);
  return out;
}

/** The header line of a code edit in the change view: the edits are always "in process". */
export function editHeader({ folder = '', time = '', clock = t => t, paint = (c, t) => t, icons = false } = {}) {
  return `${paint('gray', clock(time))}  ${folder ? paint('blue', folder) + '  ' : ''}${icons ? LABEL.process.icon + ' ' : ''}${paint('cyan', LABEL.process.word)} ${paint('gray', '·')} ${paint('bold', 'Edit')}`;
}
