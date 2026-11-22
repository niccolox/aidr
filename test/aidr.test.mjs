// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FANCY,
  Lanes,
  PLAIN,
  Tally,
  claudeProcesses,
  iconOf,
  inFolder,
  watchFolder,
  lookFor,
  parseProcesses,
  projectFolder,
  renderList,
  renderStep,
  sessionIdOf,
  stateOf,
  stepsOf,
  mermaidMode,
  optionsOf,
  main,
} from '../lib/aidr.mjs';

const ID = '5734d428-61fb-47cd-81dc-c16f1feabafc';
const PS = [
  ' 3031402 3028554    4800 claude          /ext/native-binary/claude --output-format stream-json --resume=' +
    ID +
    ' --add-dir=/home/x',
  ' 3310554 3031402     156 bash            /bin/bash -c uv run pytest',
  ' 3031556 3031402    4737 npm exec playwr npm exec playwright run-test-mcp-server',
  ' 3257120 3233359    1800 claude          /ext/native-binary/claude --output-format stream-json',
  '    4242       1      10 bash            /bin/bash -c echo claude',
].join('\n');

test('the process list gives the Claude processes with their commands in operation, and no other process', () => {
  const found = claudeProcesses(parseProcesses(PS));
  assert.deepEqual(
    found.map(p => [p.pid, p.commands, p.oldestCommand]),
    [
      [3031402, 1, 156],
      [3257120, 0, 0],
    ],
  );
  assert.equal(sessionIdOf(found[0].args), ID);
  assert.equal(sessionIdOf(found[1].args), null);
  assert.equal(sessionIdOf('claude --session-id ' + ID), ID);
});

test('the transcript folder of a working folder replaces every other character with a dash', () => {
  assert.equal(projectFolder('/home/x/Projects/saasx2x.ontology'), '-home-x-Projects-saasx2x-ontology');
});

test('a step shows the tool and its description, never the command or a tool result', () => {
  const entry = {
    type: 'assistant',
    timestamp: '2026-11-18T18:10:41.000Z',
    message: {
      content: [
        { type: 'text', text: 'I check the tests.\nSecond line.' },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'curl -H "Authorization: Bearer SECRET" x', description: 'Run the tests' },
        },
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.py' } },
        { type: 'thinking', thinking: 'private' },
      ],
    },
  };
  const steps = stepsOf(entry);
  assert.deepEqual(
    steps.map(s => [s.name, s.text]),
    [
      ['SAYS', 'I check the tests.'],
      ['Bash', 'Run the tests'],
      ['Read', '/repo/a.py'],
    ],
  );
  assert.ok(!JSON.stringify(steps).includes('SECRET'));
  const result = { type: 'user', message: { content: [{ type: 'tool_result', content: 'password=hunter2' }] } };
  assert.deepEqual(stepsOf(result), []);
  assert.deepEqual(
    stepsOf({ type: 'user', message: { content: 'status?' } }).map(s => [s.name, s.text]),
    [['PROMPT', 'status?']],
  );
  // Text that the harness adds is not a prompt of the person.
  assert.deepEqual(stepsOf({ type: 'user', message: { content: '<task-notification>done</task-notification>' } }), []);
  assert.deepEqual(stepsOf({ type: 'ai-title', aiTitle: 'x' }), []);
});

test('two processes on one transcript get two letters, and each entry follows its parent', () => {
  const lanes = new Lanes();
  assert.equal(lanes.of({ type: 'assistant', uuid: 'a1', parentUuid: 'before-1' }), 'A');
  assert.equal(lanes.of({ type: 'assistant', uuid: 'b1', parentUuid: 'before-2' }), 'B');
  assert.equal(lanes.of({ type: 'user', uuid: 'a2', parentUuid: 'a1' }), 'A');
  assert.equal(lanes.of({ type: 'assistant', uuid: 'b2', parentUuid: 'b1' }), 'B');
  assert.equal(lanes.of({ type: 'assistant', uuid: 'a3', parentUuid: 'a2' }), 'A');
  // An entry of a subagent with no known parent starts no letter; an entry with no ID has none.
  assert.equal(lanes.of({ type: 'assistant', uuid: 's1', parentUuid: null, isSidechain: true }), null);
  assert.equal(lanes.of({ type: 'ai-title' }), null);
  assert.equal(lanes.count, 2);
});

test('the list warns when two processes work on one conversation', () => {
  const step = { time: '2026-11-18T18:10:41.000Z', kind: 'tool', name: 'Bash', text: 'Run the tests' };
  const lines = renderList([
    {
      folder: 'saasx2x.ontology',
      title: 'Restore context',
      sessionId: ID,
      guessed: false,
      idleSeconds: 12,
      lastPrompt: null,
      lastStep: step,
      processes: [
        { pid: 1, ppid: 10, seconds: 4800, commands: 2, oldestCommand: 455 },
        { pid: 2, ppid: 20, seconds: 1800, commands: 0, oldestCommand: 0 },
      ],
    },
  ]).join('\n');
  assert.match(lines, /2 processes, 1 conversation/);
  assert.match(lines, /"Restore context"  5734d428/);
  assert.match(lines, /WARNING: 2 processes work on this one conversation/);
  assert.match(lines, /process 1 .* 2 commands in operation \(oldest 8 min\)/);
  assert.match(lines, /process 2 .* no command in operation/);
  assert.match(lines, /last step .* Bash \| Run the tests/);
  assert.deepEqual(renderList([]), ['No Claude session is in operation.']);
  assert.match(renderStep('repo', 'B', step), / repo B  Bash \| Run the tests$/);
  assert.match(renderStep('repo', '', step), / repo  Bash \| Run the tests$/);
});

test('each step has an icon: by tool, and by the description of a shell command', () => {
  const tool = (name, text = '') => ({ kind: 'tool', name, text });
  assert.equal(iconOf({ kind: 'prompt', name: 'PROMPT' }), '🙋');
  assert.equal(iconOf({ kind: 'says', name: 'SAYS' }), '💬');
  assert.equal(iconOf(tool('Read', '/a.py')), '📖');
  assert.equal(iconOf(tool('Edit')), '📝');
  assert.equal(iconOf(tool('Bash', 'Deploy the admin Worker')), '🚀');
  assert.equal(iconOf(tool('Bash', 'Run the directory tests')), '🧪');
  assert.equal(iconOf(tool('Bash', 'Commit and push the fix')), '📦');
  assert.equal(iconOf(tool('Bash', 'Run lint')), '🧹');
  assert.equal(iconOf(tool('Bash', 'Do something')), '💻');
  assert.equal(iconOf(tool('mcp__playwright-test__browser_click')), '🎭');
  assert.equal(iconOf(tool('mcp__other__x')), '🔌');
  assert.equal(iconOf(tool('NewTool')), '🔧');
});

test('the terminal look has icons and colours; a pipe, NO_COLOR and --plain do not', () => {
  assert.deepEqual(lookFor({ tty: true, env: {} }), FANCY);
  assert.deepEqual(lookFor({ tty: true, env: { NO_COLOR: '' } }), { icons: true, color: false });
  assert.deepEqual(lookFor({ tty: false, env: {} }), PLAIN);
  assert.deepEqual(lookFor({ tty: true, env: {}, plain: true }), PLAIN);
  const step = {
    time: '2026-11-18T18:10:41.000Z',
    kind: 'tool',
    name: 'mcp__playwright-test__browser_click',
    text: 'Open the page',
  };
  const line = renderStep('repo', 'B', step, FANCY);
  assert.ok(line.includes('\u001b['), 'an ANSI colour code');
  assert.match(line, /🎭 /);
  assert.ok(line.includes('playwright browser_click'));
  assert.ok(line.includes('▌B'));
  // Without colours there is no escape code, and the icons stay.
  const noColour = renderStep(
    'repo',
    '',
    { ...step, name: 'Bash', text: 'Run the tests' },
    { icons: true, color: false },
  );
  assert.match(noColour, / repo  🧪 Bash \| Run the tests$/);
});

test('the list shows the state of each conversation, and the tally counts the tools used most', () => {
  assert.equal(stateOf(5).word, 'working');
  assert.equal(stateOf(300).word, 'waiting');
  assert.equal(stateOf(3600).word, 'idle');
  const lines = renderList(
    [
      {
        folder: 'repo',
        title: 'T',
        sessionId: ID,
        guessed: false,
        idleSeconds: 5,
        lastPrompt: null,
        lastStep: null,
        processes: [
          { pid: 1, ppid: 2, seconds: 60, commands: 0, oldestCommand: 0 },
          { pid: 3, ppid: 4, seconds: 60, commands: 1, oldestCommand: 9 },
        ],
      },
    ],
    { icons: true, color: false },
  ).join('\n');
  assert.match(lines, /^🤖 Claude sessions in operation/);
  assert.match(lines, /🟢 repo  "T"  5734d428  working/);
  assert.match(lines, /⚠️ WARNING: 2 processes/);
  assert.match(lines, /💤 no command in operation/);
  assert.match(lines, /⏳ 1 command in operation/);
  assert.deepEqual(renderList([], { icons: true, color: false }), ['😴 No Claude session is in operation.']);
  const tally = new Tally();
  for (const s of [
    { kind: 'prompt' },
    { kind: 'tool', name: 'Bash', text: 'Run the tests' },
    { kind: 'tool', name: 'Bash' },
    { kind: 'tool', name: 'Read' },
    { kind: 'says' },
  ])
    tally.add(s);
  assert.equal(tally.line(), '5 steps · 1 prompt · Bash 2 · Read 1');
  assert.equal(tally.line({ icons: true }), '5 steps · 1 prompt · 💻 Bash 2 · 📖 Read 1');
});

test('by default the watch takes only the sessions of the current folder and its subfolders', () => {
  assert.equal(inFolder('/home/u/repo', '/home/u/repo'), true);
  assert.equal(inFolder('/home/u/repo/web/storefront', '/home/u/repo'), true);
  assert.equal(inFolder('/home/u/repo-other', '/home/u/repo'), false);
  assert.equal(inFolder('/home/u', '/home/u/repo'), false);
  assert.equal(inFolder('/home/u/repo/', '/home/u/repo'), true);
  // npm runs the script in the package folder; INIT_CWD is the folder where the person ran npm.
  assert.equal(watchFolder({ INIT_CWD: '/home/u/repo/web' }, '/home/u/repo'), '/home/u/repo/web');
  assert.equal(watchFolder({}, '/home/u/repo'), '/home/u/repo');
});

test('the command line: watch by default, list and stage as subcommands, --cwd with its folder', async () => {
  const { parseArgs, HELP, VERSION } = await import('../lib/aidr.mjs');
  assert.deepEqual(parseArgs([]), { sub: 'watch', cwd: null, args: [] });
  assert.deepEqual(parseArgs(['--changes']), { sub: 'watch', cwd: null, args: ['--changes'] });
  assert.deepEqual(parseArgs(['list', '--global']), { sub: 'list', cwd: null, args: ['--global'] });
  assert.deepEqual(parseArgs(['stage', 'a1..b2', '--cwd', '/repo']), { sub: 'stage', cwd: '/repo', args: ['a1..b2'] });
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(HELP, /aidr stage \[commit\|a\.\.b\]/);
});

test('macOS: ps etime and the lsof working folder', async () => {
  const { etimeSeconds, parseMacProcesses, lsofFolder } = await import('../lib/aidr.mjs');
  assert.equal(etimeSeconds('05:07'), 307);
  assert.equal(etimeSeconds('01:02:03'), 3723);
  assert.equal(etimeSeconds('2-01:00:00'), 176400);
  assert.equal(etimeSeconds('x'), 0);
  assert.deepEqual(parseMacProcesses('  412   1   01:02:03 /opt/homebrew/bin/claude claude --resume x\n'), [
    { pid: 412, ppid: 1, seconds: 3723, comm: 'claude', args: 'claude --resume x' },
  ]);
  assert.equal(lsofFolder('p412\nfcwd\nn/Users/me/repo\n'), '/Users/me/repo');
  assert.equal(lsofFolder('p412\n'), null);
});

test('diagrams: drawn in a terminal, Mermaid text in a pipe or a file, --mermaid and --no-mermaid', () => {
  assert.deepEqual(mermaidMode({ argv: [], tty: true }), { text: false, drawings: true });
  assert.deepEqual(mermaidMode({ argv: ['--mermaid'], tty: true }), { text: true, drawings: true });
  assert.deepEqual(mermaidMode({ argv: [], tty: false }), { text: true, drawings: false });
  assert.deepEqual(mermaidMode({ argv: ['--no-mermaid'], tty: false }), { text: false, drawings: false });
  assert.deepEqual(mermaidMode({ argv: ['--mermaid', '--no-mermaid'], tty: true }), { text: false, drawings: true });
});

test('the raw log (aidr:busywork) has every feature: code view, graph, models, change events, progress, stage', () => {
  const busy = optionsOf(['--busywork'], { tty: true });
  for (const key of ['code', 'map', 'ontology', 'events', 'stage', 'progress', 'drawings']) assert.ok(busy[key], key);
  assert.equal(busy.learn, false, 'Learn cards stay off unless asked for (they use the network)');
  assert.ok(optionsOf(['--busywork', '--learn'], { tty: true }).learn);
  assert.ok(optionsOf(['--busywork', '--no-code']).code, 'the raw log keeps the code view');
  const plain = optionsOf([], { tty: true });
  assert.ok(plain.code && !plain.events, 'the default watch: code view, no change events');
  assert.ok(!optionsOf(['--no-code']).code);
});

// Owner, 22 November 2026: "a new flag option which is on by default which is to show the bash commands".
const shell = command => ({
  type: 'assistant',
  timestamp: '2026-11-22T10:00:00.000Z',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command, description: 'Run the tests' } }] },
});

test('the watch shows the command lines of a shell step by default, and --no-commands shows none', () => {
  assert.equal(optionsOf([]).commands, true);
  assert.equal(optionsOf(['--busywork']).commands, true);
  assert.equal(optionsOf(['--no-commands']).commands, false);
  const [step] = stepsOf(shell('cd web && node --test'), { commands: optionsOf([]).commands });
  assert.deepEqual(step.command, ['cd web && node --test']);
  assert.match(renderStep('repo', '', step), / repo  Bash \| Run the tests\n    \$ cd web && node --test$/);
  const [off] = stepsOf(shell('cd web && node --test'), { commands: optionsOf(['--no-commands']).commands });
  assert.equal(off.command, undefined);
  assert.match(renderStep('repo', '', off), / repo  Bash \| Run the tests$/);
  const read = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }] },
  };
  assert.equal(stepsOf(read, { commands: true })[0].command, undefined, 'only a shell step has command lines');
});

test('the command lines mask secrets and stay short: 12 lines, or 120 in the raw log', () => {
  const [step] = stepsOf(
    shell('curl -H "Authorization: Bearer SECRET" x\nCLAUDE_AGENT_KEY=abc123 DB_PASSWORD="p w" run\necho ok'),
    { commands: true },
  );
  const text = step.command.join('\n');
  assert.ok(!/SECRET|abc123|p w/.test(text), text);
  assert.match(text, /CLAUDE_AGENT_KEY=•••• DB_PASSWORD=•••• run/);
  assert.equal(step.command[2], 'echo ok');
  const long = Array.from({ length: 30 }, (_, n) => 'echo ' + n).join('\n');
  const [short] = stepsOf(shell(long), { commands: true });
  assert.equal(short.command.length, 13);
  assert.equal(short.command.at(-1), '… 18 more lines');
  assert.equal(stepsOf(shell(long), { commands: true, full: true })[0].command.length, 30);
  const [evil] = stepsOf(shell('echo \u001b[2Jx'), { commands: true });
  assert.ok(!evil.command[0].includes('\u001b'), 'no terminal control bytes');
});

test('--no-commands is a known option', async () => {
  const errors = [];
  const original = console.error;
  console.error = line => errors.push(line);
  try {
    assert.notEqual(await main(['--no-commands', '--bogus-option']), 0);
  } finally {
    console.error = original;
  }
  assert.ok(
    errors.some(e => /Unknown option: --bogus-option\./.test(e)),
    errors.join('\n'),
  );
});
