# Changelog

## 0.1.0

- First release, extracted from the saasx2x.ontology repository (tools/aidr).
- Watch, change view and raw log; session list; stage report.
- Code changes with the reason, notes and a question; code highlights for JavaScript, Python and JSON.
- The Pydantic ontology at play and the CodeGraph map of each changed function.
- Progress of long-running tool calls and background commands.
- Code graphs as Mermaid flowcharts and Pydantic models as Mermaid class diagrams, by default (--no-mermaid).
- aidr --learn: a Learn card under each change, written by Gemma on Workers AI with your own keys; off by default.
- aidr journal: a day, week or month journal of a folder, and its project lifecycle, as Markdown.
- Security: safe() on every printed text, private paths, own-user processes, no writes; no network except --learn.
- Formatted with Biome.
- The command lines of each shell step, on by default, with secrets masked (--no-commands hides them).
- aidr agents: the agent map with each agent's state and heartbeat; the watch prints it every 10 minutes (--no-heartbeat).
- The watch is minimal by default. Every flag is positive and the flags add up; --all turns on every view. The old
  --no-* flags stop with the flag that replaces them.
- aidr journal --learn --security: the cards of the day's changes. A dropped card says why in one line.
- The README and the site show real output of a session with parallel agents (site/capture-real.mjs).
- aidr --learn uses local Claude when the claude CLI is on the PATH, else Gemma.
- aidr --security: a Security card under each change at a trust boundary, by local Claude with Cloudflare's
  security-audit skill, mapped to a practice of NIST SP 800-218 SSDF v1.1; off by default.
