// SPDX-License-Identifier: AGPL-3.0-only
// Owner, 22 November 2026: "aidr --help useful one line explaining usage, aidr --explain with an explanation 2
// paragraphs long, aidr --example with an example ... aidr --security --help, --explain, --example".
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, helpLines, topicLines, topicsOf } from '../lib/help.mjs';
import { FLAGS, main } from '../lib/aidr.mjs';

test('every flag of the watch and every command has a topic with a line, two paragraphs and an example', () => {
  for (const flag of FLAGS.filter(f => !['--watch', '--heartbeat'].includes(f)))
    assert.ok(TOPICS[flag.slice(2)], `${flag} has a topic`);
  for (const command of ['list', 'agents', 'stage', 'journal']) assert.ok(TOPICS[command].kind.startsWith('command'));
  for (const [name, t] of Object.entries(TOPICS)) {
    assert.ok(t.line.length > 20 && !t.line.includes('\n'), `${name}: one line`);
    assert.equal(t.explain.length, 2, `${name}: two paragraphs`);
    for (const p of t.explain) assert.ok(p.length > 60, `${name}: a paragraph, not a phrase`);
    assert.ok(
      t.example.length >= 1 && t.example[0].startsWith('$ aidr'),
      `${name}: the example starts with its command`,
    );
  }
});

test('aidr --help gives the usage line, then every command and every flag on one line each', () => {
  const lines = helpLines('1.2.3');
  assert.match(lines[0], /^aidr 1\.2\.3: /);
  assert.match(lines[1], /^Usage: aidr /);
  for (const flag of FLAGS.filter(f => !['--watch', '--heartbeat'].includes(f)))
    assert.ok(
      lines.some(l => l.startsWith('  ' + flag + ' ')),
      flag,
    );
  assert.ok(
    lines.some(l => /^ {2}--agents +prints the agent map in the watch/.test(l)),
    'a flag line, not the command line',
  );
});

test('a topic gives its own line, two paragraphs or its example; several topics give one part each', () => {
  assert.deepEqual(topicLines('help', ['--security', '--help'], 'x'), [
    `aidr --security: ${TOPICS.security.line}`,
    'More: aidr --security --explain, aidr --security --example.',
  ]);
  const explain = topicLines('explain', ['--security', '--explain'], 'x');
  assert.deepEqual(explain, ['--security', '', ...TOPICS.security.explain.flatMap(p => [p, '']).slice(0, -1)]);
  assert.equal(topicLines('example', ['--security', '--example'], 'x')[2], '$ aidr --security');
  assert.equal(topicLines('explain', ['--explain'], 'x')[0], 'aidr');
  assert.match(topicLines('example', ['--example'], 'x')[2], /^\$ aidr/);
  const two = topicLines('help', ['--code', '--map', '--help'], 'x');
  assert.ok(two[0].startsWith('aidr --code:') && two[1].startsWith('aidr --map:'));
  assert.deepEqual(topicsOf(['stage', 'HEAD~3..HEAD', '--example']).topics, ['stage'], 'a commit is not a topic');
  assert.deepEqual(topicsOf(['--heartbeat', '--help']).topics, ['agents']);
  assert.equal(topicLines('help', ['--bogus', '--help'], 'x'), null);
});

test('main prints a topic and stops; an unknown flag with --help is refused', async () => {
  const out = [],
    errors = [];
  const [log, error] = [console.log, console.error];
  console.log = line => out.push(line);
  console.error = line => errors.push(line);
  try {
    assert.equal(await main(['--security', '--example']), 0);
    assert.equal(await main(['--bogus', '--help']), 2);
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.ok(out.includes('$ aidr --security'));
  assert.match(errors.join('\n'), /Unknown option: --bogus\./);
});
