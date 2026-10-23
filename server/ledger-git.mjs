// The work ledger’s git reading (#132): commits with their files, and where each file and commit stands now. Every git
// command runs read-only, without git’s optional locks, so an agent’s own git never waits on Postbox. Moved from
// server/ledger.mjs, whose Ledger keeps a method that delegates to each function here.

import { execFile } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
import { lasting } from '../shared/work.mjs';
import { newId } from './store.mjs';

export const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** Git’s state is asked for at most this many files per view; the rest show as uncommitted. */
const GIT_FILES = 300;

/**
 * Runs git with an argument array, never through a shell. GIT_OPTIONAL_LOCKS=0 keeps `git status` from taking the
 * index lock, so an agent committing at the same moment doesn’t fail on Postbox’s account.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runGit(cwd, args, { timeoutMs = 10000 } = {}) {
  return new Promise((done) => {
    try {
      execFile(
        'git',
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
        (err, stdout, stderr) => {
          const code = err ? (typeof (/** @type {any} */ (err).code) === 'number' ? /** @type {any} */ (err).code : 1) : 0;
          done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    } catch (e) {
      done({ code: 127, stdout: '', stderr: e.message });
    }
  });
}

/** A commit, with its files and lines from git, so they match `git show --numstat`. */
export async function recordCommit(ledger, turn, cmdId, { sha, branch }, cwd, message) {
  const w = turn.work;
  const entry = ledger.add(
    w.convId,
    ledger.base(turn, { kind: 'commit', id: newId('wk'), commandId: cmdId, sha, branch, cwd, message: clip(message, 300), files: [], added: 0, deleted: 0 }),
  );
  if (!cwd) return;
  const r = await ledger.git(cwd, ['show', '--no-color', '--no-renames', '--numstat', '--format=%H%x1f%s', sha]);
  if (r.code !== 0) return;
  const [head, ...rest] = r.stdout.split('\n');
  const [full, subject] = head.split('\x1f');
  const files = rest
    .map((l) => /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({
      path: clip(m?.[3], 500),
      added: m?.[1] === '-' ? 0 : Number(m?.[1]),
      deleted: m?.[2] === '-' ? 0 : Number(m?.[2]),
      binary: m?.[1] === '-',
    }));
  ledger.patch(w.convId, entry.id, {
    sha: /^[0-9a-f]{40}$/.test(full) ? full : sha,
    message: clip(subject || message, 300),
    files: files.slice(0, 500),
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0),
  });
}

/** The repository a folder is in (its top folder), or null. A folder with none is asked again after a minute. */
export async function rootOf(ledger, dir) {
  const hit = ledger.roots.get(dir);
  if (hit && (hit.root || ledger.now() - hit.at < 60000)) return hit.root;
  const r = await ledger.git(dir, ['rev-parse', '--show-toplevel']);
  const root = r.code === 0 && r.stdout.trim() ? resolve(r.stdout.trim()) : null;
  ledger.roots.set(dir, { root, at: ledger.now() });
  return root;
}
/** Whether git tracks a file: null outside a repository. */
export async function tracked(ledger, path) {
  const root = await ledger.rootOf(dirname(path));
  if (!root) return null;
  const r = await ledger.git(root, ['ls-files', '--error-unmatch', '--', relative(root, path)]);
  return r.code === 0;
}
export async function pushed(ledger, root, sha) {
  const key = `${root}:${sha}`;
  if (ledger.pushedCache.has(key)) return true;
  const r = await ledger.git(root, ['branch', '-r', '--contains', sha]);
  const yes = r.code === 0 && r.stdout.trim().length > 0;
  if (yes) ledger.pushedCache.add(key);
  return yes;
}

/**
 * Where each file and commit stands now: { files: { [id]: { state, commit?, untracked? } }, commits: { [id]: { pushed } },
 * repos: [{ root, branch, upstream }] }. state is uncommitted, committed, pushed, unchanged, ignored or none (not in git).
 */
export async function gitState(ledger, convId) {
  const entries = ledger.entries(convId);
  const files = entries.filter((e) => e.kind === 'file');
  const commits = entries.filter((e) => e.kind === 'commit');
  /** @type {Record<string, any>} */
  const out = { files: {}, commits: {}, repos: [] };
  const byRoot = new Map();
  for (const f of files.slice(-GIT_FILES)) {
    if (!lasting(f)) {
      out.files[f.id] = { state: 'unchanged' };
      continue;
    }
    const root = await ledger.rootOf(dirname(f.path));
    if (!root) out.files[f.id] = { state: 'none' };
    else (byRoot.get(root) ?? byRoot.set(root, []).get(root)).push(f);
  }
  for (const c of commits) {
    const root = c.cwd ? await ledger.rootOf(c.cwd) : null;
    if (root && !byRoot.has(root)) byRoot.set(root, []);
  }
  for (const [root, list] of byRoot) {
    const st = await ledger.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const dirty = new Map();
    if (st.code === 0) {
      const parts = st.stdout.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.length < 4) continue;
        dirty.set(p.slice(3), p.slice(0, 2));
        if (p[0] === 'R' || p[0] === 'C') i++; // a rename’s old path follows
      }
    }
    const branch = (await ledger.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || null;
    const up = await ledger.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    out.repos.push({ root, branch, upstream: up.code === 0 ? up.stdout.trim() : null });
    for (const f of list) {
      const rel = relative(root, f.path).split(sep).join('/');
      const code = dirty.get(rel);
      if (code) {
        out.files[f.id] = { state: 'uncommitted', ...(code === '??' ? { untracked: true } : {}) };
        continue;
      }
      const last = (await ledger.git(root, ['log', '-1', '--format=%H', '--', rel])).stdout.trim();
      if (!last) {
        const ignored = (await ledger.git(root, ['check-ignore', '-q', '--', rel])).code === 0;
        out.files[f.id] = { state: ignored ? 'ignored' : f.after?.exists ? 'uncommitted' : 'unchanged' };
        continue;
      }
      out.files[f.id] = { state: (await ledger.pushed(root, last)) ? 'pushed' : 'committed', commit: last };
    }
  }
  for (const c of commits) {
    const root = c.cwd ? await ledger.rootOf(c.cwd) : null;
    out.commits[c.id] = { pushed: root ? await ledger.pushed(root, c.sha) : false };
  }
  return out;
}

// ── What a command did, seen in git (#156) ──────────────────────────────────────────────
//
// A command’s commits are seen by comparing its git folder before and after it: HEAD and the branches. “Before” is
// the folder’s last snapshot, taken when a turn starts there and again whenever a command there ends, not one taken
// as the command starts: that would race it, since git answers after a quick command is done. So a commit made
// inside a compound command (`… && git commit …`), which Claude Code doesn’t report, is still recorded.

/** New commits one command can record. */
const COMMITS = 50;

/** What the ledger keeps of each git folder: the commands running there, its last snapshot, and the turns at work. */
export const folderWatch = () => ({ live: new Map(), bases: new Map(), locks: new Map(), working: new Set() });

const rootFor = (ledger, dir) => (dir ? ledger.rootOf(dir) : null);
/** Runs fn for one folder at a time, so two commands that end together compare against one snapshot each. */
function serial(ledger, root, fn) {
  const run = (ledger.folders.locks.get(root) ?? Promise.resolve()).then(fn);
  ledger.folders.locks.set(
    root,
    run.catch(() => {}),
  );
  return run;
}

/** Where a folder stands in git: { head, branch, refs: Map(branch → tip) }, or null when git can’t say. */
export async function snapshot(ledger, root) {
  const [head, branch, refs] = await Promise.all([
    ledger.git(root, ['rev-parse', '--verify', '-q', 'HEAD']),
    ledger.git(root, ['symbolic-ref', '-q', '--short', 'HEAD']),
    ledger.git(root, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads']),
  ]);
  if (refs.code !== 0) return null;
  const tips = new Map(
    refs.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(l.indexOf(' ') + 1), l.slice(0, l.indexOf(' '))]),
  );
  return { head: head.code === 0 ? head.stdout.trim() || null : null, branch: branch.code === 0 ? branch.stdout.trim() : '', refs: tips };
}

/** A turn starts: its git folder gets a snapshot to compare commands against, unless a command there is running. */
export async function turnStarted(ledger, w, folderKnown) {
  await folderKnown;
  ledger.folders.working.add(w);
  const root = await rootFor(ledger, w.folder ?? w.projectFolder);
  if (!root) return;
  for (const c of ledger.folders.live.values()) if ((await rootFor(ledger, c.cwd)) === root) return;
  await serial(ledger, root, () => ledger.folders.bases.set(root, snapshot(ledger, root)));
}

/** A turn ended: its commands that still run can’t be followed, and its files are its own again. */
export function turnEnded(ledger, w) {
  ledger.folders.working.delete(w);
  for (const [id, c] of ledger.folders.live) if (c.turn.work === w) ledger.folders.live.delete(id);
}

/** A command starts in the agent’s folder. */
export function commandStarted(ledger, turn, cmdId, who) {
  const w = turn.work;
  ledger.folders.live.set(cmdId, { turn, cwd: w.folder ?? w.projectFolder, who });
}

/**
 * A command ended, or ended in the background: what it did in git since the folder’s last snapshot.
 * @param {any} ledger @param {any} turn @param {string} cmdId @param {string|null} [vcsCwd]  where Claude Code said it ran git
 */
export async function commandSeen(ledger, turn, cmdId, vcsCwd = null) {
  const cmd = ledger.folders.live.get(cmdId);
  if (!cmd || ledger.entry(turn.work.convId, cmdId)?.state === 'background') return; // its end comes with taskEnded
  const root = await rootFor(ledger, vcsCwd ?? cmd.cwd);
  if (!root) return ledger.folders.live.delete(cmdId);
  await serial(ledger, root, () => compare(ledger, turn, cmdId, cmd, root));
}

async function compare(ledger, turn, cmdId, cmd, root) {
  const { bases, live } = ledger.folders;
  const before = await bases.get(root);
  const after = await snapshot(ledger, root);
  live.delete(cmdId);
  bases.set(root, Promise.resolve(after));
  if (!before || !after) return;
  await newCommits(ledger, turn, cmdId, root, before, after);
  const convId = turn.work.convId;
  for (const name of after.refs.keys()) {
    if (before.refs.has(name) || ledger.entries(convId).some((x) => x.kind === 'branch' && x.name === name && [cmd.cwd, root].includes(x.cwd))) continue;
    ledger.add(convId, ledger.base(turn, { kind: 'branch', id: newId('wb'), commandId: cmdId, name: clip(name, 200), cwd: cmd.cwd }));
  }
}

/** Commits HEAD or a branch gained that nothing had before, oldest first, each recorded once; returns their entries. */
async function newCommits(ledger, turn, cmdId, root, before, after) {
  const had = [before.head, ...before.refs.values()].filter(Boolean);
  const tips = [...new Set([after.head, ...after.refs.values()])].filter((t) => t && !had.includes(t));
  if (!tips.length) return [];
  const r = await ledger.git(root, ['rev-list', '--reverse', `--max-count=${COMMITS}`, ...tips, '--not', ...had]);
  if (r.code !== 0) return [];
  const known = (sha) => ledger.entries(turn.work.convId).find((x) => x.kind === 'commit' && (x.sha.startsWith(sha) || sha.startsWith(x.sha)));
  const out = [];
  for (const sha of r.stdout.split('\n').filter(Boolean)) {
    if (!known(sha)) await ledger.recordCommit(turn, cmdId, { sha, branch: after.branch }, root, '');
    out.push(known(sha));
  }
  return out.filter(Boolean);
}
