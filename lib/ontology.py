# SPDX-License-Identifier: AGPL-3.0-only
"""The Pydantic ontology of a Python folder, read with ast: no module is imported and no code of the folder runs.

Used by the watch (npm run aidr, tools/aidr/ontology.mjs). Owner, 21 November 2026: "update npm local wtf to show
the relevant Python Pydantic Ontology at play, focus on Ontology".

    python3 -I tools/aidr/ontology.py <folder> <file.py> <name> [<name> ...]
    python3 -I tools/aidr/ontology.py --serve <folder>     one JSON request on each stdin line: {"file", "names"}

Prints JSON: the models of the folder whose names are given, and the models the given file defines, each with its file,
line, bases, first doc line, and fields (name, annotation, the models the annotation names, its Literal values). A model
is a class whose bases reach pydantic.BaseModel or RootModel through the folder's own classes. With --serve the watch
keeps one process: the first request reads every file (about 10 s for 2,000 models), and later requests read again only
the files whose modification time changed. Nothing is written to disk.
"""

from __future__ import annotations

import ast
import json
import os
import sys

ROOTS = {'BaseModel', 'RootModel'}
SKIP = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.codegraph', '.local', 'html', 'dist', 'build'}
MAX_FILES, MAX_BYTES = 4000, 1_000_000


def python_files(folder):
    count = 0
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith('.')]
        for name in files:
            if name.endswith('.py'):
                count += 1
                if count > MAX_FILES:
                    return
                yield os.path.join(root, name)


def base_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Subscript):  # Generic[T], ListingFact[T]
        return base_name(node.value)
    return None


def names_in(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)} | {
        n.attr for n in ast.walk(node) if isinstance(n, ast.Attribute)}


def literals(node):
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Subscript) and base_name(n.value) == 'Literal':
            items = n.slice.elts if isinstance(n.slice, ast.Tuple) else [n.slice]
            out += [i.value for i in items if isinstance(i, ast.Constant)]
    return out


def file_classes(folder, path):
    """The classes of one file: a list of (name, {file, line, bases, fields, doc})."""
    out = []
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return out
        with open(path, encoding='utf-8', errors='replace') as handle:
            tree = ast.parse(handle.read(), filename=path)
    except (OSError, SyntaxError, ValueError):
        return out
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        fields = []
        for item in node.body:
            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name) \
                    and not item.target.id.startswith('_') and item.target.id != 'model_config':
                fields.append({'name': item.target.id, 'annotation': ast.unparse(item.annotation)[:160],
                               'names': sorted(names_in(item.annotation)), 'literals': literals(item.annotation)[:12]})
        out.append((node.name, {
            'file': os.path.relpath(path, folder), 'line': node.lineno,
            'bases': [b for b in (base_name(x) for x in node.bases) if b], 'fields': fields,
            'doc': (ast.get_docstring(node) or '').split('\n')[0][:160]}))
    return out


class Index:
    """The classes of a folder, read again file by file when a file's modification time changes."""

    def __init__(self, folder):
        self.folder, self.files = folder, {}

    def refresh(self):
        seen = set()
        for path in python_files(self.folder):
            seen.add(path)
            try:
                mtime = os.stat(path).st_mtime_ns
            except OSError:
                continue
            if self.files.get(path, (None,))[0] != mtime:
                self.files[path] = (mtime, file_classes(self.folder, path))
        for gone in set(self.files) - seen:
            del self.files[gone]
        index = {}
        for _, items in self.files.values():
            for name, info in items:
                index.setdefault(name, []).append(info)
        return index


def models(index):
    """The names of the classes whose bases reach a Pydantic root through the folder's own classes."""
    known, changed = set(), True
    while changed:
        changed = False
        for name, defs in index.items():
            if name in known:
                continue
            if any(b in ROOTS or b in known for d in defs for b in d['bases']):
                known.add(name)
                changed = True
    return known


def answer(folder, index, file, names):
    """The models a change is about: the given names that are models, and the models the file defines."""
    pydantic = models(index)
    rel = os.path.relpath(os.path.abspath(file), folder) if file else ''
    wanted = {n for n in names if n in pydantic}
    if file:
        wanted |= {n for n in pydantic for d in index[n] if d['file'] == rel}
    out = []
    for name in sorted(wanted):
        d = next((x for x in index[name] if x['file'] == rel), index[name][0])
        out.append({'name': name, 'file': d['file'], 'line': d['line'], 'bases': d['bases'], 'doc': d['doc'],
                    'fields': [{'name': f['name'], 'annotation': f['annotation'], 'literals': f['literals'],
                                'models': [m for m in f['names'] if m in pydantic and m != name]}
                               for f in d['fields']]})
    return {'models': out, 'count': len(pydantic)}


def main(argv):
    if argv and argv[0] == '--serve':
        folder, index = argv[1], Index(argv[1])
        for line in sys.stdin:
            try:
                request = json.loads(line)
                reply = answer(folder, index.refresh(), str(request.get('file') or ''),
                               {str(n) for n in request.get('names') or []})
            except Exception as error:  # one bad request never stops the reader
                reply = {'models': [], 'count': 0, 'error': type(error).__name__}
            sys.stdout.write(json.dumps(reply) + '\n')
            sys.stdout.flush()
        return
    print(json.dumps(answer(argv[0], classes(argv[0]), argv[1], set(argv[2:]))))


def classes(folder):
    """Every class of the folder: name -> list of {file, line, bases, fields, doc}."""
    return Index(folder).refresh()


if __name__ == '__main__':
    main(sys.argv[1:])
