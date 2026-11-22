// SPDX-License-Identifier: AGPL-3.0-only
/** The code changes of a Claude session, shown so that a person can follow them (aidr).
 *
 * Owner, 21 November 2026, after the comprehension debt research (.local/research/comprehension-debt.html): "show code
 * changes and explain the changes to tutor a user, make it comprehensible". The research says that a reader keeps up
 * with AI code when each change is small, says why it was made, and asks the reader to explain it. So each change shows:
 *
 *   1. The change: the file, the function it is in, +added and -removed lines, and the lines themselves (a short diff).
 *   2. Why: the words Claude wrote just before the change, which is its own statement of intent.
 *   3. What to look for: plain notes from fixed rules (a new function, a changed decision, a new guard, a test ...).
 *   4. Check yourself: one question to answer in your own words before you go on.
 *
 *   5. The map (CodeGraph, when the folder has a .codegraph/ index): who calls the changed function, what it calls, and
 *      how many tests reach it within 3 steps (a test, the service, the helper, the changed function). A change that no test reaches says so: that is the change to read first.
 *
 * No model is called: every note comes from fixed rules and the CodeGraph index, so the watch costs nothing and says
 * nothing it did not read.
 * Secrets stay out: a private path (.env files, .local/, keys, credentials) is never shown, and a line that holds a
 * token, a key or a password is masked. Changes made outside the edit tools (a script, sed, git) come from git. */
import { execFile, execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_LINES = 400,
  SHOW = 14;
// The code graph shows at most this many callers and callees; "+N more" says how many the index has beyond it.
export const GRAPH_LIMIT = 10;
// The largest file that is read, for the name of the changed function or an untracked file (audit F8).
export const MAX_FILE_BYTES = 1_000_000;

// --- Code highlights (owner, 21 November 2026: "terminal code highlights for easy comprehension of mjs and python") ---

const JS_KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue new class extends import ' +
    'from export default async await try catch finally throw typeof instanceof in of this null undefined true false yield static ' +
    'get set delete void super'
  ).split(' '),
);
const PY_KEYWORDS = new Set(
  (
    'def class return if elif else for while in not and or is import from as with try except finally raise ' +
    'pass break continue lambda yield async await global nonlocal assert del None True False match case'
  ).split(' '),
);
const PY_BUILTINS = new Set(
  (
    'self cls print len range dict list set tuple str int float bool sorted any all min max sum enumerate ' +
    'zip isinstance getattr setattr hasattr super type open map filter repr'
  ).split(' '),
);
const JS_BUILTINS = new Set(
  'console JSON Math Object Array String Number Promise Map Set Date Error RegExp URL process Response Request'.split(
    ' ',
  ),
);
// One pass over a line: comments, strings, decorators, numbers, words and the arrow.
const JS_TOKEN =
  /(\/\/.*$|\/\*.*?(?:\*\/|$))|(`(?:\\.|[^`\\])*`?|'(?:\\.|[^'\\])*'?|"(?:\\.|[^"\\])*"?)|(\b\d+(?:\.\d+)?(?:_\d+)*\b)|([A-Za-z_$][\w$]*)|(=>)/g;
// JSON: a comment (.jsonc), a string, a number, a literal (true, false, null). A string before ':' is a key.
const JSON_TOKEN =
  /(\/\/.*$|\/\*.*?(?:\*\/|$))|("(?:\\.|[^"\\])*"?)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g;
const PY_TOKEN =
  /(#.*$)|((?:\b[rRbBfFuU]{1,2})?(?:'''.*?(?:'''|$)|""".*?(?:"""|$)|'(?:\\.|[^'\\])*'?|"(?:\\.|[^"\\])*"?))|(@[\w.]+)|(\b\d+(?:\.\d+)?(?:_\d+)*\b)|([A-Za-z_]\w*)/g;

/** The language of a file for the highlights: 'js', 'python', or null (shown as it is). */
export function langOf(file) {
  const ext = extname(String(file || '')).toLowerCase();
  return ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)
    ? 'js'
    : ext === '.py'
      ? 'python'
      : ['.json', '.jsonc', '.jsonl', '.webmanifest'].includes(ext)
        ? 'json'
        : null;
}

/** One line of code with colours by role: keyword, defined name, called name, type or built-in, string, number,
 * comment, decorator. paint(code,text) is the terminal's painter; without colours the line comes back unchanged. */
export function highlight(text, lang, paint) {
  if (!lang) return text;
  if (lang === 'json') return highlightJson(text, paint);
  const py = lang === 'python',
    keywords = py ? PY_KEYWORDS : JS_KEYWORDS,
    builtins = py ? PY_BUILTINS : JS_BUILTINS;
  let out = '',
    last = 0,
    previous = '';
  for (const m of text.matchAll(py ? PY_TOKEN : JS_TOKEN)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const [token] = m;
    if (m[1]) {
      out += paint('comment', token);
      continue;
    }
    if (m[2]) {
      out += paint('string', token);
      continue;
    }
    if (py && m[3]) {
      out += paint('decorator', token);
      previous = '';
      continue;
    }
    if (m[py ? 4 : 3]) {
      out += paint('number', token);
      continue;
    }
    if (!py && m[5]) {
      out += paint('keyword', token);
      continue;
    }
    const word = m[py ? 5 : 4];
    if (!word) {
      out += token;
      continue;
    }
    const next = text.slice(last).trimStart()[0];
    if (['def', 'class', 'function'].includes(previous)) out += paint('definition', word);
    else if (keywords.has(word)) out += paint('keyword', word);
    else if (builtins.has(word)) out += paint('builtin', word);
    else if (next === '(') out += paint('call', word);
    else if (/^[A-Z][a-z]/.test(word)) out += paint('type', word);
    else out += word;
    previous = word;
  }
  return out + text.slice(last);
}

/** One line of JSON: keys as names being defined, string values, numbers, true, false and null. */
function highlightJson(text, paint) {
  let out = '',
    last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[1]) out += paint('comment', m[0]);
    else if (m[2]) out += paint(/^\s*:/.test(text.slice(last)) ? 'definition' : 'string', m[0]);
    else if (m[3]) out += paint('number', m[0]);
    else out += paint('keyword', m[0]);
  }
  return out + text.slice(last);
}

// Files that the watch never shows, whatever their change (security audit F4, WTF-PKG-1 section 4).
const PRIVATE_PATHS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)[^/]*\.env$/,
  /(^|\/)\.envrc$/,
  /(^|\/)\.dev\.vars/,
  /(^|\/)\.local\//,
  /(^|\/)secrets?(\/|\.)/,
  /credential/,
  /\.(pem|key|p12|pfx|jks|keystore|ovpn|tfvars|tfstate)(\.|$)/,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.pub)?$/,
  /(^|\/)\.(ssh|aws|gnupg|kube|azure)\//,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.(pgpass|netrc|npmrc|git-credentials|pypirc)$/,
  /(^|\/)\.config\/(gh|gcloud|op|doctl)\//,
  /(^|\/)\.claude\/(settings[^/]*\.json|\.credentials\.json)$/,
  /(^|\/)\.claude\.json$/,
  /(^|\/)service-account[^/]*\.json$/,
  /(^|\/)\.(wrangler|vercel|terraform)\//,
  /(^|\/)kubeconfig$/,
  /settings\.local\.json$/,
];
const USER_PRIVATE = join(homedir(), '.config', 'devekko.aidr', 'private');
const globRule = line =>
  new RegExp(
    '(^|/)' +
      line
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\uE000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\uE000/g, '.*') +
      '($|/)',
    'i',
  );
/** The person's own private patterns: one glob on each line of ~/.config/devekko.aidr/private (# starts a comment). */
export function userPrivateRules(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(globRule);
}
let userRules = null;
const ownRules = () => {
  if (userRules === null) {
    try {
      userRules = userPrivateRules(readFileSync(USER_PRIVATE, 'utf8'));
    } catch {
      userRules = [];
    }
  }
  return userRules;
};
/** Files that the watch never shows, whatever their change. */
export function isPrivatePath(path, extra = ownRules()) {
  const p = String(path || '').replaceAll('\\', '/');
  return PRIVATE_PATHS.some(r => r.test(p.toLowerCase())) || extra.some(r => r.test(p));
}

/** Terminal control bytes out (security audit F1): escape sequences (CSI, OSC, DCS and the rest), C1 bytes, and every
 * C0 byte except the tab. A file or a prompt can then not write to the clipboard, set the title or move the screen. */
// oxlint-disable no-control-regex -- this filter matches control bytes on purpose (audit F1).
export function stripControls(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\u001b[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b[\s\S]?/g, '')
    .replace(/\u009b[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/[\u009d\u0090\u0098\u009e\u009f][^\u0007\u009c]*[\u0007\u009c]?/g, '')
    .replace(/[\u0080-\u009f]/g, '')
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, '');
}
// oxlint-enable no-control-regex
/** The one filter for every string from outside the watch (a prompt, Claude's text, a file line, a git line): no
 * control bytes, and every secret masked (security audit F1, F2). */
export function safe(text) {
  return mask(stripControls(text));
}

const SECRETS = [
  /\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[abprse]-[A-Za-z0-9-]{10,}|whsec_[A-Za-z0-9]{16,}|[rs]k_(?:live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|dop_v1_[a-f0-9]{40,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g,
  // A Slack or Discord webhook, and the user and password part of a URL (a DSN: postgres://user:password@host).
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  /https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9/_-]+/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?<![A-Za-z0-9])[A-Fa-f0-9]{40,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/])/g,
];
const SECRET_KEY =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|authorization|bearer)["']?\s*[:=]\s*["']?)([^"'\s,;]{6,})/gi;
// The AWS secret key: 40 base64 characters after its name, also with only a space between (the credentials file form).
const AWS_SECRET = /(aws_secret_access_key["']?\s*[:= ]\s*["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi;
const URL_USER = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi;
// A shell variable whose name ends in KEY, TOKEN, SECRET, PASSWORD, PASSWD, PWD or CREDENTIAL(S): its value (aidr shows
// the shell commands, so CLAUDE_AGENT_KEY=... must not print).
const ENV_SECRET = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?))=("[^"]*"|'[^']*'|\S+)/gi;
/** A line with every token, key and password value replaced by ••••. */
export function mask(line) {
  let out = String(line)
    .replace(URL_USER, (m, user, _pass, at) => user + '••••' + at)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '••••')
    .replace(ENV_SECRET, (m, name) => name + '=••••')
    .replace(AWS_SECRET, (m, key) => key + '••••')
    .replace(SECRET_KEY, (m, key) => key + '••••');
  for (const pattern of SECRETS) out = out.replace(pattern, '••••');
  return out;
}

const lines = text =>
  String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');

/** The file changes of one transcript entry: Edit, MultiEdit, Write and NotebookEdit calls. */
export function changesOf(entry) {
  const content = entry?.message?.content;
  if (entry?.type !== 'assistant' || !Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (part?.type !== 'tool_use') continue;
    const i = part.input || {},
      file = i.file_path || i.notebook_path;
    if (!file) continue;
    if (part.name === 'Edit')
      out.push({
        file,
        tool: 'Edit',
        kind: 'edit',
        before: lines(i.old_string),
        after: lines(i.new_string),
        all: Boolean(i.replace_all),
      });
    else if (part.name === 'MultiEdit' && Array.isArray(i.edits))
      for (const e of i.edits)
        out.push({
          file,
          tool: 'MultiEdit',
          kind: 'edit',
          before: lines(e.old_string),
          after: lines(e.new_string),
          all: Boolean(e.replace_all),
        });
    else if (part.name === 'Write')
      out.push({ file, tool: 'Write', kind: 'write', before: [], after: lines(i.content) });
    else if (part.name === 'NotebookEdit')
      out.push({ file, tool: 'NotebookEdit', kind: 'edit', before: [], after: lines(i.new_source) });
  }
  return out;
}

/** A line diff of two short texts (longest common subsequence): [{op:' '|'-'|'+', text}]. */
export function diffLines(before, after) {
  const a = before.slice(0, MAX_LINES),
    b = after.slice(0, MAX_LINES),
    n = a.length,
    m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] });
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

const SYMBOL = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*app\.(get|post|put|delete)\(\s*['"`]([^'"`]+)/,
  /^\s*@app\.(get|post|put|delete)\(\s*["']([^"']+)/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
];
const symbolOf = line => {
  for (const p of SYMBOL) {
    const m = line.match(p);
    if (m) return m.length > 2 && m[2] ? `${m[1].toUpperCase()} ${m[2]}` : m[1];
  }
  return null;
};

/** The function or class that holds the changed text, from the file as it is now on disk. */
export function enclosing(fileText, after) {
  const text = String(fileText || ''),
    first = after.find(l => l.trim().length > 3);
  if (!text || !first) return null;
  const at = text.indexOf(first);
  if (at < 0) return null;
  const before = text.slice(0, at).split('\n');
  const own = symbolOf(first);
  if (own) return own;
  for (let k = before.length - 1; k >= 0; k--) {
    const s = symbolOf(before[k]);
    if (s) return s;
  }
  return null;
}

const LANG = {
  '.py': 'Python',
  '.mjs': 'JavaScript',
  '.js': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.sql': 'SQL',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.toml': 'TOML',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.css': 'CSS',
  '.html': 'HTML',
  '.liquid': 'Liquid',
  '.sh': 'shell',
};
const isTest = file => /(^|\/)(tests?|__tests__)\/|[._-]test\.[a-z]+$|(^|\/)test_[^/]+\.py$|\.spec\.[a-z]+$/.test(file);

/** Plain notes on what kind of change this is, and one question for the reader. Fixed rules only. */
export function explain(file, diff, kind) {
  const added = diff.filter(d => d.op === '+').map(d => d.text),
    removed = diff.filter(d => d.op === '-').map(d => d.text);
  const notes = [],
    name = n => '`' + n + '`';
  let question = null;
  const ext = extname(file).toLowerCase(),
    lang = LANG[ext];
  if (isTest(file)) {
    notes.push('A test. It states what the code must do: read the assert lines first, they are the rule.');
    question ??= 'Which behaviour does this test protect, and what would break it?';
  } else if (ext === '.md') {
    notes.push('Documentation: the intent in words. It is the "why" that the code cannot say.');
    question ??= 'Does the code do what this text says?';
  } else if (['.json', '.toml', '.yaml', '.yml'].includes(ext)) {
    notes.push('Configuration: it changes how something runs, not what the code says.');
    question ??= 'What runs differently after this change?';
  } else if (ext === '.sql') {
    notes.push(
      'A database change: it changes tables, rows or who may read them. It runs once, so check it before it runs.',
    );
    question ??= 'Which table or grant changes, and can it be undone?';
  }
  if (kind === 'write' && !removed.length)
    notes.push(
      `A new ${lang ? lang + ' ' : ''}file of ${added.length} lines. Read its first comment: it says what the file is for.`,
    );
  const defs = added.map(symbolOf).filter(Boolean),
    gone = removed.map(symbolOf).filter(s => s && !defs.includes(s));
  if (defs.length) {
    notes.push(
      `Adds or changes ${defs.slice(0, 3).map(name).join(', ')}${defs.length > 3 ? ` and ${defs.length - 3} more` : ''}: a named piece that other code can call.`,
    );
    question ??= `In one sentence, what does ${name(defs[0])} do, and what calls it?`;
  }
  if (gone.length) {
    notes.push(`Removes ${gone.slice(0, 3).map(name).join(', ')}: find what called it before.`);
    question ??= `What called ${name(gone[0])}, and what does that code use now?`;
  }
  const imports = added.filter(l => /^\s*(?:import\s|from\s+\S+\s+import\s|const\s+\{[^}]*\}\s*=\s*require\()/.test(l));
  if (imports.length)
    notes.push(
      `New import${imports.length > 1 ? 's' : ''}: the file now uses code from ${imports
        .slice(0, 2)
        .map(l => name(l.trim().replace(/\s+/g, ' ').slice(0, 60)))
        .join(', ')}.`,
    );
  const decisions = added.filter(
    l => /\b(if|elif|else if|switch|case|while)\b|\?[^:]+:/.test(l) && !/^\s*(#|\/\/|\*)/.test(l),
  );
  if (decisions.length) {
    notes.push(
      `Changes ${decisions.length === 1 ? 'a decision' : decisions.length + ' decisions'}: the code now takes a path that depends on a condition.`,
    );
    question ??= 'When is the new condition true, and what happens then?';
  }
  const guards = added.filter(l => /\b(raise|throw|require|refuse|assert)\b/.test(l) && !isTest(file));
  if (guards.length) {
    const words = guards.map(l => l.match(/["'`]([^"'`]{3,60})["'`]/)?.[1]).filter(Boolean);
    notes.push(
      `Adds a guard: the code stops bad input${
        words.length
          ? ' with ' +
            words
              .slice(0, 2)
              .map(w => '"' + w + '"')
              .join(', ')
          : ''
      }.`,
    );
    question ??= 'Which input does the new guard refuse, and who sees the refusal?';
  }
  const returns = added.filter(l => /^\s*return\b/.test(l));
  if (returns.length && !defs.length)
    notes.push('Changes what a function gives back: check every place that reads its result.');
  const consts = added.filter(l => /^\s*(?:export\s+)?(?:const\s+)?[A-Z][A-Z0-9_]{2,}\s*=/.test(l));
  if (consts.length)
    notes.push(
      `Changes a fixed value (${consts
        .slice(0, 2)
        .map(l =>
          name(
            l
              .trim()
              .split('=')[0]
              .replace(/^(export\s+)?const\s+/, '')
              .trim(),
          ),
        )
        .join(', ')}): a limit or a setting that the code reads.`,
    );
  const comments = added.filter(l => /^\s*(#|\/\/|\*|\/\*\*)/.test(l));
  if (comments.length && comments.length >= added.length / 2)
    notes.push('Mostly comments: the author explains the code here. Read them first.');
  if (!notes.length)
    notes.push(
      added.length && removed.length
        ? 'Rewrites lines in place: compare each - line with the + line under it.'
        : added.length
          ? 'Adds lines.'
          : 'Removes lines.',
    );
  question ??= 'Why was this change needed? Use the "Why" line, then say it in your own words.';
  return { notes, question };
}

const fileTextOf = (cwd, file) => {
  try {
    const p = isAbsolute(file) ? file : resolve(cwd || '.', file);
    return statSync(p).size <= MAX_FILE_BYTES ? readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
};
/** True when the first 8 KB of a file hold a NUL byte: a binary file, never shown (audit F6). */
function isBinary(path) {
  try {
    const fd = openSync(path, 'r'),
      b = Buffer.alloc(8192);
    try {
      const n = readSync(fd, b, 0, b.length, 0);
      return b.subarray(0, n).includes(0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return true;
  }
}
/** True when a file is inside the working folder of the session (audit F5). */
export function insideFolder(cwd, file) {
  if (!cwd || !isAbsolute(String(file || ''))) return true;
  const c = resolve(cwd),
    f = resolve(file);
  return f === c || f.startsWith(c.endsWith(sep) ? c : c + sep);
}
const shortPath = (cwd, file) => {
  const r = cwd && isAbsolute(file) ? relative(cwd, file) : file;
  return r && !r.startsWith('..') ? r : file;
};

/** The lines of one change for the terminal. paint(code,text) colours; icons adds the symbols. */
export function renderChange(
  change,
  { cwd = '', why = '', paint = (c, t) => t, icons = false, full = false, outside = false } = {},
) {
  const path = safe(shortPath(cwd, change.file)),
    bar = paint('gray', '│'),
    lang = langOf(change.file);
  if (isPrivatePath(change.file))
    return [`  ${icons ? '🔒 ' : ''}${paint('yellow', path)}  ${paint('gray', 'a private file: not shown')}`];
  const diff = diffLines(change.before, change.after),
    added = diff.filter(d => d.op === '+').length,
    removed = diff.filter(d => d.op === '-').length;
  // A file outside the session's folder shows its path and counts only, unless --outside (audit F5).
  if (!outside && !insideFolder(cwd, change.file))
    return [
      `  ${icons ? '🔒 ' : ''}${paint('yellow', path)}  ${paint('green', '+' + added)} ${paint('red', '-' + removed)}  ${paint('gray', 'outside the session folder: lines not shown (--outside shows them)')}`,
    ];
  const where = safe(enclosing(fileTextOf(cwd, change.file), change.after) || '');
  const head = `  ${icons ? (change.kind === 'write' ? '🆕 ' : '✏️  ') : ''}${paint('bold', path)}${where ? paint('gray', '  in ') + paint('cyan', where) : ''}  ${paint('green', '+' + added)} ${paint('red', '-' + removed)}${change.all ? paint('gray', '  (every match)') : ''}`;
  const out = [head];
  if (why) out.push(`  ${bar} ${paint('magenta', icons ? '💭 Why: ' : 'Why: ')}${paint('magenta', safe(why))}`);
  // Only the changed lines, with one line of context around them.
  const keep = new Set();
  diff.forEach((d, k) => {
    if (d.op !== ' ') for (const x of [k - 1, k, k + 1]) if (x >= 0 && x < diff.length) keep.add(x);
  });
  const shown = [...keep].sort((x, y) => x - y),
    limit = full ? shown.length : SHOW;
  let last = -2;
  for (const k of shown.slice(0, limit)) {
    if (k > last + 1 && last >= 0) out.push(`  ${bar} ${paint('gray', '  …')}`);
    const d = diff[k],
      text = safe(d.text).slice(0, 160);
    // Added lines in full colour, so the new code reads first; removed lines plain red; context in colour, behind a gap.
    out.push(
      `  ${bar} ${d.op === '+' ? paint('bold', paint('green', '+')) + ' ' + highlight(text, lang, paint) : d.op === '-' ? paint('red', '- ' + text) : '  ' + highlight(text, lang, paint)}`,
    );
    last = k;
  }
  if (shown.length > limit) out.push(`  ${bar} ${paint('gray', `  … ${shown.length - limit} more lines`)}`);
  const { notes, question } = explain(change.file, diff, change.kind);
  for (const n of notes.slice(0, 3)) out.push(`  ${bar} ${paint('cyan', (icons ? '📘 ' : 'Note: ') + safe(n))}`);
  out.push(`  ${bar} ${paint('yellow', (icons ? '❓ Check yourself: ' : 'Check yourself: ') + safe(question))}`);
  return out;
}

// git with no command of the folder's own configuration (audit F7): no fsmonitor, no external diff, no text
// conversion, no pager, no prompt, no optional lock.
export const GIT_SAFE = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
  '--no-pager',
];
export const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_EXTERNAL_DIFF: '',
};

/** Changes that git sees in a working folder, for edits made outside the edit tools (a script, sed, a generator).
 * The first poll only remembers what is already changed; later polls return the hunks that are new since then. */
export class GitChanges {
  constructor(
    cwd,
    run = args =>
      execFileSync('git', [...GIT_SAFE, '-C', cwd, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ...GIT_ENV },
      }),
  ) {
    this.cwd = cwd;
    this.run = run;
    this.seen = new Map();
    this.started = false;
    this.recent = new Map();
  }
  /** A file shown from an edit tool: its next git change is that same edit, so it is not shown twice. */
  shown(file, at = Date.now()) {
    this.recent.set(shortPath(this.cwd, file), at);
  }
  poll(now = Date.now()) {
    let text = '',
      untracked = [];
    try {
      text = this.run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U1', 'HEAD', '--', '.']);
      untracked = this.run(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    } catch {
      return [];
    }
    const files = new Map();
    let current = null;
    for (const line of text.split('\n')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) {
        current = { file: m[2], hunks: [] };
        files.set(m[2], current);
        continue;
      }
      if (!current) continue;
      if (line.startsWith('@@')) current.hunks.push({ header: line, lines: [] });
      else if (current.hunks.length && /^[ +-]/.test(line) && !/^(\+\+\+|---) /.test(line))
        current.hunks.at(-1).lines.push(line);
    }
    for (const file of untracked)
      if (
        !files.has(file) &&
        !isPrivatePath(file) &&
        !/\.(png|jpe?g|gif|webp|zip|gz|woff2?|pdf)$/i.test(file) &&
        !isBinary(resolve(this.cwd, file))
      ) {
        const content = fileTextOf(this.cwd, file).split('\n').slice(0, 40);
        files.set(file, { file, hunks: [{ header: 'new file', lines: content.map(l => '+' + l) }], untracked: true });
      }
    const out = [];
    for (const [file, entry] of files) {
      const keys = entry.hunks.map(h => h.lines.join('\n')),
        before = this.seen.get(file) || new Set();
      this.seen.set(file, new Set(keys));
      if (!this.started || isPrivatePath(file)) continue;
      const fresh = entry.hunks.filter((h, k) => !before.has(keys[k]));
      const recently = this.recent.has(file) && now - this.recent.get(file) < 20_000;
      if (fresh.length && !recently) out.push({ file, hunks: fresh, untracked: Boolean(entry.untracked) });
    }
    this.started = true;
    return out;
  }
}

/** A git change as a change for renderChange: the removed and added lines of its new hunks. */
export function gitChange(cwd, c) {
  const before = [],
    after = [];
  for (const h of c.hunks)
    for (const l of h.lines) {
      if (l.startsWith('-')) before.push(l.slice(1));
      else if (l.startsWith('+')) after.push(l.slice(1));
      else {
        before.push(l.slice(1));
        after.push(l.slice(1));
      }
    }
  return { file: resolve(cwd, c.file), tool: 'git', kind: c.untracked ? 'write' : 'edit', before, after };
}

/** The counts of a watch: files and lines changed, and the code files that changed with no change to a test. */
export class CodeTally {
  constructor() {
    this.files = new Map();
  }
  add(change) {
    const diff = diffLines(change.before, change.after),
      f = this.files.get(change.file) || { added: 0, removed: 0, edits: 0 };
    f.added += diff.filter(d => d.op === '+').length;
    f.removed += diff.filter(d => d.op === '-').length;
    f.edits++;
    this.files.set(change.file, f);
  }
  line() {
    if (!this.files.size) return 'no code change';
    const t = [...this.files.values()].reduce(
      (a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }),
      { added: 0, removed: 0 },
    );
    return `${this.files.size} file${this.files.size === 1 ? '' : 's'} changed, +${t.added} -${t.removed}`;
  }
  /** Code files changed while no test file changed: the research's warning sign of a change nobody checked. */
  untested(cwd = '') {
    const names = [...this.files.keys()].map(f => shortPath(cwd, f));
    if (names.some(isTest)) return [];
    return names.filter(n => /\.(py|mjs|js|ts|tsx)$/.test(n) && !isTest(n));
  }
  /** The files to read first: the most changed. */
  top(cwd = '', n = 3) {
    return [...this.files]
      .sort((a, b) => b[1].added + b[1].removed - (a[1].added + a[1].removed))
      .slice(0, n)
      .map(([f, c]) => `${shortPath(cwd, f)} (+${c.added} -${c.removed})`);
  }
}

// --- The map of a change, from CodeGraph ---

const SYMBOL_NAME = /^[A-Za-z_$][\w$]*$/;
/** The symbol a change is about: the function it is in, else the first function or class it adds. */
export function symbolOfChange(change, cwd = '') {
  if (isPrivatePath(change.file) || !/\.(py|mjs|js|ts|tsx|go|rs|java|rb|php|cs|kt|swift)$/.test(change.file))
    return null;
  const own = enclosing(fileTextOf(cwd, change.file), change.after);
  if (own && SYMBOL_NAME.test(own)) return own;
  const added = change.after.map(symbolOf).find(s => s && SYMBOL_NAME.test(s));
  return added || null;
}

const graphCache = new Map();
const run = (cwd, args, timeout) =>
  new Promise(done =>
    execFile('codegraph', [...args, '-p', cwd, '--json'], { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return done(null);
      try {
        done(JSON.parse(stdout));
      } catch {
        done(null);
      }
    }),
  );

/** The callers, the callees and the tests within 3 steps of one symbol, or null when the folder has no index.
 * graph.indexed is false when the index does not have the symbol yet (a new function is indexed about a second later). */
export async function graphOf(cwd, symbol, file, { now = Date.now(), exec = run, timeout = 4000 } = {}) {
  if (!symbol || !cwd || !existsSync(resolve(cwd, '.codegraph'))) return null;
  const rel = shortPath(cwd, file),
    key = cwd + '|' + rel + '|' + symbol,
    hit = graphCache.get(key);
  if (hit && now - hit.at < 30_000) return hit.graph;
  const [callers, callees, impact] = await Promise.all([
    exec(cwd, ['callers', symbol, '-f', rel, '-l', String(GRAPH_LIMIT)], timeout),
    exec(cwd, ['callees', symbol, '-f', rel, '-l', String(GRAPH_LIMIT)], timeout),
    exec(cwd, ['impact', symbol, '-f', rel, '-d', '3'], timeout),
  ]);
  const def = callers?.definitions?.[0]?.definition;
  if (!callers || !def || callers.filteredOut) {
    const graph = { indexed: false, symbol };
    graphCache.set(key, { at: now, graph });
    return graph;
  }
  const where = n => ({ name: n.name, file: n.filePath, line: n.startLine });
  const affected = (impact?.definitions?.[0]?.affected || []).filter(
    n => n.name !== symbol || n.filePath !== def.filePath,
  );
  const tests = affected.filter(n => isTest(n.filePath || '') || /^test_|^test /.test(n.name || ''));
  const graph = {
    indexed: true,
    symbol,
    file: def.filePath,
    line: def.startLine,
    callers: (callers.definitions[0].callers || []).map(where),
    total: callers.definitions[0].total ?? 0,
    callees: (callees?.definitions?.[0]?.callees || callees?.callees || []).map(where).slice(0, GRAPH_LIMIT),
    tests: tests.map(where),
    affectedFiles: new Set(
      affected.filter(n => !isTest(n.filePath || '') && n.filePath !== def.filePath).map(n => n.filePath),
    ).size,
  };
  graphCache.set(key, { at: now, graph });
  return graph;
}

/** The code graph of one symbol, drawn: its callers on the left, the symbol in the middle, what it uses on the right
 * (owner, 21 November 2026: "aiwtf ... add the code graph"). At most GRAPH_LIMIT (10) callers and callees; "+N more" when the index
 * has more. Box-drawing characters only, so it works in any terminal. */
export function graphDiagram(graph, paint = (c, t) => t) {
  const name = n => safe(n.name);
  const left = graph.callers.slice(0, GRAPH_LIMIT).map(name),
    right = graph.callees.slice(0, GRAPH_LIMIT).map(name);
  const more = (graph.total ?? left.length) - left.length;
  if (more > 0) left.push(`+${more} more`);
  const rows = Math.max(left.length, right.length, 1),
    mid = Math.floor((rows - 1) / 2);
  const place = list => {
    const start = mid - Math.floor((list.length - 1) / 2);
    return { start, end: start + list.length - 1, at: r => list[r - start] };
  };
  const L = place(left),
    R = place(right),
    w = Math.max(0, ...left.map(n => n.length)),
    sym = safe(graph.symbol);
  const joint = (r, box, side) => {
    if (box.start === box.end) return '─';
    if (r === mid) return r === box.start ? '┬' : r === box.end ? '┴' : '┼';
    return r === box.start
      ? side === 'left'
        ? '┐'
        : '┌'
      : r === box.end
        ? side === 'left'
          ? '┘'
          : '└'
        : side === 'left'
          ? '┤'
          : '├';
  };
  const out = [];
  for (let r = 0; r < rows; r++) {
    const li = left.length && r >= L.start && r <= L.end ? L.at(r) : null,
      ri = right.length && r >= R.start && r <= R.end ? R.at(r) : null;
    const lpart = !left.length
      ? ''
      : li !== null
        ? paint('call', li.padStart(w)) + paint('gray', ' ──' + joint(r, L, 'left'))
        : ' '.repeat(w + 4);
    const mpart =
      r === mid
        ? (left.length ? paint('gray', '──▶ ') : '') +
          paint('definition', sym) +
          (right.length ? paint('gray', ' ──') : '')
        : ' '.repeat((left.length ? 4 : 0) + sym.length + (right.length ? 3 : 0));
    const rpart = ri !== null ? paint('gray', joint(r, R, 'right') + '──▶ ') + paint('call', ri) : '';
    out.push((lpart + mpart + rpart).replace(/\s+$/, ''));
  }
  return out;
}

/** Code graphs as one Mermaid flowchart (owner, 22 November 2026: "make mermaid codegraph pydantic standard"): each
 * caller points to the changed symbol, the symbol points to what it uses, and a dotted line comes from each test. The
 * changed symbols have a thick border. Ids are n0, n1 ...; labels go through safe() and lose quotes, so a name cannot
 * add Mermaid syntax. */
export function graphsMermaid(graphs) {
  const shown = graphs.filter(g => g?.indexed);
  if (!shown.length) return [];
  const ids = new Map();
  const label = text => safe(String(text)).replace(/["`<>]/g, '');
  const node = name => {
    const key = label(name);
    if (!ids.has(key)) {
      ids.set(key, 'n' + ids.size);
      out.push(`  ${ids.get(key)}["${key}"]`);
    }
    return ids.get(key);
  };
  const out = ['```mermaid', 'flowchart LR'],
    edges = [],
    changed = [];
  for (const g of shown) {
    const sym = node(g.symbol);
    changed.push(sym);
    for (const c of g.callers.slice(0, GRAPH_LIMIT)) edges.push(`  ${node(c.name)} --> ${sym}`);
    const more = (g.total ?? g.callers.length) - Math.min(g.callers.length, GRAPH_LIMIT);
    if (more > 0) edges.push(`  ${node(`+${more} more callers of ${g.symbol}`)} --> ${sym}`);
    for (const c of g.callees.slice(0, GRAPH_LIMIT)) edges.push(`  ${sym} --> ${node(c.name)}`);
    for (const t of [...new Set(g.tests.map(t => t.name))].slice(0, 3)) edges.push(`  ${node(t)} -. tests .-> ${sym}`);
  }
  out.push(
    ...new Set(edges),
    '  classDef changed stroke-width:3px',
    `  class ${[...new Set(changed)].join(',')} changed`,
    '```',
  );
  return out;
}

/** The map of a change as terminal lines: callers, callees, tests, and a warning when no test reaches it. */
export function renderGraph(graph, { paint = (c, t) => t, icons = false, mermaid = false } = {}) {
  if (!graph) return [];
  const bar = paint('gray', '│'),
    tag = icons ? '🕸 ' : 'Map: ';
  if (!graph.indexed)
    return [
      `  ${bar} ${paint('gray', tag + '`' + graph.symbol + '` is not in the CodeGraph index yet (a new symbol is indexed a second later).')}`,
    ];
  const at = n => `${safe(n.name)} ${paint('gray', '(' + safe(String(n.file).split('/').pop()) + ':' + n.line + ')')}`;
  const out = [
    `  ${bar} ${paint('blue', tag + 'Map of `' + graph.symbol + '`')} ${paint('gray', '(CodeGraph, ' + graph.file + ':' + graph.line + ')')}`,
  ];
  if (graph.callers.length || graph.callees.length)
    for (const line of graphDiagram(graph, paint)) out.push(`  ${bar}    ${line}`);
  out.push(
    `  ${bar}    ${paint('blue', '← called by')} ${graph.callers.length ? graph.callers.slice(0, 4).map(at).join(', ') + (graph.total > 4 ? paint('gray', ` and ${graph.total - 4} more`) : '') : paint('gray', 'nothing in the index: new, unused, or called by name at run time')}`,
  );
  if (graph.callees.length)
    out.push(
      `  ${bar}    ${paint('blue', '→ uses')} ${graph.callees
        .slice(0, 5)
        .map(n => safe(n.name))
        .join(', ')}`,
    );
  if (graph.affectedFiles)
    out.push(
      `  ${bar}    ${paint('blue', '⇢ reaches')} ${graph.affectedFiles} other file${graph.affectedFiles === 1 ? '' : 's'} within 3 steps`,
    );
  if (graph.tests.length)
    out.push(
      `  ${bar}    ${paint('green', (icons ? '🧪 ' : '') + graph.tests.length + (graph.tests.length === 1 ? ' test reaches it' : ' tests reach it'))} ${paint('gray', '(' + [...new Set(graph.tests.map(t => t.file))].slice(0, 3).join(', ') + ')')}`,
    );
  else
    out.push(
      `  ${bar}    ${paint('yellow', (icons ? '⚠️ ' : '') + 'No test reaches `' + graph.symbol + '`: how would you know that it works? Read this change first.')}`,
    );
  if (mermaid) for (const line of graphsMermaid([graph])) out.push(`  ${bar}    ${paint('gray', line)}`);
  return out;
}
