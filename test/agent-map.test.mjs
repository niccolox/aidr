// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentsOf, endNotices, renderAgentMap, stateOf, toolCalls } from '../lib/agent-map.mjs';
import { optionsOf } from '../lib/aidr.mjs';

// Owner, 22 November 2026: "can aidr do an agent map heart beat every 10 minutes? I want to see if agents are running
// and their heart beat".
const NOW = Date.parse('2026-11-22T06:00:00.000Z');
const at = minutesAgo => new Date(NOW - minutesAgo * 60_000).toISOString();
const line = (minutesAgo, content) =>
  JSON.stringify({ type: 'assistant', timestamp: at(minutesAgo), message: { content } });
const tool = (name, description) => [{ type: 'tool_use', name, input: { description } }];

function session() {
  const root = mkdtempSync(join(tmpdir(), 'aidr-agents-')),
    file = join(root, 'parent.jsonl'),
    dir = join(root, 'parent', 'subagents');
  mkdirSync(dir, { recursive: true });
  const notice =
    '<task-notification>\n<task-id>aaa111</task-id>\n<tool-use-id>t</tool-use-id>\n<status>completed</status>\n</task-notification>';
  writeFileSync(file, JSON.stringify({ type: 'user', timestamp: at(1), message: { content: notice } }) + '\n');
  const agent = (id, description, lines) => {
    writeFileSync(join(dir, `agent-${id}.jsonl`), lines.join('\n') + '\n');
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ description }));
  };
  agent('aaa111', 'Finished work', [line(30, tool('Bash', 'Run the tests')), line(20, tool('Edit', 'x'))]);
  agent('bbb222', 'Busy work', [line(25, tool('Bash', 'Build')), line(1, tool('Read', 'Read the spec'))]);
  agent('ccc333', 'Quiet work', [line(5, tool('Bash', 'Wait'))]);
  agent('ddd444', 'Stalled \u001b[2Jwork', [line(40, tool('Bash', 'Hang'))]);
  return file;
}

test('the map gives each subagent its state from its end notice and its heartbeat', () => {
  const agents = agentsOf(session(), { now: NOW });
  const by = Object.fromEntries(agents.map(a => [a.id, a]));
  assert.equal(by.aaa111.state, 'finished');
  assert.equal(by.bbb222.state, 'running');
  assert.equal(by.bbb222.idle, 60);
  assert.equal(by.bbb222.tools, 2);
  assert.equal(by.bbb222.step, 'Read | Read the spec');
  assert.equal(by.ccc333.state, 'quiet');
  assert.equal(by.ddd444.state, 'stalled');
  assert.ok(!by.ddd444.description.includes('\u001b'), 'no terminal control bytes');
});

test('the states: running up to 3 minutes, quiet up to 10, then stalled; an end notice wins', () => {
  assert.equal(stateOf(null, 180), 'running');
  assert.equal(stateOf(null, 181), 'quiet');
  assert.equal(stateOf(null, 600), 'quiet');
  assert.equal(stateOf(null, 601), 'stalled');
  assert.equal(stateOf('completed', 5), 'finished');
  assert.equal(stateOf('killed', 5), 'failed');
  assert.deepEqual([...endNotices('<task-id>abc</task-id> x <status>failed</status>')], [['abc', 'failed']]);
});

test('the map lines: a heading with the counts, the session, and one line for each agent', () => {
  const file = session();
  const rows = [
    { folder: 'repo', title: 'Work', sessionId: 'parent-id', idle: 30, agents: agentsOf(file, { now: NOW }) },
  ];
  const lines = renderAgentMap(rows, { clock: '06:00' });
  assert.match(lines[0], /^06:00  Agent map: 1 session, 1 running, 1 quiet, 1 stalled, 1 finished \(every 10 min\)$/);
  assert.match(lines[1], /repo {2}"Work" {2}parent-i {2}last line 30 s ago/);
  assert.ok(lines.some(l => /running +Busy work .*heartbeat 1 min ago/.test(l)));
  assert.ok(lines.some(l => /last step: Read \| Read the spec/.test(l)));
  assert.ok(!lines.some(l => /last step: Edit/.test(l)), 'a finished agent shows no last step');
  assert.match(renderAgentMap([{ folder: 'repo', sessionId: 's', idle: 1, agents: [] }])[0], /no agents/);
});

test('the tool call count reads the whole transcript, also a mark across two 1 MB chunks', () => {
  const root = mkdtempSync(join(tmpdir(), 'aidr-count-')),
    file = join(root, 'agent-x.jsonl'),
    mark = '"type":"tool_use"';
  writeFileSync(file, 'x'.repeat(1_048_576 - 5) + mark + '\n' + mark + '\n');
  assert.equal(toolCalls(file), 2);
});

test('the heartbeat is on by default, and --no-heartbeat turns it off', () => {
  assert.equal(optionsOf([]).heartbeat, true);
  assert.equal(optionsOf(['--no-heartbeat']).heartbeat, false);
});

test("an agent that another agent started is finished by the end notice in that agent's transcript", () => {
  const root = mkdtempSync(join(tmpdir(), 'aidr-nested-')),
    file = join(root, 'parent.jsonl'),
    dir = join(root, 'parent', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ type: 'user', timestamp: at(1), message: { content: 'go' } }) + '\n');
  const notice = '<task-notification>\n<task-id>child1</task-id>\n<status>completed</status>\n</task-notification>';
  writeFileSync(
    join(dir, 'agent-lead1.jsonl'),
    [
      line(30, tool('Agent', 'Start a child')),
      JSON.stringify({ type: 'user', timestamp: at(25), message: { content: notice } }),
    ].join('\n') + '\n',
  );
  writeFileSync(join(dir, 'agent-child1.jsonl'), line(40, tool('Read', 'Read a file')) + '\n');
  const by = Object.fromEntries(agentsOf(file, { now: NOW }).map(a => [a.id, a.state]));
  assert.equal(by.child1, 'finished');
  assert.equal(by.lead1, 'stalled');
});

test('a foreground agent is finished when a transcript holds the result of the Agent call that started it', () => {
  const root = mkdtempSync(join(tmpdir(), 'aidr-fg-')),
    file = join(root, 'parent.jsonl'),
    dir = join(root, 'parent', 'subagents');
  mkdirSync(dir, { recursive: true });
  const result = {
    type: 'user',
    timestamp: at(20),
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ABC123', content: 'done' }] },
  };
  writeFileSync(file, JSON.stringify(result) + '\n');
  writeFileSync(join(dir, 'agent-fg1.jsonl'), line(40, tool('Read', 'Read a file')) + '\n');
  writeFileSync(
    join(dir, 'agent-fg1.meta.json'),
    JSON.stringify({ description: 'Foreground work', toolUseId: 'toolu_ABC123' }),
  );
  writeFileSync(join(dir, 'agent-fg2.jsonl'), line(40, tool('Read', 'Read a file')) + '\n');
  writeFileSync(
    join(dir, 'agent-fg2.meta.json'),
    JSON.stringify({ description: 'Still out', toolUseId: 'toolu_NOPE' }),
  );
  writeFileSync(join(dir, 'agent-bg1.jsonl'), line(1, tool('Read', 'Read a file')) + '\n');
  writeFileSync(
    join(dir, 'agent-bg1.meta.json'),
    JSON.stringify({ description: 'Background', toolUseId: 'toolu_ABC123', requestShape: 'background' }),
  );
  const by = Object.fromEntries(agentsOf(file, { now: NOW }).map(a => [a.id, a.state]));
  assert.equal(by.fg1, 'finished');
  assert.equal(by.fg2, 'stalled');
  assert.equal(by.bg1, 'running', 'a launched background agent is not finished by its launch result');
});

// Owner, 22 November 2026: "completre stalled R1 Prefect directory-agent flow ... last step: SubagentHandback". A
// background agent that hands its report back gets no end notice, and its last line is old.
test('a background agent is finished by its delivered hand-back or by finished in its meta file', () => {
  const root = mkdtempSync(join(tmpdir(), 'aidr-hb-')),
    file = join(root, 'parent.jsonl'),
    dir = join(root, 'parent', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, '');
  const delivered = {
    type: 'user',
    timestamp: at(700),
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_H', content: 'Report delivered to your caller.' }],
    },
  };
  const shape = { requestShape: 'background', toolUseId: 'toolu_L' };
  writeFileSync(
    join(dir, 'agent-hb1.jsonl'),
    [line(701, tool('SubagentHandback', 'poteto mode')), JSON.stringify(delivered)].join('\n') + '\n',
  );
  writeFileSync(join(dir, 'agent-hb1.meta.json'), JSON.stringify({ description: 'Handed back', ...shape }));
  writeFileSync(join(dir, 'agent-hb2.jsonl'), line(700, tool('SubagentHandback', 'poteto mode')) + '\n');
  writeFileSync(join(dir, 'agent-hb2.meta.json'), JSON.stringify({ description: 'Hand-back not delivered', ...shape }));
  writeFileSync(join(dir, 'agent-hb3.jsonl'), line(700, tool('Read', 'Read a file')) + '\n');
  writeFileSync(
    join(dir, 'agent-hb3.meta.json'),
    JSON.stringify({ description: 'Meta says finished', finished: true, ...shape }),
  );
  writeFileSync(
    join(dir, 'agent-hb4.jsonl'),
    [
      line(702, tool('SubagentHandback', 'first report')),
      JSON.stringify(delivered),
      line(1, tool('Edit', 'resumed')),
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(dir, 'agent-hb4.meta.json'),
    JSON.stringify({ description: 'Resumed after a hand-back', ...shape }),
  );
  const by = Object.fromEntries(agentsOf(file, { now: NOW }).map(a => [a.id, a.state]));
  assert.equal(by.hb1, 'finished');
  assert.equal(by.hb2, 'stalled', 'a hand-back with no delivered result is not an end');
  assert.equal(by.hb3, 'finished');
  assert.equal(by.hb4, 'running', 'work after a hand-back starts the agent again');
});
