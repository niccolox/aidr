# aidr

Follow your Claude Code sessions in the terminal and understand their code changes. Version 0.1.0.

```sh
npx devekko.aidr              # or: npm install -g devekko.aidr, then aidr
aidr                          # each step, and each code change explained (Ctrl+C stops)
aidr --changes                # only the significant changes: planned, in process, completed
aidr --busywork               # the raw log: every step, and Claude's text in full
aidr list                     # the sessions in operation
aidr stage HEAD~3..HEAD       # the Pydantic models in play and the CodeGraph changes of a range
aidr --help
```

## What it reads

The process list (your own processes only), the Claude Code transcripts under `~/.claude/projects` (or
`$CLAUDE_CONFIG_DIR/projects`), and `git` in each session's folder. With `python3` on the PATH it reads the
Pydantic models of the folder with Python's ast (no code of the folder runs). With `codegraph` on the PATH and a
`.codegraph/` index it shows the code graph of each changed function.

## What it never does

It writes no file, opens no network connection, sends no telemetry and starts no server. It never shows a private file
(`.env` files, SSH, cloud and Claude credentials, keys, `*.tfvars` and more), and it masks tokens, keys, passwords and
URL passwords in every line it prints. It removes terminal control bytes, so a file or a prompt cannot write to your
clipboard or change your screen. Add your own private globs, one on each line, to `~/.config/devekko.aidr/private`.

## Requirements

Node 20 or later, `git`; optional `python3` and `codegraph`. Linux and macOS.

## Licence

GNU Affero General Public License v3.0 only (AGPL-3.0-only). See LICENSE.
