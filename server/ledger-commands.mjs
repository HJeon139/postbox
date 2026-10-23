// The commits and branches a command made that its tool call doesn’t say (#156), from its git folder as it starts
// and as it ends: a commit inside a compound command (`… && git add … && git commit -q …`), which Claude Code
// reports no gitOperation for. Read-only, through the ledger’s git (server/ledger-git.mjs).
//
// Files a command changes (a `sed`, a formatter) aren’t seen from here: git answers for the start only after a quick
// command may be done, so a change can’t be pinned on it. #240 takes that snapshot before the command runs, through
// Claude Code’s PreToolUse hook. HEAD and the branches are quick to read, and a commit is slow to make, so they hold.

import { clip } from './ledger-git.mjs';
import { newId } from './store.mjs';

/** New commits one command can record. */
const COMMITS = 50;
/** Seconds a commit’s committer date may be older than the command and still be its (clocks, and a second’s rounding). */
const SKEW = 5;

/** What the ledger keeps of each git folder: the commands running there, and a queue so they compare one at a time. */
export const folderWatch = () => ({ live: new Map(), locks: new Map() });

/** A folder git didn’t know as the command started (it ran `git init`): no HEAD, no branches. */
const EMPTY = { head: null, branch: '', refs: new Map(), remotes: new Map() };

const rootFor = (ledger, dir) => (dir ? ledger.rootOf(dir) : null);
/** Runs fn for one folder at a time, so two commands that end together record a commit once. */
function serial(ledger, root, fn) {
  const run = (ledger.folders.locks.get(root) ?? Promise.resolve()).then(fn);
  ledger.folders.locks.set(
    root,
    run.catch(() => {}),
  );
  return run;
}

/** Where a folder stands in git: { head, branch, refs: Map(branch → tip), remotes: Map(ref → tip) }, or null. */
async function snapshot(ledger, root) {
  const [head, branch, refs] = await Promise.all([
    ledger.git(root, ['rev-parse', '--verify', '-q', 'HEAD']),
    ledger.git(root, ['symbolic-ref', '-q', '--short', 'HEAD']),
    ledger.git(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes']),
  ]);
  if (refs.code !== 0) return null;
  const tips = new Map();
  const remotes = new Map();
  for (const l of refs.stdout.split('\n').filter(Boolean)) {
    const [sha, name] = [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)];
    if (name.startsWith('refs/heads/')) tips.set(name.slice(11), sha);
    else remotes.set(name, sha);
  }
  return { head: head.code === 0 ? head.stdout.trim() || null : null, branch: branch.code === 0 ? branch.stdout.trim() : '', refs: tips, remotes };
}

/** A turn ended: its commands that still run can’t be followed, except one in the background, until it ends. */
export function turnEnded(ledger, w) {
  for (const [id, c] of ledger.folders.live) if (c.turn.work === w && ledger.entry(w.convId, id)?.state !== 'background') ledger.folders.live.delete(id);
}

/** A command starts in the agent’s folder: git is asked where its repository stands, the command’s own before. */
export function commandStarted(ledger, turn, cmdId) {
  const w = turn.work;
  const cmd = { id: cmdId, turn, cwd: w.folder ?? w.projectFolder, at: Date.now(), root: null };
  cmd.start = ledger
    .track(
      (async () => {
        cmd.root = await rootFor(ledger, cmd.cwd);
        return cmd.root ? snapshot(ledger, cmd.root) : null;
      })(),
    )
    .then((s) => s ?? null);
  ledger.folders.live.set(cmdId, cmd);
}

/**
 * A command ended, or ended in the background: the commits and branches it made, in the repository its start was read
 * in. Claude Code’s own folder for git (vcsCwd) isn’t used: it can be left over from an earlier command.
 */
export async function commandSeen(ledger, turn, cmdId) {
  const { live } = ledger.folders;
  const cmd = live.get(cmdId);
  const e = ledger.entry(turn.work.convId, cmdId);
  if (!cmd || e?.state === 'background') return; // its end comes with taskEnded
  if (e?.state === 'denied') return live.delete(cmdId); // it never ran
  await cmd.start;
  // A folder that had no repository may have one now (`git init`): it’s asked again, not taken from the cache.
  let root = cmd.root;
  if (!root && cmd.cwd) {
    ledger.roots.delete(cmd.cwd);
    root = await rootFor(ledger, cmd.cwd);
  }
  if (!root) return live.delete(cmdId);
  await serial(ledger, root, () => compare(ledger, cmd, root));
}

async function compare(ledger, cmd, root) {
  const { live } = ledger.folders;
  const after = await snapshot(ledger, root);
  live.delete(cmd.id);
  if (!after) return;
  // Commands running beside it in the same repository: a commit it made while they ran is theirs to list too, each
  // against its own start.
  const beside = [];
  for (const c of live.values()) if (c.root === root) beside.push(c);
  for (const c of [cmd, ...beside]) await newCommits(ledger, c, root, (await c.start) ?? EMPTY, after, beside.length > 0);
  const convId = cmd.turn.work.convId;
  const before = (await cmd.start) ?? EMPTY;
  for (const name of after.refs.keys()) {
    if (
      before.refs.has(name) ||
      ledger.entries(convId).some((x) => x.kind === 'branch' && x.name === name && (x.commandId === cmd.id || [cmd.cwd, root].includes(x.cwd)))
    )
      continue;
    ledger.add(convId, ledger.base(cmd.turn, { kind: 'branch', id: newId('wb'), commandId: cmd.id, name: clip(name, 200), cwd: cmd.cwd }));
  }
  await leftBranch(ledger, cmd, root, before, after);
}

/**
 * The commits that HEAD, or a branch that moved, gained since this command started, made after it started, recorded
 * once in its conversation on the branch that gained them. A commit its own start already had is never its. One a
 * remote branch has isn’t the agent’s (a pull, a rebase onto it), unless the command pushed.
 */
async function newCommits(ledger, c, root, before, after, overlap) {
  const conv = c.turn.work.convId;
  const pushed = /\bgit\b[^;&|]*\bpush\b/.test(ledger.entry(conv, c.id)?.command ?? '');
  const had = [before.head, ...before.refs.values(), ...before.remotes.values(), ...(pushed ? [] : after.remotes.values())].filter(Boolean);
  const moved = [...after.refs].filter(([n, t]) => before.refs.get(n) !== t).map(([n, t]) => [t, n]);
  const found = new Map(); // sha → branch
  for (const [tip, name] of [[after.head, after.branch], ...moved]) {
    if (!tip || had.includes(tip)) continue;
    const r = await ledger.git(root, ['log', '--reverse', `--max-count=${COMMITS}`, '--format=%H %ct', tip, '--not', ...had]);
    for (const l of r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []) {
      const [sha, ct] = l.split(' ');
      if (Number(ct) >= c.at / 1000 - SKEW && !found.has(sha)) found.set(sha, name);
    }
  }
  const known = (sha) => ledger.entries(conv).find((x) => x.kind === 'commit' && (x.sha.startsWith(sha) || sha.startsWith(x.sha)));
  for (const [sha, branch] of found) {
    if (known(sha)) continue;
    await ledger.recordCommit(c.turn, c.id, { sha, branch }, root, '');
    if (overlap) ledger.patch(conv, known(sha).id, { overlap: true });
  }
}

/** Commits recorded here that HEAD had and no longer has, nor any branch: amended, reset or rebased away. */
async function leftBranch(ledger, cmd, root, before, after) {
  if (!before.head || before.head === after.head) return;
  const r = await ledger.git(root, ['rev-list', `--max-count=${COMMITS}`, before.head, '--not', ...[after.head, ...after.refs.values()].filter(Boolean)]);
  if (r.code !== 0) return;
  const gone = r.stdout.split('\n').filter(Boolean);
  const conv = cmd.turn.work.convId;
  for (const x of ledger.entries(conv))
    if (x.kind === 'commit' && !x.left && gone.some((s) => s.startsWith(x.sha) || x.sha.startsWith(s))) ledger.patch(conv, x.id, { left: true });
}
