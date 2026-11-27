// The commit at the end of an Antigravity turn in an agent’s own worktree (#1709): what the turn left, on its branch,
// for the person to merge (the person’s decision of 26 November 2026), in the project’s repository and in each of its
// submodules’ (#1856).

import { access, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { runGit } from '../ledger-git.mjs';
import { copyIndex } from './agent-index-copy.mjs';
import { gitlinksAt } from './agent-submodules.mjs';
import { branchFor, gitTimeoutFor, sharedFolder, worktreesRootFor } from './agent-worktree.mjs';

/** @typedef {import('./agent-worktree.mjs').Git} Git */

/** git as Postbox runs it (ledger-git.mjs): an argument array, the repository’s hooks and filters off. @type {Git} */
const defaultGit = (cwd, args, o) => runGit(cwd, args, { ...gitTimeoutFor(args), ...o });

/** Whether a path is there. @param {string} path */
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** A commit’s name as git prints it in full, SHA-1 or SHA-256: nothing else becomes git’s argument. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** @typedef {{ top: string, admin: string }} Place  a worktree’s top folder, and its record in the repository it’s of */

/**
 * git pinned to a worktree: run in its record, with that record and the worktree named outright, so nothing in the
 * agent’s folders decides where git works. With index, on that index file in place of the worktree’s own (#1844).
 * @param {Git} git @param {Place} place @param {string} [index]
 */
const pin = (git, place, index) => (/** @type {string[]} */ args) =>
  git(place.admin, ['--git-dir', place.admin, '--work-tree', place.top, ...args], index ? { index } : undefined);

/**
 * Commits what a turn left in an agent’s own worktree, on its branch, so its work reaches the person and the other
 * agents as a commit whether or not it could commit itself (#1709, the person’s decision of 26 November 2026: an agent
 * without Shell would otherwise need a card for every `git commit`). Through runGit, so the repository’s hooks don’t
 * run, and unsigned. The agent is its author, and Postbox its committer, for this commit only.
 *
 * Only in the worktree Postbox made, on the agent’s own branch: git runs in that worktree’s record in the project’s
 * repository, found from the repository itself, with that record and the worktree named outright, never found through
 * anything in the agent’s folders. Nothing for a turn that starts outside a worktree, one that changed nothing, one on
 * another branch or none, or a worktree whose record sets core.worktree.
 *
 * What the turn left in a submodule Postbox put there (agent-submodules.mjs, #1856) is committed first, the same way,
 * in the record the person’s submodule repository keeps, on the branch of the same name there; the project’s commit
 * then names that commit. A submodule left uncommitted (on another branch, half done) says why in the log, and the
 * project’s commit goes on without it. Returns whether it committed in the project’s repository.
 * @param {string} cwd @param {{ id?: string, handle: string }} persona
 * @param {{ id?: string, folder?: string|null } | null | undefined} project @param {string} workRoot
 * @param {{ git?: Git, log?: (line: string) => void }} [o]
 */
export async function commitTurn(cwd, persona, project, workRoot, { git = defaultGit, log = (l) => console.error(l) } = {}) {
  if (!project?.folder || sharedFolder(cwd, project, workRoot)) return false;
  const refuse = (/** @type {string} */ why, where = cwd) => {
    log(`Postbox didn’t commit @${persona.handle}’s work in ${where}: ${why}, so it stays uncommitted.`);
    return false;
  };
  const place = await recordOf(git, cwd, project.folder, workRoot);
  if (!place) return refuse('its worktree isn’t one the project’s repository lists');
  const turn = { branch: branchFor(persona, project), handle: persona.handle };
  const repo = (await git(project.folder, ['rev-parse', '--show-toplevel'])).stdout.trim();
  /** Each submodule Postbox put there: the commit to name for it now, or null to leave the project’s as it is. @type {Map<string, string|null>} */
  const subs = new Map();
  for (const link of (await gitlinks(pin(git, place))) ?? []) {
    const sub = await recordAt(git, join(place.top, link.path), join(repo, link.path));
    if (!sub) continue;
    const done = await commitIn(git, sub, { ...turn, theirs: join(repo, link.path), nested: true });
    if ('why' in done) refuse(done.why, sub.top);
    subs.set(link.path, await movedOn(pin(git, sub), link.sha));
  }
  const done = await commitIn(git, place, { ...turn, theirs: repo, subs });
  return 'why' in done ? refuse(done.why) : done.committed;
}

/**
 * The commit a submodule is at now, when it’s one the project’s commit should name: a new one that follows the one
 * the worktree’s index names. Null when it hasn’t moved, and when it’s behind or beside that commit, as after the
 * agent merged a branch that moved the submodule on: naming where it stands would take the project’s back.
 * @param {(args: string[]) => ReturnType<Git>} g  git pinned to the submodule @param {string} named
 */
async function movedOn(g, named) {
  const head = (await g(['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout.trim();
  if (!SHA.test(head) || head === named) return null;
  return (await g(['merge-base', '--is-ancestor', named, head])).code === 0 ? head : null;
}

/**
 * @typedef {{ branch: string, handle: string, theirs: string, subs?: Map<string, string|null>, nested?: boolean }} Turn
 *   theirs: the person’s checkout of the same repository; subs: the submodules already committed (commitTurn);
 *   nested: it’s a submodule’s worktree
 */

/**
 * Commits what’s uncommitted in one worktree, on the agent’s branch, from a copy of its index in a folder of Postbox’s
 * own outside the agent’s folders (#1844). A process the agent left running can still stage in the worktree’s own
 * index while the commit runs, and a gitlink it staged there would have the commit’s add start git inside that
 * repository; nothing it stages reaches the copy. Once committed, the worktree’s own index is set to the new commit,
 * by read-tree, which reads no file in the worktree, or the agent would see what was committed as staged to undo.
 * Returns whether it committed, or why it didn’t when that’s worth the log.
 * @param {Git} git @param {Place} place @param {Turn} turn
 * @returns {Promise<{ committed: boolean } | { why: string }>}
 */
async function commitIn(git, place, turn) {
  const dir = await mkdtemp(join(tmpdir(), 'postbox-commit-')).catch(() => null);
  if (!dir) return { why: 'Postbox couldn’t make a folder for its copy of the index' };
  try {
    const index = join(dir, 'index');
    if (!(await copyIndex(join(place.admin, 'index'), index))) return { why: 'its index isn’t a file Postbox can copy' };
    const done = await commitFrom(git, place, index, turn);
    // --reset keeps what git knew of each file that already matches the commit, so the next status doesn’t read every
    // file again, whatever else the worktree’s index held.
    if ('committed' in done && done.committed) await pin(git, place)(['read-tree', '--reset', 'HEAD']);
    return done;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * commitIn’s commit, every step on the index file named, which only Postbox writes.
 * @param {Git} git @param {Place} place @param {string} index @param {Turn} turn
 * @returns {Promise<{ committed: boolean } | { why: string }>}
 */
async function commitFrom(git, place, index, { branch, handle, theirs, subs = new Map(), nested = false }) {
  const g = pin(git, place, index);
  if (await namesAnotherFolder(g, nested)) return { why: 'its worktree’s record names another folder to work in' };
  const head = await g(['symbolic-ref', '-q', 'HEAD']);
  if (head.stdout.trim() !== `refs/heads/${branch}`) return { why: 'it isn’t on its own branch' };
  // Every untracked file, whatever status.showUntrackedFiles says, or a turn that only made files commits nothing.
  // Unquoted (-z), so a new nested repository shows as a folder whatever its name. A repository nested in the worktree
  // that the index holds (a gitlink) is read by starting git inside it, under the config the agent wrote; the flag
  // stops that, as git’s config can’t once the agent’s .gitmodules asks for it.
  const changed = await g(['status', '--porcelain', '-z', '--ignore-submodules=all', '--untracked-files=all']);
  const entries = changed.stdout.split('\0').filter(Boolean);
  if (changed.code !== 0) return { committed: false };
  // Adding a gitlink starts git inside it too, and add takes no such flag, so the copy of the index is read just
  // before: every gitlink in it is kept out of the add, and one that’s neither a submodule Postbox put there nor one
  // of the project’s own is refused. Nothing staged in the worktree’s own index after the copy reaches it (#1844).
  const links = await gitlinks(g);
  const turned = (links ?? []).filter((l) => subs.get(l.path) && subs.get(l.path) !== l.sha);
  if (entries.length === 0 && turned.length === 0) return { committed: false };
  // A conflict, or a merge, rebase or cherry-pick the agent left half done, would be committed as resolved, markers
  // and all. A conflict shows in the status itself, whatever left it (a stash pop leaves no file to see it by).
  const conflicted = entries.some((l) => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(l));
  const midway = (await inProgress(g, place.admin)) ?? (conflicted ? 'conflict' : null);
  if (midway) return { why: `a ${midway} is in progress there` };
  if (entries.some((l) => l.startsWith('?? ') && l.endsWith('/'))) return { why: 'it holds a repository of its own' };
  const others = (links ?? []).filter((l) => !subs.has(l.path)).map((l) => l.path);
  // By name, not by count, so a path git read as a pattern (one the agent named `vendor/*`) can’t pass as the
  // person’s own `vendor/lib`.
  const own = new Set(links ? (await gitlinksAt(git, theirs, others)).map((l) => l.path) : []);
  if (!links || !others.every((path) => own.has(path))) return { why: 'it holds a repository of its own' };
  const named = turned.map((l) => ({ path: l.path, sha: /** @type {string} */ (subs.get(l.path)) }));
  const staged = await stage(g, links, named);
  if (staged.code !== 0) return refused(staged);
  // A repository made in the worktree after the status, which the add took as a gitlink (#1844).
  const after = await gitlinks(g);
  if (!after || after.some((l) => !links.some((k) => k.path === l.path))) return { why: 'it holds a repository of its own' };
  const made = await record(g, handle);
  return made.code === 0 ? { committed: true } : refused(made);
}

/** Why git’s command failed, for the log: its last line of errors. @param {{ code: number, stderr: string }} r */
const refused = (r) => ({ why: `git refused (${r.stderr.trim().split('\n').at(-1) || `it exited with ${r.code}`})` });

/**
 * Stages everything but the gitlinks, and names each submodule’s new commit. Each gitlink is kept out of the add by
 * name: adding one starts git inside it, under whatever config its folder holds.
 * @param {(args: string[]) => ReturnType<Git>} g  git pinned to the worktree
 * @param {{ path: string }[]} links @param {{ path: string, sha: string }[]} turned
 */
async function stage(g, links, turned) {
  const kept = links.map((l) => `:(top,exclude,literal)${l.path}`);
  let last = await g(kept.length ? ['add', '-A', '--', ':(top)', ...kept] : ['add', '-A']);
  for (const t of turned) if (last.code === 0) last = await g(['update-index', '--cacheinfo', `160000,${t.sha},${t.path}`]);
  return last;
}

/**
 * Commits what’s staged, as Postbox, for the agent. @param {(args: string[]) => ReturnType<Git>} g  git pinned to the
 * worktree @param {string} handle
 */
async function record(g, handle) {
  // Unsigned: signing would run gpg.program, a program from the repository’s or the person’s config, and could wait
  // on a passphrase. And no automatic maintenance, whose gc can prune the repository’s worktrees, the person’s own.
  const identity = ['-c', 'user.name=Postbox', '-c', 'user.email=postbox@postbox.invalid', '-c', 'commit.gpgSign=false'];
  const quiet = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  const author = `--author=@${handle} <${handle}@postbox.invalid>`;
  return g([...identity, ...quiet, 'commit', '-q', author, '-m', `@${handle}’s work at the end of a turn`]);
}

/**
 * Whether the worktree’s record names another folder to work in (core.worktree). A submodule’s repository always
 * names the person’s checkout of it, in the config all its worktrees share, which the --work-tree given outright
 * overrides: there, only a setting of this worktree’s own counts.
 * @param {(args: string[]) => ReturnType<Git>} g @param {boolean} nested
 */
async function namesAnotherFolder(g, nested) {
  if (!nested) return (await g(['config', '--get', 'core.worktree'])).code === 0;
  const set = await g(['config', '--show-scope', '--get-all', 'core.worktree']);
  return set.stdout.split('\n').some((l) => l.trim() && !l.startsWith('local\t'));
}

/**
 * The repositories the worktree’s index holds (gitlinks), each with the commit it names, or null when the index can’t
 * be read. @param {(args: string[]) => ReturnType<Git>} g
 * @returns {Promise<{ path: string, sha: string }[] | null>}
 */
async function gitlinks(g) {
  const tracked = await g(['ls-files', '--stage', '-z']);
  if (tracked.code !== 0) return null;
  return tracked.stdout.split('\0').flatMap((entry) => {
    const m = /^160000 ([0-9a-f]+) \d\t([\s\S]+)$/.exec(entry);
    return m ? [{ path: m[2], sha: m[1] }] : [];
  });
}

/**
 * The worktree holding cwd, at its top under Postbox’s worktrees folder, and its record in the project’s repository.
 * @param {Git} git @param {string} cwd @param {string} folder @param {string} workRoot
 * @returns {Promise<Place | null>}
 */
async function recordOf(git, cwd, folder, workRoot) {
  const root = resolve(worktreesRootFor(workRoot));
  const [project, entry] = relative(root, resolve(cwd)).split(sep);
  if (!project || !entry || project === '..') return null;
  const top = await realpath(join(root, project, entry)).catch(() => null);
  return top ? recordAt(git, top, folder) : null;
}

/**
 * The record a repository keeps of the worktree at top: the folder under that repository’s worktrees whose gitdir
 * names it. From the person’s checkout of the repository (theirs), outside the agent’s folders. Null when there’s
 * none, when theirs isn’t there, and when a link stands on the way to top, which the agent could have put there.
 * @param {Git} git @param {string} top @param {string} theirs
 * @returns {Promise<Place | null>}
 */
async function recordAt(git, top, theirs) {
  if ((await realpath(top).catch(() => null)) !== top) return null;
  const common = await git(theirs, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0) return null;
  const records = join(common.stdout.trim(), 'worktrees');
  for (const name of await readdir(records).catch(() => [])) {
    const gitdir = await readFile(join(records, name, 'gitdir'), 'utf8').catch(() => '');
    // Relative to the record, when git writes relative paths (worktree.useRelativePaths).
    if (gitdir.trim() && resolve(join(records, name), gitdir.trim()) === join(top, '.git')) return { top, admin: join(records, name) };
  }
  return null;
}

/** What git leaves half done in a worktree, by the file it keeps while it’s under way. */
const MIDWAY = {
  MERGE_HEAD: 'merge',
  CHERRY_PICK_HEAD: 'cherry-pick',
  REVERT_HEAD: 'revert',
  'rebase-merge': 'rebase',
  'rebase-apply': 'rebase or am',
  BISECT_START: 'bisect',
};

/**
 * Which operation is half done in the worktree, or null. @param {(args: string[]) => ReturnType<Git>} git  git pinned
 * to the worktree @param {string} cwd  where it runs, which a relative --git-path is from
 */
async function inProgress(git, cwd) {
  const names = Object.keys(MIDWAY);
  const paths = await git(['rev-parse', ...names.flatMap((n) => ['--git-path', n])]);
  if (paths.code !== 0) return 'git operation';
  const lines = paths.stdout.split('\n');
  for (const [i, name] of names.entries()) if (lines[i] && (await exists(resolve(cwd, lines[i])))) return MIDWAY[/** @type {keyof typeof MIDWAY} */ (name)];
  return null;
}
