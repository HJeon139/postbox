// A git repository in memory, for the work ledger's tests (#156, #195): files, commits and branches, answering the
// read-only git commands server/ledger-git.mjs runs, the way git would. Tests can't start processes (tests/guard.mjs).
// It keeps no index apart from HEAD: a commit takes every file, as `git add -A && git commit` does.

import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { Ledger } from '../server/ledger.mjs';
import { Store } from '../server/store.mjs';
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
  /** `<tips> --not <had>`, newest first. */
  const reachable = (a) => {
    const cut = a.indexOf('--not');
    const not = new Set(a.slice(cut + 1).flatMap(ancestors));
    const tips = a.slice(0, cut).filter((x) => !x.startsWith('-'));
    return [...new Set(tips.flatMap(ancestors))].filter((s) => !not.has(s));
  };
  /** @type {Record<string, (args: string[]) => string | null>} */
  return {
    'rev-parse': (a) => (a[0] === '--show-toplevel' ? `${root}\n` : head() ? `${head()}\n` : null),
    'symbolic-ref': () => `${st.branch}\n`,
    'for-each-ref': () => [...refs].map(([n, s]) => `${s} refs/heads/${n}\n`).join('') + [...st.remotes].map(([n, s]) => `${s} refs/remotes/${n}\n`).join(''),
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
    'rev-list': (a) => reachable(a).join('\n') + '\n',
    log: (a) => (a.includes('--reverse') ? reachable(a).reverse() : reachable(a)).map((sha) => `${sha} ${commits.get(sha)?.ct}\n`).join(''),
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

/** Files in memory, in the shape server/ledger.mjs reads and writes them. */
function ioOver(fs) {
  const read = (p) => (fs.has(p) ? { exists: true, size: fs.get(p).length, bytes: Buffer.from(fs.get(p)) } : { exists: false });
  return {
    readNow: read,
    read: async (p) => read(p),
    readTail: async () => ({ bytes: Buffer.alloc(0), cut: false }),
    writeAtomic: async (p, b) => void fs.set(p, Buffer.from(b)),
    remove: async (p) => void fs.delete(p),
  };
}

/** What happens to a repository from elsewhere, and history rewritten. */
function moves(st, answers) {
  const { root, fs, commits } = st;
  return {
    /** A commit someone else pushed, fetched as the remote branch `origin/<branch>` (`git fetch`). */
    fetched(message, files = {}) {
      const parent = st.remotes.get(`origin/${st.branch}`) ?? answers.head();
      const tree = new Map([...(commits.get(parent)?.tree ?? new Map())]);
      for (const [k, v] of Object.entries(files)) tree.set(k, Buffer.from(v));
      const sha = createHash('sha1').update(`${commits.size}:${message}`).digest('hex');
      commits.set(sha, { sha, parent, tree, message, ct: Math.floor(Date.now() / 1000) - 3600 }); // pushed an hour ago
      st.remotes.set(`origin/${st.branch}`, sha);
      return sha;
    },
    /** A folder that isn’t a repository until `init()`, as before `git init`. */
    unborn() {
      st.repo = false;
    },
    init() {
      st.repo = true;
    },
    /** `git reset --hard <sha>` (its files are left as they are). */
    reset(sha) {
      st.refs.set(st.branch, sha);
    },
    /** `git push`: the remote branch moves to sha. */
    pushed(sha) {
      st.remotes.set(`origin/${st.branch}`, sha);
    },
    /** `git merge --ff-only <sha>`: the branch and its files move to it. */
    fastForward(sha) {
      st.refs.set(st.branch, sha);
      for (const [k, v] of commits.get(sha).tree) fs.set(join(root, k), Buffer.from(v));
    },
  };
}

/** @param {string} root @param {Record<string, string>} [files]  paths relative to root */
export function fakeRepo(root, files = {}) {
  const fs = new Map(Object.entries(files).map(([k, v]) => [join(root, k), Buffer.from(v)]));
  /** @type {Map<string, { sha: string, parent: string|null, tree: Map<string, Buffer>, message: string, ct: number }>} */
  const commits = new Map();
  const st = { root, fs, commits, refs: new Map(), remotes: new Map(), branch: 'main', repo: true };
  const answers = answersFor(st);
  const calls = [];
  const git = async (cwd, args) => {
    calls.push(`git ${args.join(' ')}`);
    if (!String(cwd).startsWith(root) || !st.repo) return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    const out = answers[args[0]]?.(args.slice(1)) ?? null;
    return out === null ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: out, stderr: '' };
  };
  const io = ioOver(fs);
  return {
    root,
    git: Object.assign(git, { calls }),
    io,
    /** Writes a file, as a command or an editor would. */
    write: (rel, text) => fs.set(join(root, rel), Buffer.from(text)),
    text: (rel) => fs.get(join(root, rel))?.toString(),
    /** `git add -A && git commit -m message`: returns the new commit's hash. */
    commit(message) {
      const sha = createHash('sha1').update(`${commits.size}:${message}`).digest('hex');
      commits.set(sha, { sha, parent: answers.head(), tree: answers.rels(), message, ct: Math.floor(Date.now() / 1000) });
      st.refs.set(st.branch, sha);
      return sha;
    },
    ...moves(st, answers),
    /** `git switch -c name`. */
    branch(name) {
      if (answers.head()) st.refs.set(name, answers.head());
      st.branch = name;
    },
  };
}

/** A ledger over a repository in memory, with one turn of @dev's running in it, its folder's snapshot taken. */
export async function ledgerIn(repo, root = repo.root) {
  const store = new Store(null);
  let t = 0;
  const ledger = new Ledger({ store, io: repo.io, git: repo.git, home: '/home/me', now: () => (t += 100) });
  store.emit('thread', { id: 'th_1', kind: 'thread', projectId: 'p1', members: [] });
  const turn = { id: 'turn_1', threadId: 'th_1', startedAt: 0 };
  ledger.startTurn(turn, { se: { id: 'se_1', handle: 'dev' }, folder: root, projectFolder: root });
  await ledger.idle();
  let n = 0;
  /** A Bash call as Claude Code reports it: `does` changes the repository while it runs. */
  const run = async (command, does = () => {}, { output = '', result = {}, vcsCwd = null } = {}) => {
    const id = `tu_${++n}`;
    ledger.toolUse(turn, { id, name: 'Bash', input: { command } });
    await ledger.idle(); // git answers for the command’s start before it changes anything
    does();
    ledger.toolResult(turn, { id, text: output, vcsCwd, result: { stdout: output, stderr: '', interrupted: false, ...result } });
    await ledger.idle();
  };
  const end = async () => {
    await ledger.endTurn(turn, { status: 'done' });
    await ledger.idle();
  };
  const of = (kind) => (store.state.work?.th_1 ?? []).filter((e) => e.kind === kind);
  return { store, ledger, turn, run, end, of };
}
