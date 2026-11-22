// SPDX-License-Identifier: AGPL-3.0-only
// The fixtures of the security audit of the watch (WTF-PKG-1 section 4, findings F1 to F8). Each fake secret is built
// from parts, so no full secret pattern sits in this file (finding F11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GIT_SAFE,
  GitChanges,
  isPrivatePath,
  mask,
  renderChange,
  safe,
  stripControls,
  userPrivateRules,
} from '../lib/code-tutor.mjs';
import { readEntries, stepsOf, whyOf } from '../lib/aidr.mjs';
import { ChangeFeed } from '../lib/change-feed.mjs';

const ESC = '\u001b',
  BEL = '\u0007';
const part = (...p) => p.join('');
// oxlint-disable-next-line no-control-regex -- the check looks for control bytes on purpose.
const noEscape = lines => [].concat(lines).every(l => !/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(l));

test('F1: terminal control bytes from a file, a prompt or Claude never reach the terminal', () => {
  const evil = `ok ${ESC}]52;c;ZXZpbA==${BEL} ${ESC}]0;owned${BEL} ${ESC}[2J${ESC}[H ${ESC}]8;;https://x.example${ESC}\\link${ESC}]8;;${ESC}\\ \u009b31m end\r`;
  assert.equal(stripControls(evil), 'ok    link  end');
  assert.equal(stripControls('a\tb'), 'a\tb');
  assert.equal(safe(`${ESC}]0;t${BEL}token: abcdefgh1`), 'token: ••••');
  assert.ok(
    noEscape(renderChange({ file: '/r/a.txt', kind: 'write', before: [], after: [evil] }, { cwd: '/r', why: evil })),
  );
  assert.ok(noEscape(stepsOf({ type: 'user', message: { content: 'hi ' + evil } })[0].text));
  assert.ok(noEscape(whyOf({ type: 'assistant', message: { content: [{ type: 'text', text: evil }] } })));
  const feed = new ChangeFeed();
  assert.ok(
    noEscape(
      feed.events({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'p', name: 'ExitPlanMode', input: { plan: '- ' + evil } }] },
      })[0].lines,
    ),
  );
  // A file name can hold escape bytes too.
  assert.ok(
    noEscape(renderChange({ file: `/r/${ESC}]0;x${BEL}.mjs`, kind: 'write', before: [], after: ['x'] }, { cwd: '/r' })),
  );
});

test('F2: prompts, the Why line, plans, tasks and commit messages are masked', () => {
  const gh = part('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz123456');
  assert.doesNotMatch(stepsOf({ type: 'user', message: { content: `my token is ${gh} please` } })[0].text, /ghp_/);
  assert.doesNotMatch(
    whyOf({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I set pass' + 'word=hunter2secret here.' }] },
    }),
    /hunter2/,
  );
  const feed = new ChangeFeed();
  const key = part('sk', '-proj-', 'abcdefghijklmnopqrstu');
  assert.doesNotMatch(
    feed
      .events({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'p', name: 'ExitPlanMode', input: { plan: '- export OPENAI_API_KEY=' + key } },
          ],
        },
      })[0]
      .lines.join(' '),
    /sk-proj/,
  );
  assert.doesNotMatch(
    feed.events({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't', name: 'TaskCreate', input: { subject: 'Rotate ' + gh } }] },
    })[0].text,
    /ghp_/,
  );
  feed.events({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'git commit -m x' } }] },
  });
  const [commit] = feed.events({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: `[master abc1234] add ${gh}` }] },
  });
  assert.doesNotMatch(commit.text, /ghp_/);
  assert.match(commit.text, /^abc1234 add ••••$/);
  assert.doesNotMatch(
    stepsOf({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: 'Use ' + gh } }] },
    })[0].text,
    /ghp_/,
  );
});

test('F3: the common secret forms are masked, and plain code is not', () => {
  const values = [
    'DATABASE_URL=postgres://app:' + 'Sup3rS3cretPw@db.example.com/x',
    'k: "' + part('sk', '_test_', '51Habcdefghijklmnop') + '"',
    part('rk', '_test_', '51Habcdefghijklmn'),
    part('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'),
    part('np', 'm_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
    'aws_secret_access_key ' + part('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY'),
    'https://hooks.' + 'slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX',
    '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
    part('xo', 'xe-', '1-abcdefghijklmnop'), // gitleaks:allow (a fake value of the mask test)
    part('gl', 'pat-', 'abcdefghijklmnopqrstu'),
    part('do', 'p_v1_', 'a'.repeat(64)),
  ];
  const secrets = [
    'Sup3rS3cretPw',
    '51Habcdefghijklmnop',
    '51Habcdefghijklmn',
    'SyA1234567890',
    'abcdefghijklmnopqrstuvwxyz0123456789',
    'bPxRfiCYEXAMPLEKEY',
    'XXXXXXXXXXXXXXXXXXXXXXXX',
    'PRIVATE KEY',
    '1-abcdefghijklmnop',
    'abcdefghijklmnopqrstu',
    'a'.repeat(64),
  ]; // gitleaks:allow (the fake values of this test)
  values.forEach((v, k) => {
    const out = mask(v);
    assert.ok(out.includes('••••'), v);
    assert.ok(!out.includes(secrets[k]), out);
  });
  assert.equal(mask('postgres://db.example.com/x'), 'postgres://db.example.com/x');
  for (const plain of [
    'const LIMIT=50;',
    'The secret values stay in the vault.',
    'https://republic.dev/stores?page=2',
    'def token_count(text): return len(text)',
  ])
    assert.equal(mask(plain), plain);
});

test('F4: credential files are private, and source files are not', () => {
  for (const p of [
    '/home/u/.ssh/config',
    '/home/u/.ssh/id_ecdsa',
    '/home/u/.ssh/id_ed25519.pub',
    '/home/u/.aws/config',
    '/home/u/.pgpass',
    '/home/u/.docker/config.json',
    '/home/u/.kube/config',
    '/r/prod.tfvars',
    '/r/terraform.tfstate',
    '/r/.envrc',
    '/r/cert.p12',
    '/r/a.pfx',
    '/r/k.jks',
    '/home/u/.config/gh/hosts.yml',
    '/home/u/.claude/settings.json',
    '/home/u/.claude/.credentials.json',
    '/home/u/.claude.json',
    '/r/service-account-prod.json',
    '/r/.wrangler/state/x',
    '/r/.vercel/project.json',
    '/r/.git-credentials',
    '/r/.env',
    '/r/.env.local',
    '/r/.prod.env',
    '/r/.local/deploy/runtime.uri',
    '/r/vpn.ovpn',
    '/home/u/.gnupg/pubring.kbx',
  ])
    assert.equal(isPrivatePath(p, []), true, p);
  for (const p of [
    '/r/lib/aidr.mjs',
    '/r/saasx2x/web/customer_identity.py',
    '/r/web/id_card.mjs',
    '/r/monkey.js',
    '/r/docs/keys.md',
    '/r/.claude/skills/x/SKILL.md',
    '/r/env.mjs',
  ])
    assert.equal(isPrivatePath(p, []), false, p);
  // The person's own list: one glob on each line.
  const rules = userPrivateRules('# my files\nclients/**\n*.secret.yml\n');
  assert.equal(isPrivatePath('/r/clients/acme/notes.md', rules), true);
  assert.equal(isPrivatePath('/r/config/db.secret.yml', rules), true);
  assert.equal(isPrivatePath('/r/config/db.yml', rules), false);
});

test('F5: a file outside the session folder shows its path and counts only, unless --outside', () => {
  const change = { file: '/home/u/.bashrc', kind: 'edit', before: ['alias a=b'], after: ['alias a=c'] };
  const hidden = renderChange(change, { cwd: '/r' });
  assert.equal(hidden.length, 1);
  assert.match(hidden[0], /outside the session folder/);
  assert.doesNotMatch(hidden.join('\n'), /alias/);
  assert.match(renderChange(change, { cwd: '/r', outside: true }).join('\n'), /alias a=c/);
  assert.match(renderChange({ ...change, file: '/r/src/a.sh' }, { cwd: '/r' }).join('\n'), /alias a=c/);
});

test('F6 and F7: git runs no command of the folder, and private or binary untracked files are never read', () => {
  assert.deepEqual(GIT_SAFE.slice(0, 2), ['-c', 'core.fsmonitor=false']);
  const dir = mkdtempSync(join(tmpdir(), 'wtf-safety-'));
  try {
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'one');
    // A folder whose own configuration runs a command on each git diff: the watch must not run it.
    const marker = join(dir, 'fsmonitor-ran');
    writeFileSync(join(dir, 'hook.sh'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    git('config', 'core.fsmonitor', join(dir, 'hook.sh'));
    const watch = new GitChanges(dir);
    watch.poll();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(dir, '.env.local'), 'TOKEN=abcdefgh\n');
    writeFileSync(join(dir, 'blob.dat'), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(dir, 'new.mjs'), 'export const x=1;\n');
    const found = watch
      .poll()
      .map(c => c.file)
      .sort();
    assert.deepEqual(
      found.filter(f => f !== 'hook.sh'),
      ['a.txt', 'new.mjs'],
    );
    assert.equal(existsSync(marker), false, 'the folder fsmonitor command ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F8: a transcript that grew past the limit is read from its end, and the left-out bytes are counted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-read-'));
  try {
    const file = join(dir, 't.jsonl'),
      line = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(80) } }) + '\n';
    writeFileSync(file, line.repeat(50));
    const all = readEntries(file, 0, '', 1_000_000);
    assert.equal(all.entries.length, 50);
    assert.equal(all.skipped, 0);
    const part = readEntries(file, 0, '', line.length * 5 + 10);
    assert.ok(part.entries.length <= 5 && part.entries.length >= 4);
    assert.ok(part.skipped > 0);
    assert.equal(part.end, line.length * 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the raw log (aidr:busywork) keeps the whole text as filtered lines', () => {
  const text = 'First line.\n\nSecond line with pass' + 'word=hunter2secret.\nThird \u001b]0;x\u0007end.';
  const [full] = stepsOf({ type: 'assistant', message: { content: [{ type: 'text', text }] } }, { full: true });
  assert.equal(full.text, '');
  assert.deepEqual(full.body, ['First line.', '', 'Second line with password=••••', 'Third end.']);
  const [short] = stepsOf({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  assert.equal(short.text, 'First line.');
  assert.equal(short.body, undefined);
  const [prompt] = stepsOf({ type: 'user', message: { content: 'one\ntwo' } }, { full: true });
  assert.deepEqual(prompt.body, ['one', 'two']);
  const [long] = stepsOf({ type: 'user', message: { content: 'word '.repeat(2000) } }, { full: true });
  assert.deepEqual(long.body, ['…']);
});

test('no module opens a network connection or writes a file, except learn.mjs, which only calls Workers AI or the local claude CLI', () => {
  const here = import.meta.dirname,
    dir = existsSync(join(here, 'code-tutor.mjs')) ? here : join(here, '..', 'lib');
  const sources = readdirSync(dir).filter(f => /\.(mjs|py)$/.test(f) && !f.endsWith('.test.mjs') && f !== 'pack.mjs');
  assert.ok(sources.length >= 9, 'the modules are found');
  const net =
    /node:(?:net|http|https|http2|dgram|tls|dns)\b|\bfetch\(|\bWebSocket\b|\bimport (?:socket|urllib|http|requests)\b/;
  const write = /\b(?:writeFile|appendFile|createWriteStream|mkdir|rmSync|unlink|rename)\w*\(|open\([^)]*['"][wax]/;
  for (const f of sources) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(text, write, f + ' writes a file');
    if (f !== 'learn.mjs') assert.doesNotMatch(text, net, f + ' uses the network');
  }
  // --learn (spec 9.9) is the one exception: one fetch, to the Workers AI API, and only when the person asks for it.
  const learn = readFileSync(join(dir, 'learn.mjs'), 'utf8');
  assert.equal((learn.match(/\bthis\.fetch\(/g) || []).length, 1);
  assert.deepEqual(
    [...new Set(learn.match(/https?:\/\/[a-z0-9.-]+/gi))].filter(
      h =>
        !/docs\.|nodejs\.org|developer\.mozilla|hono\.dev|postgresql|cheatsheetseries|playwright\.dev|git-scm/.test(h),
    ),
    ['https://api.cloudflare.com'],
  );
  // The local Claude path: one spawn, of the claude command, and no other process.
  assert.deepEqual(learn.match(/\bspawn\([^,]+/g), ["spawn('claude'"]);
  const aidr = readFileSync(join(dir, 'aidr.mjs'), 'utf8');
  assert.match(aidr, /options\.learn \? new Learner/, 'the watch makes a learner only with --learn');
});
