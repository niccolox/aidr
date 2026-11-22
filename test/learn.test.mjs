// SPDX-License-Identifier: AGPL-3.0-only
// aidr --learn (learn.mjs, WTF-PKG-1 section 9.9, phase L1): the tests use a fake model and never open a connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED,
  Learner,
  MODEL,
  TOPICS,
  allowedLink,
  answerOf,
  checkCard,
  renderCard,
  requestOf,
  topicOf,
} from '../lib/learn.mjs';

const part = (...p) => p.join('');
const ENV = { AIDR_CF_ACCOUNT_ID: 'a'.repeat(32), AIDR_CF_API_TOKEN: part('tok', 'en-for-the-', 'test-only') };
const GOOD = {
  mnemonic: 'EDGE · Expect bad input, Define limits, Give clear errors, End early',
  advice: 'A Pydantic Field states the limit of each value, so bad input fails at the edge with a clear message.',
  docs: 'https://docs.pydantic.dev/latest/concepts/fields/',
  tutorial: 'https://docs.pydantic.dev/latest/#example',
};
const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
/** A fake model: records each request and answers with the card. */
const fakeModel = (card = GOOD, shape = 'response') => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = 'Here is the card:\n```json\n' + JSON.stringify(card) + '\n```';
    return reply(
      shape === 'choices' ? { result: { choices: [{ message: { content: text } }] } } : { result: { response: text } },
    );
  };
  return { calls, fetchImpl };
};
const change = (file, ...after) => ({ file: '/work/shop/' + file, before: [], after });

// One change for each kind of change of spec 9.9 ("Matching").
const KINDS = {
  'pydantic-model': change('app/models.py', 'class Item(BaseModel):', '    price: Decimal = Field(gt=0)'),
  'fastapi-route': change('app/api.py', '@router.post("/items")', 'def add(item: Item):'),
  'sql-parameters': change('app/db.py', '    cur.execute("SELECT * FROM item WHERE id = %s", (item_id,))'),
  'broad-except': change('app/run.py', 'try:', '    run()', 'except Exception:', '    pass'),
  subprocess: change('tools/run.mjs', "const out = execFileSync('git', ['status']);"),
  'html-escape': change('web/page.mjs', 'return html`<p>${name}</p>`;'),
  'promise-all': change('web/load.mjs', 'const [a, b] = await Promise.all([one(), two()]);'),
  fetch: change('web/client.mjs', "const r = fetch('/api/items');"),
  async: change('app/jobs.py', 'async def refresh():', '    await sync()'),
  regex: change('app/text.py', "WORD = re.compile(r'\\w+')"),
  'test-assert': change('tests/test_cart.py', 'def test_total():', '    assert total([]) == 0'),
  guard: change('app/cart.py', '    if not items:', '        return 0'),
  'new-import': change('app/cart.py', 'from decimal import Decimal'),
  'new-function': change('app/cart.py', 'def total(items):', '    return sum(items)'),
};

test('each kind of change of the spec has its topic, and a card from the fake model', async () => {
  assert.deepEqual(Object.keys(KINDS).sort(), TOPICS.map(t => t.id).sort());
  for (const [id, c] of Object.entries(KINDS)) {
    assert.equal(topicOf(c)?.id, id, id);
    const model = fakeModel();
    const result = await new Learner({ env: ENV, fetchImpl: model.fetchImpl }).card(c, { symbol: 'total' });
    assert.ok(result.card, id + ' gives a card');
    assert.equal(model.calls.length, 1);
    assert.ok(model.calls[0].url.endsWith('/ai/run/' + MODEL));
  }
  assert.equal(topicOf(change('README.md', 'def total(): pass')), null, 'only code files');
  assert.equal(topicOf(change('app/cart.py', '    x = 1')), null, 'no topic, no call');
});

test('links: only https on the allowlist, exact host, path prefix where the site has one', () => {
  for (const ok of [
    'https://docs.python.org/3/library/re.html',
    'https://www.postgresql.org/docs/current/sql-prepare.html',
    'https://git-scm.com/doc',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all',
  ])
    assert.ok(allowedLink(ok), ok);
  for (const bad of [
    'http://docs.python.org/3/',
    'https://docs.python.org.example.com/',
    'https://evil.example/docs.python.org',
    'https://docs.python.org@evil.example/',
    'https://user:pw@docs.python.org/',
    'https://docs.python.org:8443/',
    'https://www.postgresql.org/about/',
    'https://www.postgresql.org/docsx/',
    'https://git-scm.com/book',
    'javascript:alert(1)',
    'not a link',
  ])
    assert.ok(!allowedLink(bad), bad);
  assert.equal(ALLOWED.length, 11);
});

test('the card check drops a bad answer: link, length, memory aid letters, fantasy words, not an object', () => {
  assert.ok(checkCard(GOOD).ok);
  assert.ok(checkCard({ ...GOOD, mnemonic: 'Check the input at the edge.' }).ok, 'a short rule');
  for (const [why, bad] of [
    ['link', { ...GOOD, docs: 'https://example.com/fields' }],
    ['tutorial link', { ...GOOD, tutorial: 'http://docs.pydantic.dev/' }],
    ['advice too short', { ...GOOD, advice: 'Use it.' }],
    ['advice too long', { ...GOOD, advice: 'word '.repeat(60) }],
    [
      'letters do not start the steps',
      { ...GOOD, mnemonic: 'FIELD · Fail early, Inform the user, Each value Limited, Defaults stated' },
    ],
    ['fantasy word', { ...GOOD, advice: 'This magic trick makes your models validate every value at the edge.' }],
    ['marketing word', { ...GOOD, mnemonic: 'Unlock powerful validation.' }],
    ['missing field', { mnemonic: GOOD.mnemonic, advice: GOOD.advice }],
  ])
    assert.ok(!checkCard(bad).ok, why);
  assert.ok(!checkCard(null).ok && !checkCard([GOOD]).ok && !checkCard('text').ok);
  const ESC = '\u001b';
  const clean = checkCard({
    ...GOOD,
    advice: `${ESC}]52;c;ZXZpbA==\u0007A Field states the limit of each value at the edge.`,
  });
  assert.ok(clean.ok && !clean.card.advice.includes(ESC), 'control bytes removed');
});

test('the request: names only by default, the changed lines only with --learn-code and masked, never a path', async () => {
  const secret = part('sk-ant-api03-', 'A'.repeat(40));
  const c = change('app/models.py', 'class Item(BaseModel):', `    key: str = "${secret}"`);
  const plain = requestOf(c, topicOf(c), { symbol: 'Item', models: ['Item', 'Cart'] });
  const facts = JSON.parse(plain.messages[1].content);
  assert.deepEqual(Object.keys(facts).sort(), ['function', 'kind', 'language', 'pydantic_models', 'sites', 'topic']);
  assert.ok(!JSON.stringify(plain).includes('/work/shop'), 'no file path');
  assert.ok(!JSON.stringify(plain).includes('BaseModel):'), 'no code line');
  const withCode = JSON.stringify(requestOf(c, topicOf(c), { symbol: 'Item', code: true }));
  assert.ok(withCode.includes('class Item(BaseModel)'), 'the lines with --learn-code');
  assert.ok(!withCode.includes(secret), 'the secret is masked');
  // The token goes in the header only.
  const model = fakeModel();
  await new Learner({ env: ENV, fetchImpl: model.fetchImpl, code: true }).card(c, { symbol: 'Item' });
  assert.equal(model.calls[0].init.headers.Authorization, 'Bearer ' + ENV.AIDR_CF_API_TOKEN);
  assert.ok(!model.calls[0].init.body.includes(ENV.AIDR_CF_API_TOKEN));
  assert.ok(!model.calls[0].init.body.includes(secret));
});

test('a private file is never sent', async () => {
  const model = fakeModel();
  const learner = new Learner({ env: ENV, fetchImpl: model.fetchImpl, code: true });
  for (const file of ['.env.py', 'deploy/secrets.py', 'config/credentials.mjs']) {
    const result = await learner.card({
      file: '/work/shop/' + file,
      before: [],
      after: ['def load():', '    return 1'],
    });
    assert.ok(result.skipped, file);
  }
  assert.equal(model.calls.length, 0);
});

test('without keys: no call, one line that names the variables and never their values', async () => {
  const model = fakeModel();
  const learner = new Learner({ env: {}, fetchImpl: model.fetchImpl });
  assert.match(learner.problem(), /AIDR_CF_ACCOUNT_ID and AIDR_CF_API_TOKEN/);
  assert.deepEqual(await learner.card(KINDS.guard), { skipped: 'keys' });
  const bad = new Learner({ env: { ...ENV, AIDR_CF_ACCOUNT_ID: 'not-an-id' }, fetchImpl: model.fetchImpl });
  assert.ok(bad.problem() && !bad.problem().includes('not-an-id'));
  assert.equal(model.calls.length, 0);
});

test('limits: one call for each change, the same topic once in 30 minutes, 30 calls an hour', async () => {
  let now = 0;
  const model = fakeModel();
  const learner = new Learner({ env: ENV, fetchImpl: model.fetchImpl, now: () => now });
  assert.ok((await learner.card(KINDS.guard, { symbol: 'total' })).card);
  assert.equal((await learner.card(KINDS.guard, { symbol: 'total' })).skipped, 'asked');
  assert.equal((await learner.card(KINDS.guard, { symbol: 'other' })).skipped, 'recent');
  now = 31 * 60_000;
  assert.ok((await learner.card(KINDS.guard, { symbol: 'other' })).card, 'after 30 minutes');
  // 30 calls in one hour, then the limit.
  const many = new Learner({ env: ENV, fetchImpl: model.fetchImpl, now: () => now });
  for (let i = 0; i < 30; i++) {
    many.shown.clear();
    assert.ok((await many.card(KINDS.guard, { symbol: 'f' + i })).card, 'call ' + i);
  }
  many.shown.clear();
  assert.equal((await many.card(KINDS.guard, { symbol: 'f30' })).skipped, 'limit');
  now += 61 * 60_000;
  many.shown.clear();
  assert.ok((await many.card(KINDS.guard, { symbol: 'f31' })).card, 'a new hour');
});

test('answers: both reply shapes, an object, and a failed call or a bad answer gives no card', async () => {
  assert.deepEqual(answerOf({ result: { response: GOOD } }), GOOD);
  assert.equal(answerOf({ result: { response: 'no json here' } }), null);
  const choices = fakeModel(GOOD, 'choices');
  assert.ok((await new Learner({ env: ENV, fetchImpl: choices.fetchImpl }).card(KINDS.regex)).card);
  const bad = fakeModel({ ...GOOD, docs: 'https://example.com/' });
  const result = await new Learner({ env: ENV, fetchImpl: bad.fetchImpl }).card(KINDS.regex);
  assert.equal(result.skipped, 'check');
  const down = await new Learner({ env: ENV, fetchImpl: async () => reply({}, 500) }).card(KINDS.regex);
  assert.equal(down.skipped, 'http 500');
  const offline = await new Learner({
    env: ENV,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  }).card(KINDS.regex);
  assert.equal(offline.skipped, 'network');
});

test('the card in the terminal: memory aid, advice, links, no code line', () => {
  const lines = renderCard(GOOD, TOPICS[0], { file: 'app/models.py', icons: true });
  assert.equal(lines.length, 5);
  assert.match(lines[0], /📚 Learn · a Pydantic model or Field · app\/models\.py/);
  assert.match(lines[1], /EDGE · Expect bad input/);
  assert.match(lines[3], /Docs: {5}https:\/\/docs\.pydantic\.dev\/latest\/concepts\/fields\//);
  assert.match(lines[4], /Tutorial: https:\/\/docs\.pydantic\.dev\/latest\/#example/);
});
