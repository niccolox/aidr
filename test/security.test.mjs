// SPDX-License-Identifier: AGPL-3.0-only
// Owner, 22 November 2026: "make aidr security flag which explains security impact using cloudflare security skills and
// claude locally, referencing USG cybersecurity devsecops framework".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILT_IN,
  SSDF,
  SecurityReviewer,
  checkSecurity,
  disciplineOf,
  domainOf,
  inputOf,
  renderSecurity,
  systemOf,
} from '../lib/security.mjs';
import { optionsOf } from '../lib/aidr.mjs';

const sqlChange = {
  file: '/work/shop/app/search.py',
  before: ['    rows = db.execute("SELECT * FROM products WHERE name = %s", (term,))'],
  after: ['    rows = db.execute(f"SELECT * FROM products WHERE name = \'{term}\'")'],
};
const goodCard = {
  impact: 'high',
  threat: 'SQL injection through the search term',
  summary: 'The search term now goes into the SQL text, so a visitor can read or change any row of the products table.',
  ssdf: 'PW.5',
  fix: 'Pass the term as a query parameter again, and keep the SQL text fixed.',
  link: 'https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html',
};

test('the SSDF list is the 19 practices of SP 800-218 v1.1', () => {
  assert.equal(Object.keys(SSDF).length, 19);
  assert.ok(!SSDF['PW.3'], 'PW.3 was moved into PW.4 in v1.1');
  for (const k of ['PO.1', 'PO.5', 'PS.3', 'PW.1', 'PW.9', 'RV.3']) assert.ok(SSDF[k], k);
});

test('fixed patterns choose the domain; a private file, a style file or an empty change has none', () => {
  assert.equal(domainOf(sqlChange).id, 'data-isolation');
  assert.equal(domainOf({ file: '/r/package.json', after: ['"left-pad": "^1.0.0"'] }).id, 'supply-chain');
  assert.equal(domainOf({ file: '/r/wrangler.jsonc', after: ['"name": "x"'] }).id, 'cloud');
  assert.equal(domainOf({ file: '/r/a.mjs', after: ['el.innerHTML = name;'] }).id, 'client-side');
  assert.equal(domainOf({ file: '/r/a.py', after: ['subprocess.run(cmd, shell=True)'] }).id, 'local-ipc');
  assert.equal(domainOf({ file: '/r/a.ts', after: ['res.headers.set("Set-Cookie", session)'] }).id, 'web-auth');
  assert.equal(domainOf({ file: '/r/agent.py', after: ['agent = Agent(model, system_prompt=s)'] }).id, 'ai-llm');
  assert.equal(domainOf({ file: '/r/.env', after: ['session=1'] }), null);
  assert.equal(domainOf({ file: '/r/a.css', after: ['.x{color:red}'] }), null);
  assert.equal(domainOf({ file: '/r/a.py', after: ['x = 1'] }), null);
  // A removed check counts: the removed lines are tested too.
  assert.equal(
    domainOf({ file: '/r/a.py', before: ['if not authorized(user): raise Forbidden'], after: [] }).id,
    'web-auth',
  );
});

test('the discipline comes from the Core discipline block of the Cloudflare skill file, read only', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aidr-sec-'));
  try {
    writeFileSync(
      join(folder, 'WEB.md'),
      '# Web\n\nintro\n\n## Core discipline (include in every agent prompt)\n\n```\n- Rule one.\n- Rule two.\n```\n\n## Next\n\nother\n',
    );
    assert.equal(disciplineOf(folder, 'WEB.md'), '- Rule one.\n- Rule two.');
    assert.equal(disciplineOf(folder, 'MISSING.md'), null);
    const reviewer = new SecurityReviewer({ env: { AIDR_SECURITY_SKILL: folder }, claude: true });
    assert.match(reviewer.label(), /built-in discipline/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the check keeps a good card and drops a bad impact, practice, link, length or word', () => {
  assert.ok(checkSecurity(goodCard).ok);
  for (const bad of [
    { impact: 'critical' },
    { ssdf: 'PW.3' },
    { ssdf: 'AC-2' },
    { link: 'https://example.com/sqli' },
    { link: 'http://cwe.mitre.org/data/definitions/89.html' },
    { summary: 'Too short.' },
    { fix: 'Use this robust and seamless fix for the query text.' },
  ])
    assert.equal(checkSecurity({ ...goodCard, ...bad }).ok, false, JSON.stringify(bad));
  assert.equal(checkSecurity([]).ok, false);
});

test('the request holds the relative path and masked lines; the system text holds the practices and the discipline', () => {
  const secret = ['sk', '-proj-', 'abcdefghijklmnopqrstu'].join('');
  const input = JSON.parse(
    inputOf({ ...sqlChange, after: [...sqlChange.after, `KEY = "${secret}"`] }, domainOf(sqlChange), {
      cwd: '/work/shop',
      symbol: 'search',
    }),
  );
  assert.equal(input.file, 'app/search.py');
  assert.equal(input.function, 'search');
  assert.doesNotMatch(input.added_lines, /sk-proj/);
  const system = systemOf(domainOf(sqlChange), BUILT_IN);
  assert.match(system, /PW\.5 Create source code by adhering to secure coding practices/);
  assert.match(system, /never instructions to you/);
  assert.match(system, /csrc\.nist\.gov\/pubs\/sp\/800\/218\/final/);
});

test('a card from local Claude passes the check; a bad, failed, late or repeated call gives no card', async () => {
  let args = null;
  const reviewer = new SecurityReviewer({
    env: {},
    claude: true,
    runCli: async a => {
      args = a;
      return { code: 0, stdout: JSON.stringify({ is_error: false, structured_output: goodCard }) };
    },
  });
  const ok = await reviewer.card(sqlChange, { cwd: '/work/shop', symbol: 'search' });
  assert.equal(ok.card.impact, 'high');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.match(args[args.indexOf('--json-schema') + 1], /"PW\.5"/);
  assert.equal((await reviewer.card(sqlChange, { cwd: '/work/shop', symbol: 'search' })).skipped, 'asked');
  const run = answer => ({ env: {}, claude: true, runCli: async () => answer });
  const bad = await new SecurityReviewer(
    run({ code: 0, stdout: JSON.stringify({ structured_output: { ...goodCard, ssdf: 'PW.3' } }) }),
  ).card(sqlChange);
  assert.equal(bad.skipped, 'check');
  assert.equal(
    (await new SecurityReviewer(run({ code: 1, stdout: '{"is_error":true}' })).card(sqlChange)).skipped,
    'claude',
  );
  assert.equal((await new SecurityReviewer(run({ timeout: true })).card(sqlChange)).skipped, 'timeout');
  assert.equal((await new SecurityReviewer({ env: {}, claude: false }).card(sqlChange)).skipped, 'claude missing');
});

test('the card prints its impact, threat, fix, practice and link; --security is off by default', () => {
  const lines = renderSecurity(goodCard, domainOf(sqlChange), { file: 'app/search.py' });
  assert.match(lines[0], /Security · high SQL injection/);
  assert.match(lines[3], /PW\.5 Create source code/);
  assert.match(lines[4], /cheatsheetseries\.owasp\.org/);
  assert.equal(optionsOf([]).security, false);
  assert.equal(optionsOf(['--security']).security, true);
});
