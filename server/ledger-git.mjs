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
