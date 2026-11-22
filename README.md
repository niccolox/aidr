<p align="center">
  <img src="https://raw.githubusercontent.com/niccolox/aidr/main/docs/logo.svg" alt="aidr" width="96" height="96">
</p>

<h1 align="center">aidr</h1>

<p align="center"><b>👀 See what Claude Code changed, and why.</b></p>

<p align="center">
  <a href="https://www.niccolox.com/aidr/">Website</a> ·
  <a href="#install-from-source">Install from source</a> ·
  <a href="SECURITY.md">Security</a> ·
  AGPL-3.0-only · version 0.1.0
</p>

aidr runs in a second terminal next to Claude Code. For each edit, it shows the diff, the reason Claude gave, a note
on what to check, and one question to answer before you go on. It shows each shell command Claude runs, and a map
of every agent with its heartbeat. It reads; it writes nothing. 🔒

```text
10:42:07  shop  🔧 In process · Edit
  ✏️  app/cart.py  +1 -1
  │ 💭 Why: The total ignored the quantity, so two mugs cost the price of one.
  │   def total(items):
  │ -     return sum(i.price for i in items)
  │ +     return sum(i.price * i.quantity for i in items)
  │ 📘 Changes what a function gives back: check every place that reads its result.
  │ ❓ Check yourself: Why was this change needed? Use the "Why" line, then say it in your own words.
```

## 🤔 Why use it

Claude Code edits files faster than you can read them. After an hour of work, your repository holds code that you
did not write and may not be able to explain. aidr puts each change in front of you at the time Claude makes it, with
the reason next to the lines.

## 📦 Install from source

The npm package `devekko.aidr` is not published yet. Install it from this repository:

```sh
git clone https://github.com/niccolox/aidr.git
cd aidr
npm test                 # no dependencies to install
npm link                 # puts the aidr command on your PATH
```

Then, in the folder where Claude Code works:

```sh
cd ~/code/your-project
aidr
```

To run it without `npm link`, use `node /path/to/aidr/bin/aidr.mjs`. To update, run `git pull` in the clone. To
remove the command, run `npm unlink -g devekko.aidr`.

## 🔍 What it shows

| Command | What you see |
| --- | --- |
| 🧑‍🏫 `aidr` | The minimal watch: each step of the sessions in this folder on one line, and each code change as one line with its file and line counts |
| 📋 `aidr list` | The Claude Code sessions in operation, once |
| 💓 `aidr agents` | The agent map: each session and the subagents it started, running, quiet, stalled, finished or failed, with each one's heartbeat, last step, commits and open files. The watch prints it at the start and every 10 minutes |
| 🧬 `aidr stage HEAD~3..HEAD` | The Pydantic models in play and the CodeGraph changes of a commit or a range |
| 📓 `aidr journal [day\|week\|month\|project]` | A journal of the folder as Markdown: sessions, prompts, changes, commits, tests, files and models; `project` gives the lifecycle. `--date YYYY-MM-DD` for another day. `aidr journal --learn --security` adds the cards of the day's changes |

### 🎛️ Flags add up

The watch starts minimal. Each flag turns on one view, and you can combine them: `aidr --code --map --security`.

| Flag | What it adds |
| --- | --- |
| 🧑‍🏫 `--code` | The diff of each change, with Claude's reason, a note and a question. `--full-diff` shows every changed line |
| 🗺️ `--map` | The CodeGraph map of each changed function |
| 🐍 `--ontology` | The Pydantic models that each Python change defines or uses |
| 🧜 `--mermaid` | The Mermaid text of the maps and models, next to the drawings |
| 🧬 `--stage` | The stage report after each commit |
| ⏳ `--progress` | The time and last output line of long tool calls and background commands |
| 💓 `--heartbeat` | The agent map at the start and every 10 minutes |
| 🐚 `--commands` | The command lines of each shell step, with secrets masked |
| 🎯 `--changes` | The change events: planned, in process and completed |
| 🗂️ `--busywork` | Every step, Claude's text and each prompt in full |
| 🧰 `--all` | Every flag above |
| 📚 `--learn` | A Learn card under each code change: a memory aid, one line of advice, a link to the official docs and one tutorial. Local Claude writes it when the `claude` CLI is on your PATH, else Gemma on Workers AI with your own Cloudflare keys |
| 🛡️ `--security` | A Security card under each change at a trust boundary: the impact, the threat, one fix, the NIST SSDF practice and a link. Local Claude writes it with Cloudflare's security-audit skill |
| 🌐 `--global` | Every folder, not only this one. `--outside` shows the lines of files outside it |

`--all` leaves out `--learn` and `--security`, because they call a model: name them too, as in `aidr --all --security`.
A card that does not come says why in one line. The old `--no-*` flags are gone: aidr stops and names the flag
that now turns the view on.

With [CodeGraph](https://github.com/colbymchenry/codegraph) and a `.codegraph/` index, aidr draws the callers and
callees of each changed function. With `python3` on the PATH, it lists the Pydantic models that a change touches,
with their fields and links. Long tool calls and background commands show their time and their last line of output.

In a terminal, aidr draws the code graphs and the models itself, with box-drawing characters. In a pipe or a file
(`aidr stage HEAD > stage.md`), it writes them as Mermaid text (a `flowchart` and a `classDiagram`): paste it into a
pull request or a document and GitHub draws it. In the watch, `--mermaid` adds the Mermaid text. Run `aidr --help`
for all options.

## 🛰️ From a real session

These lines come from a real Claude Code session that ran pstack agents in parallel, captured with
`node tools/aidr/site/capture-real.mjs` (home folders shown as `~`, secrets masked).

The agent map (`aidr agents`):

```text
10:07:18  Agent map: 1 session, 2 running, 12 finished (every 10 min)
  saasx2x.ontology  "Pstack plugin"  58f45bf6  last line 0 s ago
    ├ finished Comment Sicko on directory modules  age 5 min, 18 steps, heartbeat 3 min ago
    ├ finished Comment Sicko on parity pin  age 9 min, 14 steps, heartbeat 8 min ago
    ├ running  DIR-REV-1 R2 models, budget, failures  age 18 min, 116 steps, heartbeat 21 s ago  1 commit, 2 open fil…
    │   last step: Bash | Read the refresh test fakes and the draft unit tests
    ├ running  Deslop the storefront public directory  age 25 min, 139 steps, heartbeat 31 s ago  5 commits, 5 open f…
    │   last step: Bash | Read the views fallback test
    ├ finished Inventory spec-stage agents  age 11.4 h, 53 steps, heartbeat 11.3 h ago
    ├ finished Inventory research job agents  age 11.4 h, 60 steps, heartbeat 11.3 h ago
    ├ finished Inventory support and merchant agents  age 11.4 h, 53 steps, heartbeat 11.3 h ago
    ├ finished Research primary pattern sources  age 11.4 h, 103 steps, heartbeat 11.3 h ago
    ├ finished Research agentic workflow patterns  age 11.4 h, 65 steps, heartbeat 11.0 h ago
    ├ finished React island support case page  age 11.6 h, 185 steps, heartbeat 10.9 h ago
    ├ finished Rewrite submission decision tests  age 11.6 h, 17 steps, heartbeat 11.5 h ago
    ├ finished Hono JSX pilot on capital research  age 11.9 h, 183 steps, heartbeat 11.5 h ago
    ├ finished Directory UX overlap A3 A4 phase 4  age 12.4 h, 375 steps, heartbeat 11.2 h ago
    └ finished R1 Prefect directory-agent flow  age 12.5 h, 152 steps, heartbeat 11.4 h ago
```

Shell steps with their commands (`aidr`):

```text
10:07:22  saasx2x.ontology  Bash | Read the site page sections and the sample layout
    $ cd ~/Projects/saasx2x.ontology; grep -n "<section\|<h2\|<nav\|href=\"#" tools/aidr/site/index.html | cut -c1-17…
10:07:25  saasx2x.ontology  Bash | Read the journal and commands sections of the page
    $ cd ~/Projects/saasx2x.ontology; sed -n 288,301p tools/aidr/site/index.html | cut -c1-260; sed -n 302,322p tools…
10:07:44  saasx2x.ontology  Bash | Read the second capture result
    $ sleep 1; cat <tmp> 2>/dev/null; sed -n '/# commands/,$p' ~/Projects/saasx2x.ontology/tools/aidr/site/real-strea…
```

## 🔒 What it reads, and what it never does

aidr reads three things: your own processes, the Claude Code transcripts under `~/.claude/projects` (or
`$CLAUDE_CONFIG_DIR/projects`), and `git` in each session's folder. It reads Python models with Python's `ast` module,
so no code of your project runs.

- It writes no file, sends no telemetry and starts no server. It opens no network connection, except with `--learn`
  (below). A test checks the source for network and write calls.
- It never shows a private file: `.env` files, SSH keys, cloud and Claude credentials, `*.tfvars` and more. Add your
  own globs, one on each line, to `~/.config/devekko.aidr/private`.
- It masks tokens, keys, passwords and URL passwords in every line it prints.
- It removes terminal control bytes, so a file or a prompt cannot write to your clipboard or change your screen.

The package is about 4,400 lines of JavaScript and Python, formatted with Biome, with no dependencies and no install script. Read
[lib/](lib/) before you run it.

## 📓 Journal (`aidr journal`)

`aidr journal` prints what happened in the folder today: the Claude Code sessions, the prompts, the changes planned,
in process and completed, the commits, the tests and their result, the long commands, and the files, functions and
Pydantic models that changed most. `aidr journal week` and `aidr journal month` give one section for each day;
`aidr journal project` gives the lifecycle: one row for each month, the tags, the first and last change of each top
folder, and the open tasks. It prints Markdown and writes no file, so `aidr journal week > week.md` keeps it.

💰 Each day and each session also show their tokens and their cost at API list price, one row for each model, with
the tokens of the agents that a session started (they write their own transcripts). A reply that Claude Code writes as
several transcript entries counts once. A Claude Code subscription is billed differently.

## 📚 Learn cards (`--learn`)

`aidr --learn` adds one card under a code change: a memory aid, one line of advice, and links to the official docs and
one tutorial. 🤖 When the Claude Code CLI is on your PATH, local Claude writes each card with your own sign-in
(`claude -p` in the system temp folder, with no tools, no settings, no MCP servers and no saved session; `haiku` by
default, `AIDR_LEARN_CLAUDE_MODEL` to change it). Otherwise Gemma (`@cf/google/gemma-4-26b-a4b-it` on Workers AI)
writes it with your Cloudflare keys; `AIDR_LEARN_PROVIDER=workers-ai` keeps Gemma. aidr checks each card before it
prints it: the links must be on a list of official sites (docs.python.org, docs.pydantic.dev, nodejs.org,
developer.mozilla.org and more), and a card that fails the check does not show. There is at most one card for each
change, the same card at most once in 30 minutes, and at most 30 calls an hour.

## 🛡️ Security cards (`--security`)

`aidr --security` adds one card under each code change that touches a trust boundary. It gives the impact (none, low,
medium or high), the threat, what a lower-trust party can now do, one fix, the practice of the US government's
[NIST SP 800-218 Secure Software Development Framework (SSDF) v1.1](https://csrc.nist.gov/pubs/sp/800/218/final)
that the change touches, and a link to OWASP, CWE, NIST, CISA or the Cloudflare docs.

```text
  │ Security · high SQL injection through the search term · data access and tenant scope · app/search.py
  │    The search term is now pasted into the SQL string instead of bound as a parameter. A caller can add quote
  │    characters to change the query and read rows beyond the product search.
  │    Fix:  Restore the bound parameter. Do not build SQL with f-strings. Add a test with a quote in the term.
  │    SSDF: PW.5 Create source code by adhering to secure coding practices
  │    Link: https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
```

- 🧭 Fixed patterns choose the domain of the change: build and dependencies, cloud deployment, LLM calls, data
  access, HTTP and sessions, HTML output, sockets and webhooks, processes, or limits. A change in no domain gets no card.
- ☁️ The prompt holds the core discipline of that domain from Cloudflare's
  [security-audit skill](https://github.com/cloudflare/security-audit-skill), read from `~/.claude/skills/security-audit`
  (`AIDR_SECURITY_SKILL` for another folder). Without the skill, aidr uses a short built-in discipline.
- 🤖 Local Claude writes the card with your own sign-in, with the same locked-down `claude -p` call as `--learn`
  (`haiku` by default, `AIDR_SECURITY_MODEL` to change it). `--security` needs the `claude` CLI on your PATH.
- 🔒 The request holds the path relative to the session folder and the changed lines, with secrets masked. A private
  file is never sent. The prompt tells Claude that the lines are data, not instructions.
- ✅ aidr checks each card before it prints it: the impact, an SSDF v1.1 practice id, the lengths, plain words and a
  link on the allowlist. A card that fails does not show. At most one card for each file, function and domain, and
  at most 30 calls an hour.

A Security card is a first read, not an audit. Medium and high cards need a reachable path in the lines; when the lines
do not show it, the card says what to check.

## ⚙️ Requirements

- Node 20 or later, and `git`.
- Optional: `python3` (Pydantic models), `codegraph` (the code graph), the `claude` CLI (`--security`, and
  `--learn` without a Cloudflare account), and for `--learn` with Gemma a Cloudflare account with Workers AI: set
  `AIDR_CF_ACCOUNT_ID` and `AIDR_CF_API_TOKEN`. aidr never prints them.
- Linux or macOS.

## ❓ Questions

**Does it send my code anywhere?** No. Without `--learn`, aidr opens no network connection. With `--learn`, it sends
the kind of change, the language and the names of the changed function and models to Workers AI, with your own key.
It sends the changed lines only with `--learn-code`, with secrets masked, and never a private file. With
`--security`, it sends the relative path and the changed lines, with secrets masked, to your local `claude` CLI.

**Does it change my files or my sessions?** No. It only reads transcripts and runs read-only `git` commands.

**Does it work with other coding agents?** Not now. It reads the transcript format of Claude Code.

**Why AGPL-3.0?** You can use, change and share aidr. If you give a changed version to others, or run it for others
over a network, you share your changes under the same licence.

## ⚖️ Licence

GNU Affero General Public License v3.0 only (AGPL-3.0-only). See [LICENSE](LICENSE).
