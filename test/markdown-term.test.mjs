// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { inline, markdownLines, wrap } from '../lib/markdown-term.mjs';
import { renderStep, PLAIN } from '../lib/aidr.mjs';

const tag = (k, t) => `<${k}>${t}</${k}>`;

test('inline Markdown: bold, code, links and italics get their roles', () => {
  assert.equal(
    inline('**The plan:** run `npm test` now', tag),
    '<bold>The plan:</bold> run <string>npm test</string> now',
  );
  assert.equal(inline('see [the spec](docs/x.md)', tag), 'see the spec <gray>(docs/x.md)</gray>');
  assert.equal(inline('a *small* note', tag), 'a <dim>small</dim> note');
  assert.equal(inline('2 * 3 * 4'), '2 * 3 * 4');
});

test('headings, lists, tables and code blocks become terminal lines', () => {
  const lines = markdownLines([
    '## Inspection',
    '',
    'Local:',
    '- **No visual change:** only the register.',
    '  - nested item',
    '1. First step',
    '',
    '| Part | Count |',
    '| --- | --- |',
    '| Logo | 52 |',
    '| Screenshot | 65 |',
    '',
    '```python',
    'def run(): return 1',
    '```',
  ]);
  assert.deepEqual(lines, [
    '▍ Inspection',
    '',
    'Local:',
    '• No visual change: only the register.',
    '  • nested item',
    '1. First step',
    '',
    'Part       │ Count',
    '───────────┼──────',
    'Logo       │ 52   ',
    'Screenshot │ 65   ',
    '',
    '  def run(): return 1',
  ]);
});

test('long lines wrap under their own indent, counting only visible characters', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two three four']);
  const lines = markdownLines(['- ' + 'word '.repeat(20).trim()], { width: 30 });
  assert.ok(lines.length > 1 && lines[0].startsWith('• ') && lines[1].startsWith('  '));
  assert.ok(lines.every(l => l.length <= 30));
});

test('a raw-log step draws its body under the step line', () => {
  const out = renderStep(
    'repo',
    'B',
    { time: '2026-11-21T14:45:44Z', kind: 'says', name: 'SAYS', text: '', body: ['**Done.**', '- one'] },
    PLAIN,
  );
  assert.deepEqual(out.split('\n').slice(1), ['    Done.', '    • one']);
});
