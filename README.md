<p align="center">
  <img src="https://raw.githubusercontent.com/niccolox/aidr/main/docs/logo.svg" alt="aidr" width="96" height="96">
</p>

<h1 align="center">aidr</h1>

<p align="center"><b>See what Claude Code changed, and why.</b></p>

<p align="center">
  <a href="https://niccolox.github.io/aidr/">Website</a> ·
  <a href="#install-from-source">Install from source</a> ·
  <a href="SECURITY.md">Security</a> ·
  AGPL-3.0-only · version 0.1.0
</p>

aidr runs in a second terminal next to Claude Code. For each edit, it shows the diff, the reason Claude gave, a note
on what to check, and one question to answer before you go on. It reads; it writes nothing.

```text
10:42:07  shop  🔧 In process · Edit
  ✏️  app/cart.py  +1 -1
  │ 💭 Why: The total ignored the quantity of each line, so two mugs cost the price of one.
  │   def total(items):
  │ -     return sum(i.price for i in items)
  │ +     return sum(i.price * i.quantity for i in items)
  │ 📘 Changes what a function gives back: check every place that reads its result.
  │ ❓ Check yourself: Why was this change needed? Use the "Why" line, then say it in your own words.
```

## Why use it

Claude Code edits files faster than you can read them. After an hour of work, your repository holds code that you
did not write and may not be able to explain. aidr puts each change in front of you at the time Claude makes it, with
the reason next to the lines.

## Install from source

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

## What it shows

| Command | What you see |
| --- | --- |
| `aidr` | Each step of the sessions in this folder, and each code change with the reason, a note and a question |
| `aidr --changes` | Only the significant changes: planned, in process and completed |
| `aidr --busywork` | The raw log: every step, Claude's text and each prompt in full, as formatted Markdown |
| `aidr list` | The Claude Code sessions in operation, once |
| `aidr stage HEAD~3..HEAD` | The Pydantic models in play and the CodeGraph changes of a commit or a range |
| `aidr --global` | Every folder, not only this one |

With [CodeGraph](https://github.com/colbymchenry/codegraph) and a `.codegraph/` index, aidr draws the callers and
callees of each changed function. With `python3` on the PATH, it lists the Pydantic models that a change touches,
with their fields and links (`--mermaid` adds a Mermaid diagram). Long tool calls and background commands show their
time and their last line of output.

Run `aidr --help` for all options.

## What it reads, and what it never does

aidr reads three things: your own processes, the Claude Code transcripts under `~/.claude/projects` (or
`$CLAUDE_CONFIG_DIR/projects`), and `git` in each session's folder. It reads Python models with Python's `ast` module,
so no code of your project runs.

- It writes no file, opens no network connection, sends no telemetry and starts no server.
- It never shows a private file: `.env` files, SSH keys, cloud and Claude credentials, `*.tfvars` and more. Add your
  own globs, one on each line, to `~/.config/devekko.aidr/private`.
- It masks tokens, keys, passwords and URL passwords in every line it prints.
- It removes terminal control bytes, so a file or a prompt cannot write to your clipboard or change your screen.

The package is about 1,600 lines of JavaScript and Python, with no dependencies and no install script. Read
[lib/](lib/) before you run it.

## Requirements

- Node 20 or later, and `git`.
- Optional: `python3` (Pydantic models), `codegraph` (the code graph).
- Linux or macOS.

## Questions

**Does it send my code anywhere?** No. aidr opens no network connection. The tests check this.

**Does it change my files or my sessions?** No. It only reads transcripts and runs read-only `git` commands.

**Does it work with other coding agents?** Not now. It reads the transcript format of Claude Code.

**Why AGPL-3.0?** You can use, change and share aidr. If you give a changed version to others, or run it for others
over a network, you share your changes under the same licence.

## Licence

GNU Affero General Public License v3.0 only (AGPL-3.0-only). See [LICENSE](LICENSE).
