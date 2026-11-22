// SPDX-License-Identifier: AGPL-3.0-only
/** aidr --learn: one Learn card under a code change, written by Gemma (WTF-PKG-1 section 9.9, phase L1).
 *
 *   aidr --learn                 the watch with a Learn card under each code change
 *   aidr -- --learn-code       the same, and the request also holds the changed lines (secrets masked)
 *
 * Owner, 22 November 2026: "add to aidr spec aidr --learn which educates with helpful coding advice in a
 * mnemonic format with points off to official docs and tutorials"; Q11: "Gemma writes them".
 *
 * A card has a memory aid, one line of advice and two links (the official docs and one tutorial). Gemma
 * (@cf/google/gemma-4-26b-a4b-it on Workers AI) writes it through the Workers AI REST API with the person's own
 * AIDR_CF_ACCOUNT_ID and AIDR_CF_API_TOKEN. The token is only sent in the Authorization header: it is never printed,
 * logged or written. checkCard() checks each answer like a Pydantic model and drops a card that fails.
 *
 * Local Claude first (owner, 22 November 2026: "update aidr learn to use local Claude if available"): when the Claude
 * Code CLI is on the PATH, the card comes from it, with the person's own sign-in and no Cloudflare key. The call runs
 * `claude -p` in the system temp folder (aidr creates no file) with no tools, no settings, no MCP servers, no slash commands and no saved
 * session (so the watch never sees its own call), and a JSON schema of the card. AIDR_LEARN_CLAUDE_MODEL sets the
 * model (default haiku); AIDR_LEARN_PROVIDER=workers-ai keeps Gemma. checkCard() judges both providers the same way.
 *
 * This module is the one part of aidr that opens a network connection, and only when the person gives --learn. The
 * request holds the kind of change, the language, the name of the changed function and the names of the Pydantic models
 * in play; the changed lines only with --learn-code, after safe(). A private file is never sent. */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { isPrivatePath, safe } from './code-tutor.mjs';

export const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const API = 'https://api.cloudflare.com/client/v4/accounts/';
const HOUR = 3600_000,
  REPEAT = 30 * 60_000,
  PER_HOUR = 30;

// --- The kinds of change (spec 9.9, "Matching"): fixed patterns over the added lines, the most specific first. ---

const LANGS = { '.py': 'Python', '.mjs': 'JavaScript', '.js': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript' };
const isTestFile = file =>
  /(^|\/)(tests?|__tests__)\/|[._-]test\.[a-z]+$|(^|\/)test_[^/]+\.py$|\.spec\.[a-z]+$/.test(file);

/** id, the words of the topic, the official sites that fit it, and the test over the added text. */
export const TOPICS = [
  [
    'pydantic-model',
    'a Pydantic model or Field',
    ['docs.pydantic.dev'],
    (t, l) =>
      l === 'Python' && /\bField\(|\((?:\w+\.)?BaseModel\)|\bRootModel\b|model_validator|field_validator/.test(t),
  ],
  [
    'fastapi-route',
    'a FastAPI route',
    ['fastapi.tiangolo.com'],
    (t, l) => l === 'Python' && /@\w+\.(?:get|post|put|patch|delete)\(/.test(t),
  ],
  [
    'sql-parameters',
    'an SQL call with parameters',
    ['www.postgresql.org/docs', 'cheatsheetseries.owasp.org', 'docs.python.org'],
    t => /\b(?:execute|query|fetch\w*)\(\s*[fr]?["'`][^"'`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(t),
  ],
  [
    'broad-except',
    'a broad exception handler',
    ['docs.python.org', 'developer.mozilla.org'],
    t => /^\s*except\s*(?:Exception|BaseException)?\s*(?:as \w+)?\s*:|catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*\}/m.test(t),
  ],
  [
    'subprocess',
    'a subprocess call',
    ['docs.python.org', 'nodejs.org', 'cheatsheetseries.owasp.org'],
    t => /\bsubprocess\.|\bchild_process\b|\bexecFile(?:Sync)?\(|\bspawn(?:Sync)?\(/.test(t),
  ],
  [
    'html-escape',
    'an HTML template and escaping',
    ['developer.mozilla.org', 'cheatsheetseries.owasp.org', 'hono.dev'],
    t => /\.innerHTML\s*=|\bhtml`|\bMarkup\(|render_template|<[a-z][^>]*>\s*\$\{/.test(t),
  ],
  [
    'promise-all',
    'Promise.all and parallel work',
    ['developer.mozilla.org', 'nodejs.org'],
    t => /\bPromise\.(?:all|allSettled|race|any)\(/.test(t),
  ],
  [
    'fetch',
    'an HTTP request',
    ['developer.mozilla.org', 'nodejs.org', 'docs.python.org'],
    t => /\bfetch\(|\bhttpx\.|\brequests\.(?:get|post|put|delete)\(|\burlopen\(/.test(t),
  ],
  [
    'async',
    'async and await',
    ['docs.python.org', 'developer.mozilla.org', 'nodejs.org'],
    t => /\basync\s+(?:def|function)\b|\bawait\b/.test(t),
  ],
  [
    'regex',
    'a regular expression',
    ['docs.python.org', 'developer.mozilla.org'],
    t =>
      /\bre\.(?:compile|match|search|fullmatch|sub|findall)\(|\bnew RegExp\(|\/[^/\n]{3,}\/[dgimsuy]*\.(?:test|exec)\(|\.(?:match|replace|split)\(\/[^/\n]+\//.test(
        t,
      ),
  ],
  [
    'test-assert',
    'a test assertion',
    ['docs.python.org', 'nodejs.org', 'playwright.dev', 'docs.astral.sh'],
    (t, l, file) => isTestFile(file) || /^\s*assert\b|\bassert\.\w+\(|\bexpect\(/m.test(t),
  ],
  [
    'guard',
    'a guard clause',
    ['docs.python.org', 'developer.mozilla.org'],
    t => /^\s*if\b[^\n]*(?:\breturn\b|\braise\b|\bthrow\b)|^\s*if\b[^\n]*:\s*$\n\s*(?:return|raise)\b/m.test(t),
  ],
  [
    'new-import',
    'a new import',
    ['docs.python.org', 'nodejs.org', 'developer.mozilla.org'],
    t => /^\s*(?:import\s|from\s+\S+\s+import\s)/m.test(t),
  ],
  [
    'new-function',
    'a new function or class',
    ['docs.python.org', 'developer.mozilla.org'],
    t =>
      /^\s*(?:async\s+)?(?:def|class)\s+\w+|^\s*(?:export\s+)?(?:async\s+)?function\s+\w+|^\s*(?:export\s+)?class\s+\w+/m.test(
        t,
      ),
  ],
].map(([id, words, sites, match]) => ({ id, words, sites, match }));

/** The one topic of a change, or null. Only code files; a private file has no topic. */
export function topicOf(change) {
  const file = String(change?.file || ''),
    lang = LANGS[extname(file).toLowerCase()];
  if (!lang || isPrivatePath(file)) return null;
  const text = (change.after || []).join('\n');
  if (!text.trim()) return null;
  return TOPICS.find(t => t.match(text, lang, file)) || null;
}

// --- The link allowlist (spec 9.9, "Links") ---

export const ALLOWED = [
  'docs.python.org',
  'docs.pydantic.dev',
  'fastapi.tiangolo.com',
  'nodejs.org',
  'developer.mozilla.org',
  'hono.dev',
  'www.postgresql.org/docs',
  'cheatsheetseries.owasp.org',
  'playwright.dev',
  'docs.astral.sh',
  'git-scm.com/doc',
];

/** True for an https link on the allowlist: the exact host, and for a site with a path the path below it. No user
 * name, no port, no other host that only starts or ends the same. */
export function allowedLink(link, sites = ALLOWED) {
  let url;
  try {
    url = new URL(String(link));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return sites.some(site => {
    const [host, ...rest] = site.split('/'),
      path = rest.length ? '/' + rest.join('/') : '';
    return url.hostname === host && (!path || url.pathname === path || url.pathname.startsWith(path + '/'));
  });
}

// --- The card and its check (a Pydantic-style model in JavaScript) ---

export const BANNED =
  /\b(?:magic\w*|spells?|wizard\w*|potions?|incantations?|quests?|realms?|ninja\w*|rockstar\w*|supercharg\w*|unlock\w*|seamless\w*|powerful|robust|leverag\w*|game.?chang\w*|blazing\w*|revolution\w*|delight\w*)\b/i;

/** The fields of a card, with their limits. */
export const CARD_FIELDS = {
  mnemonic: { min: 3, max: 90 },
  advice: { min: 20, max: 220 },
  docs: { link: true },
  tutorial: { link: true },
};

/** The check of one answer: { ok: true, card } or { ok: false, errors }. Text goes through safe() and loses line
 * breaks first, so a card cannot carry terminal control bytes or a secret. An initial-letter aid ("FAIL · Find ...,
 * Ask ..., ...") must have 3 to 6 letters, and each letter must start one of its steps, in order. */
export function checkCard(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['not an object'] };
  const card = {};
  for (const [name, rule] of Object.entries(CARD_FIELDS)) {
    const raw = value[name];
    if (typeof raw !== 'string') {
      errors.push(`${name}: not a string`);
      continue;
    }
    const text = safe(raw).replace(/\s+/g, ' ').trim();
    if (rule.link) {
      if (!allowedLink(text)) errors.push(`${name}: not an https link on the allowlist`);
    } else if (text.length < rule.min || text.length > rule.max)
      errors.push(`${name}: ${text.length} characters, not ${rule.min} to ${rule.max}`);
    if (BANNED.test(text)) errors.push(`${name}: a fantasy or marketing word`);
    card[name] = text;
  }
  const aid = /^([A-Z]{3,6})\s*[·:-]\s*(.+)$/.exec(card.mnemonic || '');
  if (aid) {
    const steps = aid[2].split(/\s*[,;]\s*/).filter(Boolean),
      initials = steps.map(s => s.replace(/^[^A-Za-z]+/, '')[0]?.toUpperCase()).join('');
    if (initials !== aid[1]) errors.push(`mnemonic: the letters ${aid[1]} do not start its steps (${initials})`);
  } else if (/^[A-Z]{2,}\b/.test(card.mnemonic || '') && /[·:]/.test(card.mnemonic || ''))
    errors.push('mnemonic: an initial-letter aid needs 3 to 6 letters');
  return errors.length ? { ok: false, errors } : { ok: true, card };
}

// --- The request ---

const SYSTEM = `You write one short coding lesson card for a developer who reads a code change.
Answer with one JSON object and nothing else: {"mnemonic": string, "advice": string, "docs": string, "tutorial": string}.
- mnemonic: a memory aid in plain words. Either an initial-letter aid of 3 to 6 capital letters, then " · ", then one
  short step for each letter, in order, separated by commas (each step starts with its letter), or a short rule.
- advice: one sentence of at most 200 characters about the kind of change. Use plain words. Do not quote code.
- docs: one https link to the official documentation page for the topic.
- tutorial: one https link to an official tutorial or guide for the topic.
- Use only links on these sites: ${ALLOWED.join(', ')}.
- No fantasy words, no marketing words, no emoji.`;

/** The body of the Workers AI request for one change. Holds no file path and no code line unless code is true. */
export function requestOf(change, topic, { symbol = '', models = [], code = false } = {}) {
  const facts = {
    kind: topic.id,
    topic: topic.words,
    language: LANGS[extname(String(change.file)).toLowerCase()],
    function: safe(String(symbol || '')).slice(0, 80) || undefined,
    pydantic_models: models.length ? models.slice(0, 8).map(m => safe(String(m)).slice(0, 80)) : undefined,
    sites: topic.sites,
  };
  if (code)
    facts.changed_lines = (change.after || [])
      .slice(0, 40)
      .map(l => safe(String(l)).slice(0, 200))
      .join('\n')
      .slice(0, 2000);
  return {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(facts) },
    ],
    max_tokens: 400,
    temperature: 0.2,
  };
}

/** The first JSON object in a Workers AI answer: result.response (text or object) or an OpenAI-style choice. */
export function answerOf(data) {
  const r = data?.result;
  let text = r?.response ?? r?.choices?.[0]?.message?.content ?? r?.output_text;
  if (text && typeof text === 'object') return text;
  text = String(text || '');
  const start = text.indexOf('{'),
    end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// --- The local Claude Code CLI ---

/** The card's JSON schema for `claude -p --json-schema`. */
export const CARD_SCHEMA = {
  type: 'object',
  // The limits of CARD_FIELDS, so the CLI's structured output keeps to them.
  properties: {
    mnemonic: { type: 'string', minLength: 3, maxLength: 90 },
    advice: { type: 'string', minLength: 20, maxLength: 200 },
    docs: { type: 'string', pattern: '^https://' },
    tutorial: { type: 'string', pattern: '^https://' },
  },
  required: ['mnemonic', 'advice', 'docs', 'tutorial'],
  additionalProperties: false,
};

/** True when an executable named claude is on the PATH. Nothing is run to find it. */
export function hasClaude(env = process.env) {
  for (const dir of String(env.PATH || '')
    .split(delimiter)
    .filter(Boolean)) {
    try {
      accessSync(join(dir, 'claude'), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

/** The arguments of one request to the local CLI: a Learn card by default, or another schema and system text
 * (security.mjs). */
export function claudeArgs(model, { schema = CARD_SCHEMA, system = SYSTEM } = {}) {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--model',
    model,
    '--system-prompt',
    system,
  ];
}

/** Run `claude` with args and stdin in the system temp folder, so no project file or CLAUDE.md is near it and aidr
 * creates no file; resolves { code, stdout }. */
export function runClaude(args, input, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn('claude', args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    const done = result => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, stdout: '', timeout: true });
    }, timeoutMs);
    child.stdout.on('data', d => (stdout += d));
    child.on('error', () => done({ code: -1, stdout: '' }));
    child.on('close', code => done({ code, stdout }));
    child.stdin.end(input);
  });
}

// --- The learner of one watch: keys, limits, the call ---

export class Learner {
  constructor({
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    code = false,
    timeoutMs = 20_000,
    claudeTimeoutMs = 90_000,
    claude = hasClaude(env),
    runCli = runClaude,
  } = {}) {
    this.account = String(env.AIDR_CF_ACCOUNT_ID || '').trim();
    this.token = String(env.AIDR_CF_API_TOKEN || '').trim();
    // Local Claude when the CLI is there, unless the person asks for Workers AI.
    this.provider = claude && env.AIDR_LEARN_PROVIDER !== 'workers-ai' ? 'claude' : 'workers-ai';
    this.claudeModel = /^[a-z0-9.-]{2,40}$/.test(env.AIDR_LEARN_CLAUDE_MODEL || '')
      ? env.AIDR_LEARN_CLAUDE_MODEL
      : 'haiku';
    this.runCli = runCli;
    this.claudeTimeoutMs = claudeTimeoutMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.code = code;
    this.timeoutMs = timeoutMs;
    this.calls = [];
    this.shown = new Map();
    this.asked = new Set();
  }

  /** Who writes the cards, for the watch's first line. */
  label() {
    return this.provider === 'claude' ? `local Claude (${this.claudeModel})` : 'Gemma on Workers AI';
  }

  /** null when the keys are there; otherwise the one line that says why no card shows. The values are never shown. */
  problem() {
    if (this.provider === 'claude') return null;
    if (!this.account || !this.token)
      return '--learn needs AIDR_CF_ACCOUNT_ID and AIDR_CF_API_TOKEN (a Workers AI token of your own Cloudflare account); no card shows.';
    if (!/^[0-9a-f]{32}$/.test(this.account))
      return '--learn: AIDR_CF_ACCOUNT_ID is not a 32-character Cloudflare account id; no card shows.';
    return null;
  }

  /** The card for one change, or { skipped: reason }. At most one call for each change, PER_HOUR calls an hour, and
   * the same topic at most once in 30 minutes. */
  async card(change, { symbol = '', models = [] } = {}) {
    if (this.problem()) return { skipped: 'keys' };
    const topic = topicOf(change);
    if (!topic) return { skipped: 'topic' };
    const key = `${change.file}|${symbol}|${topic.id}`,
      now = this.now();
    if (this.asked.has(key)) return { skipped: 'asked' };
    if (now - (this.shown.get(topic.id) ?? -Infinity) < REPEAT) return { skipped: 'recent' };
    this.calls = this.calls.filter(t => now - t < HOUR);
    if (this.calls.length >= PER_HOUR) return { skipped: 'limit' };
    this.asked.add(key);
    this.calls.push(now);
    this.shown.set(topic.id, now);
    const request = requestOf(change, topic, { symbol, models, code: this.code });
    if (this.provider === 'claude') {
      const run = await this.runCli(claudeArgs(this.claudeModel), request.messages[1].content, this.claudeTimeoutMs);
      if (run.timeout) return { skipped: 'timeout' };
      let result;
      try {
        result = JSON.parse(run.stdout || '{}');
      } catch {
        return { skipped: 'claude answer' };
      }
      if (run.code !== 0 || result.is_error) return { skipped: 'claude' };
      const checked = checkCard(result.structured_output ?? answerOf({ result: { response: result.result } }));
      return checked.ok ? { card: checked.card, topic } : { skipped: 'check', errors: checked.errors };
    }
    let data;
    try {
      const reply = await this.fetch(`${API}${this.account}/ai/run/${MODEL}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!reply.ok) return { skipped: `http ${reply.status}` };
      data = await reply.json();
    } catch (error) {
      return { skipped: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
    const checked = checkCard(answerOf(data));
    return checked.ok ? { card: checked.card, topic } : { skipped: 'check', errors: checked.errors };
  }
}

/** The lines of a card under a change (spec 9.9: memory aid, advice, links; no code line). */
export function renderCard(card, topic, { file = '', paint = (c, t) => t, icons = false } = {}) {
  const bar = paint('gray', '│');
  return [
    `  ${bar} ${paint('cyan', (icons ? '📚 ' : '') + 'Learn')} ${paint('gray', '· ' + topic.words + (file ? ' · ' + safe(file) : ''))}`,
    `  ${bar}    ${paint('bold', card.mnemonic)}`,
    `  ${bar}    ${card.advice}`,
    `  ${bar}    ${paint('gray', 'Docs:    ')} ${card.docs}`,
    `  ${bar}    ${paint('gray', 'Tutorial:')} ${card.tutorial}`,
  ];
}
