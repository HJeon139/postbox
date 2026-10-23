// A git repository in memory, for the work ledger's tests (#156, #195): files, commits and branches, answering the
// read-only git commands server/ledger-git.mjs runs, the way git would. Tests can't start processes (tests/guard.mjs).
// It keeps no index apart from HEAD: a commit takes every file, as `git add -A && git commit` does.

import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { diffCount } from '../shared/diff.mjs';

/** The read-only commands, answered from the repository's state: stdout, or null where git would fail. */
function answersFor(st) {
  const { root, fs, commits, refs } = st;
  const head = () => refs.get(st.branch) ?? null;
  const tree = (sha) => commits.get(sha)?.tree ?? new Map();
  const rels = () => new Map([...fs].filter(([p]) => p.startsWith(`${root}/`)).map(([p, b]) => [relative(root, p), b]));
  const changed = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((p) => !a.get(p)?.equals(b.get(p) ?? Buffer.alloc(0)) || !b.has(p)).sort();
  const lines = (a, b, p) => diffCount(a.get(p)?.toString() ?? '', b.get(p)?.toString() ?? '');
  const ancestors = (sha) => {
    const out = [];
    for (let s = sha; s; s = commits.get(s)?.parent ?? null) out.push(s);
    return out;
  };
  /** @type {Record<string, (args: string[]) => string | null>} */
  return {
    'rev-parse': (a) => (a[0] === '--show-toplevel' ? `${root}\n` : head() ? `${head()}\n` : null),
    'symbolic-ref': () => `${st.branch}\n`,
    'for-each-ref': () => [...refs].map(([n, s]) => `${s} ${n}\n`).join(''),
    status: () => {
      const now = rels();
      const at = tree(head());
      return changed(at, now)
        .map((p) => `${!at.has(p) ? '??' : !now.has(p) ? ' D' : ' M'} ${p}\0`)
        .join('');
    },
    diff: () => {
      const now = rels();
      const at = tree(head());
      return changed(at, now)
        .filter((p) => at.has(p))
        .map((p) => `${lines(at, now, p).added}\t${lines(at, now, p).deleted}\t${p}\0`)
        .join('');
    },
    'rev-list': (a) => {
      const not = new Set(a.slice(a.indexOf('--not') + 1).flatMap(ancestors));
      const tips = a.slice(0, a.indexOf('--not')).filter((x) => !x.startsWith('-'));
      const fresh = [...new Set(tips.flatMap(ancestors))].filter((s) => !not.has(s));
      return fresh.reverse().join('\n') + (fresh.length ? '\n' : '');
    },
    show: (a) => {
      const spec = a.at(-1);
      if (spec.includes(':')) return tree(spec.split(':')[0]).get(spec.split(':')[1])?.toString() ?? null;
      const c = commits.get(spec);
      if (!c) return null;
      const was = tree(c.parent);
      const rows = changed(was, c.tree).map((p) => `${lines(was, c.tree, p).added}\t${lines(was, c.tree, p).deleted}\t${p}`);
      return `${c.sha}\x1f${c.message}\n\n${rows.join('\n')}\n`;
    },
    'ls-files': (a) => (tree(head()).has(a.at(-1)) ? `${a.at(-1)}\n` : null),
    head,
    rels,
  };
}

/** @param {string} root @param {Record<string, string>} [files]  paths relative to root */
export function fakeRepo(root, files = {}) {
  const fs = new Map(Object.entries(files).map(([k, v]) => [join(root, k), Buffer.from(v)]));
  /** @type {Map<string, { sha: string, parent: string|null, tree: Map<string, Buffer>, message: string }>} */
  const commits = new Map();
  const st = { root, fs, commits, refs: new Map(), branch: 'main' };
  const answers = answersFor(st);
  const calls = [];
  const git = async (cwd, args) => {
    calls.push(`git ${args.join(' ')}`);
    if (!String(cwd).startsWith(root)) return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    const out = answers[args[0]]?.(args.slice(1)) ?? null;
    return out === null ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: out, stderr: '' };
  };
  const read = (p) => (fs.has(p) ? { exists: true, size: fs.get(p).length, bytes: Buffer.from(fs.get(p)) } : { exists: false });
  const io = {
    readNow: read,
    read: async (p) => read(p),
    readTail: async () => ({ bytes: Buffer.alloc(0), cut: false }),
    writeAtomic: async (p, b) => void fs.set(p, Buffer.from(b)),
    remove: async (p) => void fs.delete(p),
  };
  return {
    git: Object.assign(git, { calls }),
    io,
    /** Writes a file, as a command or an editor would. */
    write: (rel, text) => fs.set(join(root, rel), Buffer.from(text)),
    text: (rel) => fs.get(join(root, rel))?.toString(),
    /** `git add -A && git commit -m message`: returns the new commit's hash. */
    commit(message) {
      const sha = createHash('sha1').update(`${commits.size}:${message}`).digest('hex');
      commits.set(sha, { sha, parent: answers.head(), tree: answers.rels(), message });
      st.refs.set(st.branch, sha);
      return sha;
    },
    /** `git switch -c name`. */
    branch(name) {
      if (answers.head()) st.refs.set(name, answers.head());
      st.branch = name;
    },
  };
}
