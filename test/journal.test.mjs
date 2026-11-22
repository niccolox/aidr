// SPDX-License-Identifier: AGPL-3.0-only
// aidr journal (journal.mjs, WTF-PKG-1 section 9.12): fixture transcripts and a fixture git repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collect,
  collectProject,
  dateOf,
  lineTime,
  periodOf,
  renderJournal,
  renderLifecycle,
  stagesOf,
  startOffset,
  usageOf,
} from '../lib/journal.mjs';

const local = (m, d, h, min = 0) => new Date(2026, m - 1, d, h, min);
const iso = date => date.toISOString();
const part = (...p) => p.join('');

/** One transcript line, with the timestamp last, as Claude Code writes it. */
const line = (time, body) => JSON.stringify({ sessionId: 'sess-0001-aaaa', ...body, timestamp: iso(time) });
const prompt = (time, text) => line(time, { type: 'user', message: { content: text } });
const tool = (time, id, name, input) =>
  line(time, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (time, id, isError = false) =>
  line(time, {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] },
  });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aidr-journal-'));
  const cwd = join(root, 'shop'),
    projects = join(root, 'projects'),
    folderName = '-shop';
  mkdirSync(join(projects, folderName), { recursive: true });
  mkdirSync(join(cwd, 'app'), { recursive: true });
  const secret = part('sk-ant-api03-', 'B'.repeat(40));
  writeFileSync(
    join(projects, folderName, 'sess-0001.jsonl'),
    [
      prompt(local(11, 20, 9), 'An old prompt of the day before'),
      prompt(local(11, 21, 9), `Fix the cart total; the key is ${secret}`),
      prompt(local(11, 21, 9, 1), '[Request interrupted by user]'),
      prompt(local(11, 21, 9, 2), '<system-reminder>not a prompt</system-reminder>'),
      tool(local(11, 21, 9, 5), 't1', 'TodoWrite', { todos: [{ content: 'Fix the cart total', status: 'pending' }] }),
      tool(local(11, 21, 9, 6), 'e1', 'Edit', {
        file_path: join(cwd, 'app/cart.py'),
        old_string: 'a',
        new_string: 'b',
      }),
      tool(local(11, 21, 9, 7), 'e2', 'Edit', { file_path: join(cwd, '.env'), old_string: 'a', new_string: 'b' }),
      tool(local(11, 21, 9, 8), 'b1', 'Bash', { command: 'node --test tests/', description: 'Run the cart tests' }),
      result(local(11, 21, 9, 12), 'b1'),
      tool(local(11, 21, 9, 13), 'b2', 'Bash', { command: 'pytest -q', description: 'Run pytest' }),
      result(local(11, 21, 9, 14), 'b2', true),
      tool(local(11, 21, 9, 20), 't2', 'TodoWrite', {
        todos: [{ content: 'Fix the cart total', status: 'completed' }],
      }),
      prompt(local(11, 22, 10), 'A prompt of the next day'),
    ].join('\n') + '\n',
  );
  const git = (args, date) =>
    execFileSync('git', ['-C', cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date && iso(date),
        GIT_COMMITTER_DATE: date && iso(date),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
      stdio: 'ignore',
    });
  git(['init', '-q']);
  const commit = (date, message, files) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(cwd, file, '..'), { recursive: true });
      writeFileSync(join(cwd, file), text);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', message], date);
  };
  commit(local(9, 10, 12), 'start the shop', { 'README.md': 'shop\n' });
  git(['tag', 'v0.1.0'], local(9, 10, 12));
  commit(local(10, 5, 12), 'docs: the plan', { 'docs/plan.md': 'plan\n' });
  commit(local(11, 21, 10), 'fix(cart): the total counts the quantity', {
    'app/cart.py':
      'from pydantic import BaseModel\n\n\nclass CartItem(BaseModel):\n    price: int\n    quantity: int = 1\n\n\ndef total(items):\n    return sum(i.price * i.quantity for i in items)\n',
    '.env': 'KEY=1\n',
  });
  git(['tag', 'v0.2.0'], local(11, 21, 10));
  return { root, cwd, projects, folderName, secret };
}

const reader = { ask: async (file, names) => ({ models: names.includes('CartItem') ? [{ name: 'CartItem' }] : [] }) };

test('periods: a day, a week from Monday, a month, in local time; --date', () => {
  const sunday = local(11, 22, 15);
  assert.deepEqual(periodOf('day', sunday), { start: local(11, 22, 0), end: local(11, 23, 0) });
  assert.deepEqual(periodOf('week', sunday), { start: local(11, 16, 0), end: local(11, 23, 0) });
  assert.deepEqual(periodOf('week', local(11, 16, 1)).start, local(11, 16, 0), 'a Monday starts its own week');
  assert.deepEqual(periodOf('month', sunday), { start: local(11, 1, 0), end: local(12, 1, 0) });
  assert.deepEqual(dateOf('2026-11-17'), local(11, 17, 0));
  assert.throws(() => dateOf('2026-02-30'));
  assert.throws(() => periodOf('year'));
});

test('the day journal: sessions, prompts, changes, commits, tests, files, symbols and models; no secret, no private file', async () => {
  const f = fixture();
  try {
    const j = await collect({ ...f, period: 'day', date: local(11, 21, 12), reader });
    const day = j.days.get('2026-11-21');
    assert.equal(day.prompts.length, 1, 'harness text and interruptions are not prompts');
    assert.equal(day.edits, 1, 'the edit of .env is not counted');
    assert.deepEqual(
      day.tests.map(t => t.ok),
      [true, false],
    );
    assert.equal(day.long.length, 1, 'the 4-minute test run is a long command');
    assert.deepEqual([...j.files.keys()], ['app/cart.py'], '.env is never named');
    assert.ok(j.symbols.has('total') && j.symbols.has('CartItem'));
    assert.deepEqual(j.models, ['CartItem']);
    const text = renderJournal(j).join('\n');
    assert.match(text, /^# Journal of shop: Saturday,? 21 November 2026/);
    assert.match(text, /1 session · 1 prompt · 1 commit · 1 file changed · 1 edit · 2 test runs \(1 failed\)/);
    assert.match(text, /### Completed\n\n- \d\d:\d\d Task: Fix the cart total/);
    assert.match(text, /fix\(cart\): the total counts the quantity/);
    assert.match(text, /Pydantic models: `CartItem`/);
    assert.ok(!text.includes(f.secret), 'the secret is masked');
    assert.ok(!text.includes('.env') && !text.includes('old prompt') && !text.includes('next day'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a day with no session and no commit says so; a week lists its days and the days with no work', async () => {
  const f = fixture();
  try {
    const empty = renderJournal(await collect({ ...f, period: 'day', date: local(11, 18, 12) })).join('\n');
    assert.match(empty, /No Claude session and no commit on this day\./);
    const week = renderJournal(
      await collect({ ...f, period: 'week', date: local(11, 21, 12), reader, now: local(11, 23, 0) }),
    ).join('\n');
    assert.match(week, /^# Journal of shop: the week of Monday,? 16 November 2026/);
    assert.match(week, /## Saturday,? 21 November 2026/);
    assert.match(week, /## Sunday,? 22 November 2026/);
    assert.match(week, /Days with no session and no commit: 16, 17, 18, 19\./);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('the project lifecycle: months, tags, top folders, tasks', async () => {
  const f = fixture();
  try {
    const p = await collectProject({ ...f, date: local(11, 22, 12) });
    const text = renderLifecycle(p).join('\n');
    assert.match(text, /^# Lifecycle of shop/);
    assert.match(text, /first commit Thursday,? 10 September 2026/);
    assert.match(text, /\| September 2026 \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| v0\.1\.0 \|/);
    assert.match(text, /\| October 2026 \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \|/);
    assert.match(text, /\| November 2026 \| 1 \| 1 \| 10 \| 0 \| 1 \| 3 \| 1 \| v0\.2\.0 \|/);
    assert.match(text, /- 2026-11-21 `v0\.2\.0`\n- 2026-09-10 `v0\.1\.0`/);
    assert.match(text, /\| docs\/ \| 2026-10-05 \| 2026-10-05 \| 1 \|/);
    assert.match(text, /1 completed change · 0 in process · 0 planned · 0 not completed\./);
    assert.ok(!text.includes('.env'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('reading starts near the period: the search back from the end, and the time of a line without parsing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'aidr-offset-'));
  try {
    const file = join(root, 't.jsonl');
    const lines = Array.from({ length: 200 }, (_, i) =>
      prompt(new Date(Date.UTC(2026, 10, 1) + i * 3600_000), 'p' + i),
    );
    writeFileSync(file, lines.join('\n') + '\n');
    const start = new Date(Date.UTC(2026, 10, 1) + 150 * 3600_000);
    const offset = startOffset(file, start, 512);
    const before = lines.slice(0, 150).join('\n').length;
    assert.ok(offset > 0 && offset <= before, 'starts before the first line of the period, not at 0');
    assert.equal(startOffset(file, new Date(Date.UTC(2026, 0, 1)), 512), 0);
    assert.equal(lineTime(lines[3]), Date.UTC(2026, 10, 1) + 3 * 3600_000);
    assert.ok(Number.isNaN(lineTime('{"no":"time"}')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stages: the last stage of each task wins', () => {
  const g = stagesOf([
    { time: 1, stage: 'planned', kind: 'task', text: 'a' },
    { time: 2, stage: 'process', kind: 'task', text: 'a' },
    { time: 3, stage: 'done', kind: 'task', text: 'a' },
    { time: 4, stage: 'planned', kind: 'task', text: 'b' },
  ]);
  assert.deepEqual([g.done.length, g.planned.length, g.process.length], [1, 1, 0]);
});

// Owner, 22 November 2026: "aidr record token cost in the journal entries".
test('the cost of one reply at API list price: cache writes, cache reads, fast mode, and a model with no price', () => {
  const u = usageOf('claude-opus-5-5', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 2_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  });
  // 4 input + 20 output + 0.20 read + 4 x 1.25 (5 minutes) + 4 x 2 (1 hour) = 37.20
  assert.equal(u.cost.toFixed(2), '37.20');
  assert.equal(usageOf('claude-opus-5-5', { output_tokens: 1_000_000, speed: 'fast' }).cost, 40);
  assert.equal(usageOf('claude-haiku-5-5', { input_tokens: 1_000_000 }).cost, 0.1);
  assert.equal(usageOf('some-other-model', { input_tokens: 10 }).cost, null);
});

test('the day journal counts a reply once, adds the agents of a session, and gives tokens and cost', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aidr-tokens-')),
    projects = join(root, 'projects'),
    folderName = '-shop',
    dir = join(projects, folderName);
  mkdirSync(join(dir, 'sess-0001', 'subagents'), { recursive: true });
  const reply = (time, id, usage, sessionId = 'sess-0001-aaaa') =>
    JSON.stringify({
      sessionId,
      type: 'assistant',
      message: { id, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'ok' }] },
      timestamp: iso(time),
    });
  const usage = { input_tokens: 0, output_tokens: 1_000_000 };
  // One reply written as two entries (two content blocks) with the same message id: $20 once, not $40.
  writeFileSync(
    join(dir, 'sess-0001.jsonl'),
    [
      prompt(local(11, 21, 10), 'fix the cart'),
      reply(local(11, 21, 10, 1), 'msg_1', usage),
      reply(local(11, 21, 10, 1), 'msg_1', usage),
      '',
    ].join('\n'),
  );
  // An agent of the session: its brief is not a prompt; its reply adds $20.
  writeFileSync(
    join(dir, 'sess-0001', 'subagents', 'agent-a1.jsonl'),
    [prompt(local(11, 21, 10, 2), 'the agent brief'), reply(local(11, 21, 10, 3), 'msg_2', usage), ''].join('\n'),
  );
  try {
    const j = await collect({ cwd: root, period: 'day', date: local(11, 21, 12), projects, folderName, git: () => '' });
    const day = j.days.get('2026-11-21');
    assert.equal(day.prompts.length, 1, 'the agent brief is not a prompt');
    const text = renderJournal(j).join('\n');
    assert.match(text, /2\.0 M tokens · \$40\.00\*\*/);
    assert.match(text, /`sess-000` · .* · 1\.0 M tokens · \$20\.00/);
    assert.match(text, /\| `claude-opus-5-5` \| 0 \| 0 \| 0 \| 2\.0 M \| \$40\.00 \|/);
    assert.match(text, /Agents started by the sessions: 1\.0 M tokens, \$20\.00\./);
    assert.match(text, /Cost at API list price/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
