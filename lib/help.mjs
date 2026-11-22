// SPDX-License-Identifier: AGPL-3.0-only
/** The help of aidr: one line, an explanation of two paragraphs and an example for aidr itself, each command and each
 * flag (owner, 22 November 2026: "aidr --help useful one line explaining usage, aidr --explain with an explanation 2
 * paragraphs long, aidr --example with an example ... aidr --security --help, --explain, --example").
 *
 *   aidr --help                 the usage line, then one line for each command and each flag
 *   aidr --explain | --example  two paragraphs about aidr | an example
 *   aidr --security --help      one line about --security; --explain and --example the same for that topic
 *   aidr journal --example      a command is a topic too; several topics give one part each */

/** A topic: kind (command, flag or aidr), the line of --help, the two paragraphs of --explain and the lines of
 * --example (a command, then what it prints). A command that is also a flag has a flag line too. */
export const TOPICS = {
  aidr: {
    kind: 'aidr',
    line: 'Run aidr in a second terminal next to Claude Code: it shows each step and each code change as it happens.',
    explain: [
      'aidr follows the Claude Code sessions in this folder. It reads their transcripts under ~/.claude/projects and git in the session folder, and it prints each step and each code change as Claude makes it. It writes no file, starts no server and sends no telemetry. It masks secrets, hides private files such as .env and SSH keys, and removes terminal control bytes from what it prints.',
      'The watch starts minimal: each step on one line, and each code change as one line with its file and line counts. Each flag adds one view, and the flags add up, so aidr --code --map --security shows the diff, the code graph and a Security card for each change. The commands list, agents, stage and journal print one report and stop. Add --help, --explain or --example after any flag or command to read about it.',
    ],
    example: [
      '$ aidr --code --commands',
      'Folder: /home/you/shop and its subfolders (--global shows every folder).',
      '10:14:02  shop  💻 Bash | Run the tests',
      '           $ uv run pytest -q tests/test_cart.py',
      '10:14:09  shop  📝 Edit | app/cart.py',
      '  │ app/cart.py +2 −1',
      '  │ Why: the total must count the quantity of each item.',
    ],
  },
  list: {
    kind: 'command',
    line: 'prints the Claude Code sessions in operation once: the folder, the title, each process and the last step.',
    explain: [
      'aidr list finds the claude processes of your user and the transcript that each one writes. For each session it prints the folder, the title of the conversation, the process ids, the commands in operation, the last prompt and the last step. It stops after one report.',
      'Without --global it lists only the sessions of this folder and its subfolders. Use it to see which sessions run before you start the watch, or to find a session that stopped answering.',
    ],
    example: [
      '$ aidr list',
      'shop  "Fix the cart total"  58f45bf6',
      '  process 15513  started 2.3 h ago  1 command in operation (oldest 0 s)',
      '  last prompt 11:31:56  fix the cart total',
      '  last step   11:32:06  Edit | app/cart.py',
    ],
  },
  agents: {
    kind: 'command and flag',
    line: 'prints the agent map once: each session, its subagents, their state and heartbeat.',
    flag: 'prints the agent map in the watch at the start and every 10 minutes.',
    explain: [
      'The agent map has one row for each session and one row for each subagent that it started. Each agent has a state from its transcript: running (a line in the last 3 minutes), quiet (3 to 10 minutes), stalled (more than 10 minutes), finished or failed. The row also gives its age, its tool calls, its heartbeat (the time of its last line), its last step, and the commits and open files of its worktree.',
      'An agent is finished when the session gets its end notice, when it hands its report back, or when Claude Code marks it finished. aidr agents prints the map once and stops; in the watch, --agents prints it at the start and every 10 minutes, so you can see which agents still work.',
    ],
    example: [
      '$ aidr agents',
      '11:14:59  Agent map: 1 session, 2 running, 1 finished (every 10 min)',
      'shop  "Fix the cart total"  58f45bf6',
      '    ├ running  Cart tests  age 12 min, 40 steps, heartbeat 20 s ago',
      '    │   last step: Bash | Run the cart tests',
      '    └ finished Review the diff  age 30 min, 18 steps, heartbeat 9 min ago',
    ],
  },
  stage: {
    kind: 'command and flag',
    line: '[commit|a..b] reports the Pydantic models in play and the CodeGraph changes of a commit or a range.',
    flag: 'prints the stage report in the watch after each new commit.',
    explain: [
      'The stage report reads the files of a commit or a range of commits. It lists the Pydantic models that the changed Python code defines or uses, with their fields, and the functions that CodeGraph shows as changed, with their callers and callees. It reads the models with the ast module of Python, so no code of your project runs.',
      'aidr stage HEAD~3..HEAD prints the report once. In a terminal it draws the models and the graph; in a pipe or a file it writes Markdown with Mermaid text, ready for a pull request. In the watch, --stage prints the report each time a new commit appears in a session folder.',
    ],
    example: [
      '$ aidr stage HEAD',
      '# Stage report: 1 commit',
      '## Pydantic models in play',
      '- CartItem (app/cart.py): price: Decimal, quantity: int',
      '## CodeGraph changes',
      '- total (app/cart.py): called by checkout, calls CartItem',
    ],
  },
  journal: {
    kind: 'command',
    line: '[day|week|month|project] prints a Markdown journal of this folder; --learn and --security add the cards of the day.',
    explain: [
      'The journal reads the transcripts and the git history of this folder for one period. A day has the sessions with their tokens and cost at API list price, the prompts, the changes planned, in process and completed, the commits, the test runs, the long commands, and the files, functions and models that changed most. A week or a month has one short part for each day; project gives the lifecycle by month.',
      'It prints Markdown and writes no file, so aidr journal week > week.md keeps it. --date YYYY-MM-DD gives another day. With --learn or --security, the journal of a day asks local Claude again for the cards of that day changes and adds a Cards part; at most 8 cards of each kind.',
    ],
    example: [
      '$ aidr journal --security',
      '# Journal of shop: Sunday 22 November 2026',
      '## Sessions',
      '- `58f45bf6` · 09:02 to 11:40 · 14 prompts · 2.1 M tokens · $4.10',
      '## Cards',
      '### 🛡️ Security · high · SQL injection through the search term',
    ],
  },
  code: {
    kind: 'flag',
    line: 'shows the diff of each code change, with Claude’s reason, notes on what to read and one question.',
    explain: [
      'Without --code, a code change is one line with its file and line counts. With --code, aidr prints the first changed lines of the diff, the reason that Claude gave in its last text, notes on the kind of change and one question to check that you understand it. It also follows git in the session folder, so changes made outside Claude show too.',
      'A file outside the session folder shows its path and counts only, unless you add --outside. A private file never shows its lines. Add --full-diff for every changed line in place of the first 14.',
    ],
    example: [
      '$ aidr --code',
      '  │ app/cart.py  Edit  +2 −1',
      '  │ Why: the total must count the quantity of each item.',
      '  │ - return sum(item.price for item in items)',
      '  │ + return sum(item.price * item.quantity for item in items)',
      '  │ Ask yourself: what happens when quantity is 0?',
    ],
  },
  'full-diff': {
    kind: 'flag',
    line: 'shows every changed line of a code change, not the first 14; it turns on --code.',
    explain: [
      'The code view stops after the first 14 changed lines of a change and counts the rest. --full-diff prints every changed line, so a long change shows completely. It turns on --code, so you do not need both.',
      'Use it when you review a large refactor line by line, or when the first 14 lines hide the part that matters. Secrets stay masked and private files stay hidden, as in the short view. A very long change can fill the screen, so combine it with --plain when you keep the output in a file.',
    ],
    example: ['$ aidr --full-diff', '  │ app/cart.py  Edit  +42 −30', '  │ (all 72 changed lines follow)'],
  },
  map: {
    kind: 'flag',
    line: 'draws the CodeGraph map of each changed function: its callers and the functions it calls.',
    explain: [
      'With CodeGraph installed and a .codegraph/ index in the project, --map asks CodeGraph for the function that a change touched. aidr then draws its callers and its callees, so you see what the change can break. The index follows a write about a second later, so the map comes a moment after the change.',
      'In a terminal aidr draws the map with box characters, one arrow for each call. Add --mermaid for the Mermaid text, which GitHub draws in a pull request. Without a .codegraph/ index in the project, --map shows nothing; run codegraph init in the project to make one.',
    ],
    example: ['$ aidr --map', '  │ checkout ──▶ total ──▶ CartItem', '  │ invoice  ──▶ total'],
  },
  ontology: {
    kind: 'flag',
    line: 'lists the Pydantic models that each Python change defines or uses, with their fields.',
    explain: [
      'For a Python change, aidr reads the session folder with the ast module of Python and finds the Pydantic models that the changed code defines or uses. It prints each model with its fields and the models it links to. No code of your project runs.',
      'It needs python3 on the PATH, and it reads only files inside the session folder. The first Python change of a session can wait about 10 seconds while aidr reads the models of the folder. Add --mermaid for the models as a Mermaid class diagram.',
    ],
    example: [
      '$ aidr --ontology',
      '  │ 🐍 CartItem (app/cart.py)',
      '  │    price: Decimal · quantity: int = Field(ge=1)',
    ],
  },
  mermaid: {
    kind: 'flag',
    line: 'adds the Mermaid text of the code maps and the models, ready to paste into GitHub.',
    explain: [
      'A terminal cannot draw Mermaid, so aidr draws the maps and the models itself with box characters. --mermaid adds the Mermaid text next to each drawing: a flowchart for a code map and a classDiagram for the models.',
      'Paste the text into a pull request, an issue or a document, and GitHub draws it. aidr stage in a pipe or a file writes the Mermaid text by default, so aidr stage HEAD > stage.md gives a report that draws on GitHub. In the watch, --mermaid has an effect only with --map, --ontology or --stage.',
    ],
    example: ['$ aidr --map --mermaid', '```mermaid', 'flowchart LR', '  checkout --> total --> CartItem', '```'],
  },
  progress: {
    kind: 'flag',
    line: 'shows the time and the last output line of long tool calls and background commands.',
    explain: [
      'A long test run or a background command can run for minutes with no new step. --progress prints a line once a minute for each one that still runs, with its time and the last line of its output. When a background command ends, it prints how long it took.',
      'Use it to see that a long command still makes progress, and to see its last output without a second terminal. aidr reads the output file that Claude Code keeps for a background command; it never runs the command again. A tool call that ends prints no more lines.',
    ],
    example: ['$ aidr --progress', '10:20:00  shop  ⏳ Still running 4:12 | Run the full test suite → 412 passed'],
  },
  commands: {
    kind: 'flag',
    line: 'shows the command lines of each shell step under its description, with secrets masked.',
    explain: [
      'Without --commands, a shell step shows the description that Claude gave it. With --commands, aidr also prints the command lines: at most 12 lines, or 120 with --busywork. Tokens, keys and passwords in the command are masked.',
      'Use it to see what Claude runs on your computer, step by step, before you trust a result. A command of more lines shows its first 12 and the count of the rest. aidr prints only the command, never its output, so a secret in the output does not show.',
    ],
    example: [
      '$ aidr --commands',
      '10:14:02  shop  💻 Bash | Run the tests',
      '           $ uv run pytest -q tests/test_cart.py',
    ],
  },
  changes: {
    kind: 'flag',
    line: 'adds the change events next to the steps: each change planned, in process and completed.',
    explain: [
      'aidr reads the plans, the task lists and the edits of a session and turns them into change events. A change is planned when it enters a plan or a task list, in process when Claude starts it, and completed when its task is done.',
      'With --changes the events show next to the steps, so you see where the work is in its plan. A change that stays in process for a long time can show that Claude is stuck on it. The journal uses the same events for its Changes part.',
    ],
    example: [
      '$ aidr --changes',
      '10:12:40  shop  📋 Planned · Count the quantity in the cart total',
      '10:14:09  shop  🔧 In process · Count the quantity in the cart total',
    ],
  },
  busywork: {
    kind: 'flag',
    line: 'prints every step, Claude’s text and each prompt in full, as formatted Markdown.',
    explain: [
      'The minimal watch prints the first line of each text and each prompt. --busywork prints them in full, up to 2,000 characters, as formatted Markdown, and command lines up to 120 lines.',
      'It is the raw log of a session, for the times when you want to read every word that Claude wrote. It fills the screen fast, so it is best in a wide terminal or with output to a file. Combine it with --all for every view, as aidr --all does.',
    ],
    example: [
      '$ aidr --busywork',
      '10:14:20  shop  💬 Claude',
      '           │ The total now counts the quantity. The tests pass.',
    ],
  },
  all: {
    kind: 'flag',
    line: 'turns on every view flag; --learn and --security stay off unless you name them, as they call a model.',
    explain: [
      '--all is the same as --code --full-diff --map --ontology --stage --progress --agents --commands --changes --busywork. It shows everything that aidr can show without a model.',
      'The cards call local Claude or Workers AI, which takes time and can cost money, so --all leaves them out. Add them by name: aidr --all --learn --security. --all also leaves out the scope flags --global and --outside, and the format flags --mermaid and --plain.',
    ],
    example: ['$ aidr --all --security'],
  },
  learn: {
    kind: 'flag',
    line: 'adds a Learn card under each code change: a memory aid, one line of advice and links to official docs.',
    explain: [
      'Fixed patterns find the kind of change, for example a Pydantic model, a FastAPI route, an SQL call or a regular expression. For that kind, local Claude writes a card with a memory aid, one line of advice, a link to the official docs and one tutorial. When the claude CLI is not on your PATH, Gemma on Workers AI writes it with your own AIDR_CF_ACCOUNT_ID and AIDR_CF_API_TOKEN.',
      'aidr checks each card before it prints it: the links must be on a list of official sites, and a card that fails does not show. The request holds the kind of change, the language and the names of the changed function and models; add --learn-code to send the changed lines too, with secrets masked.',
    ],
    example: [
      '$ aidr --learn',
      '  │ 📚 Learn · a Pydantic model or Field · app/cart.py',
      '  │    FVC · Fields typed, Validate with Field, Compute from fields',
      '  │    Keep each rule on the model field, so a bad value fails where it enters.',
      '  │    Docs:     https://docs.pydantic.dev/latest/concepts/fields/',
    ],
  },
  'learn-code': {
    kind: 'flag',
    line: 'is --learn, and the request also holds the changed lines, with secrets masked.',
    explain: [
      'By default a Learn request holds no code: only the kind of change, the language and the names. --learn-code adds the changed lines, at most 40, so the advice can fit the code.',
      'Secrets are masked first, and a private file is never sent. With local Claude the lines go to the claude CLI with your own sign-in; with Gemma they go to Workers AI with your own keys. It turns on --learn, so you do not need both.',
    ],
    example: ['$ aidr --learn-code'],
  },
  security: {
    kind: 'flag',
    line: 'adds a Security card under each change at a trust boundary: impact, threat, fix, NIST SSDF practice, link.',
    explain: [
      'Fixed patterns put each change into one security domain: build and dependencies, cloud deployment, LLM calls, data access, HTTP and sessions, HTML output, sockets and webhooks, processes, or limits. A change in no domain gets no card. For a change in a domain, local Claude reads the changed lines with the core discipline of that domain from Cloudflare’s security-audit skill (in ~/.claude/skills/security-audit, or a built-in discipline without it). It answers with the impact (none, low, medium or high), the threat, what a lower-trust party can now do, one fix, a practice of the NIST SP 800-218 Secure Software Development Framework v1.1, and a link to OWASP, CWE, NIST, CISA or the Cloudflare docs.',
      'aidr checks each card before it prints it, and a card that fails does not show. The request holds the path relative to the session folder and the changed lines, with secrets masked; a private file is never sent. It needs the claude CLI on your PATH; AIDR_SECURITY_MODEL sets the model (haiku by default). A card is a first read, not an audit: medium and high need a reachable path in the lines.',
    ],
    example: [
      '$ aidr --security',
      '  │ 🛡️ Security · high SQL injection through the search term · data access and tenant scope · app/search.py',
      '  │    The search term is now pasted into the SQL string instead of bound as a parameter.',
      '  │    Fix:  Restore the bound parameter, and add a test with a quote in the term.',
      '  │    SSDF: PW.5 Create source code by adhering to secure coding practices',
      '  │    Link: https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html',
    ],
  },
  global: {
    kind: 'flag',
    line: 'follows the sessions of every folder, not only this folder and its subfolders.',
    explain: [
      'By default aidr follows only the sessions that run in the current folder or a subfolder. --global follows every Claude Code session of your user on this computer. --cwd <folder> follows another folder in place of the current one.',
      'Each step line names the folder of its session, so you can tell the sessions apart. aidr list --global and aidr agents --global work the same way. A session of another user is never shown: aidr reads only your own processes and transcripts.',
    ],
    example: [
      '$ aidr --global',
      '10:14:02  shop  💻 Bash | Run the tests',
      '10:14:05  blog  📝 Edit | posts/launch.md',
    ],
  },
  outside: {
    kind: 'flag',
    line: 'shows the changed lines of files outside the session folder, which otherwise show their path only.',
    explain: [
      'A session can edit files outside its folder, for example a file in your home folder. By default aidr shows the path and the line counts of such a change, not its lines. --outside shows the lines too.',
      'Use it when a session edits shared configuration, for example a file in ~/.config. Private files stay hidden, with or without --outside, and secrets stay masked. It has an effect only with --code.',
    ],
    example: ['$ aidr --code --outside'],
  },
  plain: {
    kind: 'flag',
    line: 'prints no colours and no icons, for a log file or a screen reader.',
    explain: [
      'aidr uses colours and icons in a terminal, so each kind of step is easy to see. --plain turns both off and keeps the same lines. In a pipe or a file aidr prints plain text without --plain.',
      'Use it for a log file, a screen reader, or a terminal that shows icons badly. NO_COLOR in the environment also turns the colours off. The journal and the stage report also take --plain.',
    ],
    example: ['$ aidr --plain', '10:14:02  shop  Bash | Run the tests'],
  },
};

/** The other names of a topic. */
const ALIASES = { heartbeat: 'agents' };

/** The topics that the arguments name: flags as --name, commands as bare words. A flag that is no topic is returned
 * apart; another bare word (a period, a commit) is not a topic and is left out. */
export function topicsOf(args) {
  const named = args.filter(a => !['--help', '-h', '--explain', '--example', '--cwd'].includes(a));
  const flags = named.filter(a => a.startsWith('--')).map(a => ALIASES[a.slice(2)] || a.slice(2));
  const words = named.filter(a => !a.startsWith('-') && TOPICS[a]?.kind.startsWith('command'));
  return { topics: [...new Set([...words, ...flags.filter(n => TOPICS[n])])], unknown: flags.filter(n => !TOPICS[n]) };
}

const label = name => (name === 'aidr' ? 'aidr' : TOPICS[name].kind === 'flag' ? '--' + name : name);

/** aidr --help: the usage line, the commands and the flags, one line each. */
export function helpLines(version) {
  const width = 14,
    row = (name, text) => `  ${label(name).padEnd(width)} ${text}`;
  const commands = Object.keys(TOPICS).filter(n => TOPICS[n].kind.startsWith('command'));
  const flags = Object.keys(TOPICS).filter(n => TOPICS[n].kind.includes('flag'));
  return [
    `aidr ${version}: ${TOPICS.aidr.line}`,
    'Usage: aidr [list|agents|stage|journal] [--flag ...]. The flags add up: aidr --code --map --security.',
    '',
    'Commands',
    ...commands.map(n => row(n, TOPICS[n].line)),
    '',
    'Flags',
    ...flags.map(n => `  ${('--' + n).padEnd(width)} ${TOPICS[n].flag || TOPICS[n].line}`),
    '  --cwd <folder> follow another folder in place of the current one.',
    '  --version      the version of aidr.',
    '',
    'More about one part: aidr --security --help, aidr --security --explain, aidr --security --example.',
    'More about aidr: aidr --explain, aidr --example.',
  ];
}

/** --help, --explain or --example for the named topics, or for aidr itself. null when a name is not a topic. */
export function topicLines(mode, args, version) {
  const { topics, unknown } = topicsOf(args);
  if (unknown.length) return null;
  if (!topics.length) {
    if (mode === 'help') return helpLines(version);
    topics.push('aidr');
  }
  const out = [];
  for (const name of topics) {
    const t = TOPICS[name];
    if (mode === 'help') {
      out.push(`${name === 'aidr' ? 'aidr' : 'aidr ' + label(name)}: ${t.line}`);
      if (t.flag) out.push(`aidr --${name}: ${t.flag}`);
    } else if (mode === 'explain') out.push(`${label(name)}`, '', t.explain[0], '', t.explain[1], '');
    else out.push(`Example of ${label(name)}:`, '', ...t.example, '');
  }
  if (mode === 'help' && topics.length) {
    const first = label(topics[0]);
    out.push(
      `More: aidr ${first === 'aidr' ? '' : first + ' '}--explain, aidr ${first === 'aidr' ? '' : first + ' '}--example.`,
    );
  }
  while (out.at(-1) === '') out.pop();
  return out;
}
