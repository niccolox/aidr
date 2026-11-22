// SPDX-License-Identifier: AGPL-3.0-only
/** The report of one spec stage: the Pydantic models in play and the CodeGraph changes (aidr stage).
 *
 * Owner, 22 November 2026: "after every stage in the spec show the Pydantic models in play and show Codegraph
 * changes" (AGENTS.md, "Reporting work against a specification").
 *
 *   aidr stage                       the last commit
 *   aidr stage -- 974bfa17           one commit
 *   aidr stage -- a1b2c3d..HEAD      a range of commits (the stage)
 *
 * It prints two Markdown tables to paste under the spec table: the Pydantic models that the changed lines define or
 * use (ontology.py, read with ast: no code of the repository runs), and each changed function or class with its
 * callers, what it uses and the tests that reach it (CodeGraph). Read only: it runs git, the ontology reader and the
 * codegraph CLI, and writes no file. Names and lines pass through safe() (code-tutor.mjs). */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { graphDiagram, graphOf, graphsMermaid, safe, symbolOfChange } from './code-tutor.mjs';
import { OntologyReader, mermaidLines, namesOfChange } from './ontology.mjs';

// The folder of the report: the current folder (aidr stage, aidr stage), or --cwd.
const ROOT = process.env.INIT_CWD || process.cwd();
const CODE = /\.(py|mjs|js|ts)$/;

/** The changed hunks of a commit or range: [{file, before, after}] for code files, one entry for each hunk. */
export function parseDiff(text) {
  const out = [];
  let file = null,
    hunk = null;
  for (const line of String(text || '').split('\n')) {
    const head = line.match(/^\+\+\+ b\/(.+)$/);
    if (head) {
      file = CODE.test(head[1]) ? head[1] : null;
      hunk = null;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git')) continue;
    if (line.startsWith('@@')) {
      if (file) {
        hunk = { file, before: [], after: [] };
        out.push(hunk);
      }
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('-')) hunk.before.push(line.slice(1));
    else if (line.startsWith('+')) hunk.after.push(line.slice(1));
  }
  return out;
}

/** Marks each hunk that only moves code: every added line is also a removed line somewhere in the stage. */
// A comment line or a blank line is neither a move nor a change of code.
const codeLine = l => {
  const t = l.trim();
  return t && !/^(#|\/\/|\/\*|\*)/.test(t);
};
export function markMoves(hunks) {
  const removed = new Set(hunks.flatMap(h => h.before.filter(codeLine).map(l => l.trim())));
  const added = new Set(hunks.flatMap(h => h.after.filter(codeLine).map(l => l.trim())));
  for (const h of hunks) {
    const lines = h.after.filter(codeLine).map(l => l.trim()),
      gone = h.before.filter(codeLine).map(l => l.trim());
    h.moved = lines.every(l => removed.has(l)) && gone.every(l => added.has(l));
    h.changedAfter = h.after.filter(l => codeLine(l) && !removed.has(l.trim()));
    h.changedBefore = h.before.filter(l => codeLine(l) && !added.has(l.trim()));
  }
  return hunks;
}

/** The range for git: a single commit becomes <commit>~1..<commit>. */
export function rangeOf(arg) {
  const value = String(arg || 'HEAD');
  if (!/^[\w./~^-]+(\.\.[\w./~^-]+)?$/.test(value)) throw Error('Give a commit or a range such as a1b2c3d..HEAD.');
  return value.includes('..') ? value : `${value}~1..${value}`;
}

const cell = text => safe(String(text ?? '')).replace(/\|/g, '\\|');
const list = (items, max = 6) =>
  items.length
    ? items.slice(0, max).join(', ') + (items.length > max ? ` and ${items.length - max} more` : '')
    : 'none';

/** The two tables as Markdown lines. */
const DRAWN = 10,
  FIELDS = 8;

/** The models as trees, for a terminal: the name, the bases and the place, then the fields with links. */
export function modelDrawing(models) {
  const out = [];
  for (const m of models.slice(0, DRAWN)) {
    out.push(`${safe(m.name)} (${m.bases.map(safe).join(', ')})  ${safe(m.file)}:${m.line}`);
    const fields = m.fields.slice(0, FIELDS);
    fields.forEach((f, k) => {
      const branch = k === fields.length - 1 && m.fields.length <= FIELDS ? '└─' : '├─';
      const kind = f.models?.length
        ? `──▶ ${f.models.map(safe).join(', ')}`
        : `: ${safe(String(f.annotation ?? '')).slice(0, 60)}`;
      out.push(`${branch} ${safe(f.name)} ${kind}${m.changed?.includes(f.name) ? '  (changed)' : ''}`);
    });
    if (m.fields.length > FIELDS) out.push(`└─ … ${m.fields.length - FIELDS} more fields`);
    out.push('');
  }
  if (models.length > DRAWN) out.push(`… ${models.length - DRAWN} more models in the table above.`);
  while (out.at(-1) === '') out.pop();
  return out;
}

/** The code graph of each changed symbol, for a terminal: the most connected first, at most 10. */
export function graphDrawing(graphs) {
  const shown = graphs.filter(g => g.callers?.length || g.callees?.length);
  const ranked = [...shown].sort((a, b) => b.callers.length + b.callees.length - (a.callers.length + a.callees.length));
  const out = [];
  for (const g of ranked.slice(0, DRAWN))
    out.push(`${safe(g.symbol)}  ${safe(g.file)}:${g.line}`, ...graphDiagram(g).map(l => '  ' + l), '');
  if (ranked.length > DRAWN) out.push(`… ${ranked.length - DRAWN} more symbols in the table above.`);
  while (out.at(-1) === '') out.pop();
  return out;
}

const fence = lines => (lines.length ? ['', '```text', ...lines, '```'] : []);

export function renderStage({ range, models, graphs, files, mermaid = true, drawings = false }) {
  const out = [
    `Stage ${cell(range)}: ${files} changed code file${files === 1 ? '' : 's'}.`,
    '',
    '### Pydantic models in play',
    '',
  ];
  if (!models.length) out.push('No Pydantic model is defined or used in the changed lines.');
  else {
    out.push('| Model | Base | File | Changed fields | Links to |', '| --- | --- | --- | --- | --- |');
    for (const m of models)
      out.push(
        `| ${cell(m.name)} | ${cell(m.bases.join(', '))} | ${cell(m.file)}:${m.line} | ${cell(list(m.changed))} | ${cell(list([...new Set(m.fields.flatMap(f => f.models))]))} |`,
      );
    if (drawings) out.push(...fence(modelDrawing(models)));
    if (mermaid) out.push('', ...mermaidLines(models));
  }
  out.push('', '### CodeGraph changes', '');
  if (!graphs.length) out.push('No changed function or class is in the CodeGraph index.');
  else {
    out.push(
      '| Symbol | Change | File | Called by | Uses | Tests that reach it |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const g of graphs)
      out.push(
        `| ${cell(g.symbol)} | ${g.moved ? 'moved' : 'changed'} | ${cell(g.file)}:${g.line} | ${cell(list(g.callers.map(c => c.name)))}${g.total > g.callers.length ? ` (${g.total} in all)` : ''} | ${cell(list(g.callees.map(c => c.name)))} | ${g.tests.length ? cell(list([...new Set(g.tests.map(t => t.file))], 3)) : '**none**'} |`,
      );
    if (drawings) out.push(...fence(graphDrawing(graphs)));
    if (mermaid) out.push('', ...graphsMermaid(graphs));
  }
  return out;
}

/** The report lines of a range, in the folder cwd. A caller that already has an ontology reader (the watch) passes it,
 * so the folder is read once; otherwise a reader is made and closed here. */
export async function stageLines(range, { cwd = ROOT, reader = null, mermaid = true, drawings = false } = {}) {
  const diff = execFileSync(
    'git',
    ['-C', cwd, '-c', 'core.fsmonitor=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', range],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const hunks = markMoves(parseDiff(diff));
  const own = !reader,
    ask = reader || new OntologyReader(cwd),
    models = new Map(),
    graphs = new Map();
  try {
    for (const h of hunks) {
      const change = { file: resolve(cwd, h.file), before: h.before, after: h.after };
      const symbol = symbolOfChange(change, cwd);
      const key = h.file + '|' + symbol;
      if (symbol && !graphs.has(key)) {
        const g = await graphOf(cwd, symbol, change.file, { timeout: 8000 });
        if (g?.indexed) graphs.set(key, { ...g, moved: h.moved });
      } else if (symbol && graphs.has(key) && !h.moved) graphs.get(key).moved = false;
      if (h.file.endsWith('.py')) {
        const reply = await ask.ask('', namesOfChange(change, symbol || ''));
        // Field names in moved lines are not changes; only the lines that this stage really added or removed count.
        const words = new Set([...h.changedBefore, ...h.changedAfter].join(' ').match(/\b[a-z_][a-z0-9_]*\b/g) || []);
        for (const m of reply?.models || []) {
          const known = models.get(m.name) || { ...m, changed: [] };
          for (const f of m.fields)
            if (words.has(f.name) && !known.changed.includes(f.name)) known.changed.push(f.name);
          models.set(m.name, known);
        }
      }
    }
  } finally {
    if (own) ask.close();
  }
  return renderStage({
    range,
    models: [...models.values()],
    graphs: [...graphs.values()],
    files: new Set(hunks.map(h => h.file)).size,
    mermaid,
    drawings,
  });
}

async function main(argv) {
  let range;
  try {
    range = rangeOf(argv[0]);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  for (const line of await stageLines(range)) console.log(line);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main(process.argv.slice(2));
