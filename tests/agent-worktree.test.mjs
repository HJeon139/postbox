// #1709: Antigravity agents that shared a project’s folder ran one turn at a time, since each turn writes Postbox’s
// plugin into its folder. Each agent with no folder of its own now gets its own git worktree of the project’s
// repository (server/adapters/agent-worktree.mjs), so two agents’ turns don’t share a folder and don’t wait. Git is a
// fake here, answering as git does (the unit tests can’t start processes, tests/guard.mjs); the same paths against
// real git are in tests/process/agent-worktree.test.mjs.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorktree, branchFor, sharedFolder, worktreesRootFor } from '../server/adapters/agent-worktree.mjs';
import { AntigravityCliAdapter, FolderQueue } from '../server/adapters/antigravity-cli.mjs';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const no = (stderr = '') => ({ code: 1, stdout: '', stderr });

/**
 * A fake git over a repository at `top`: `repo` says whether there is one, `prefix` where the project sits below its
 * top, `branches` the branches that exist, and `refuse` makes `worktree add` fail as git does for a branch checked
 * out elsewhere. A worktree add makes its folder and `.git`. Each call is kept, without its `-c` settings.
 * @param {{ top: string, repo?: boolean, prefix?: string, branches?: string[], refuse?: boolean }} o
 */
function fakeGit({ top, repo = true, prefix = '', branches = [], refuse = false }) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../server/adapters/agent-worktree.mjs').Git} */
  const git = async (cwd, given) => {
    const args = given[0] === '-c' ? given.slice(2) : given;
    calls.push([cwd, ...args]);
    const [sub, a1, a2] = args;
    if (sub === 'rev-parse' && a1 === '--show-toplevel')
      return repo ? ok(`${top}\n${prefix}\n`) : { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    if (sub === 'rev-parse' && a2 === '--quiet') return args[3] === 'HEAD' || branches.includes(args[3].replace('refs/heads/', '')) ? ok('abc\n') : no();
    if (sub === 'worktree' && a1 === 'prune') return ok();
    if (sub === 'worktree' && a1 === 'add') {
      if (refuse) return { code: 128, stdout: '', stderr: "fatal: 'postbox/x-a' is already checked out at '/elsewhere'\n" };
      const dir = a2 === '-b' ? args[4] : a2;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.git'), 'gitdir: /repo/.git/worktrees/x\n');
      return ok();
    }
    return no(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls };
}

/**
 * A data folder with a project folder in it, its fake git, and where a persona’s worktree goes.
 * @param {import('node:test').TestContext} t @param {{ repo?: boolean, prefix?: string, branches?: string[], refuse?: boolean }} [o]
 */
function rig(t, o = {}) {
  const data = mkdtempSync(join(tmpdir(), 'pb-wt-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const workRoot = join(data, 'work');
  const project = { id: 'pr_AbCd1234', folder: join(data, 'project') };
  mkdirSync(project.folder, { recursive: true });
  const { git, calls } = fakeGit({ top: project.folder, ...o });
  /** @type {string[]} */
  const logs = [];
  const folderOf = (/** @type {any} */ persona) => agentWorktree(persona, project, workRoot, { git, log: (l) => logs.push(l) });
  const repoKey = createHash('sha256').update(project.folder).digest('hex').slice(0, 8);
  const wtOf = (/** @type {{ id: string }} */ persona) => join(worktreesRootFor(workRoot), 'pr_AbCd1234', `${persona.id}-${repoKey}`);
  const adds = () => calls.filter((c) => c[1] === 'worktree' && c[2] === 'add');
  return { workRoot, project, calls, logs, folderOf, wtOf, adds };
}

const A = { id: 'pe_Aaaa1111', handle: 'a' };
const B = { id: 'pe_Bbbb2222', handle: 'b' };

test('#1709 two agents in one project’s repository each get a worktree of their own, on a branch of their own', async (t) => {
  const r = rig(t);
  const [a, b] = await Promise.all([r.folderOf(A), r.folderOf(B)]);
  assert.equal(a, r.wtOf(A));
  assert.equal(b, r.wtOf(B));
  assert.deepEqual(
    r
      .adds()
      .map((c) => c.slice(1))
      .sort(),
    [
      ['worktree', 'add', '-b', 'postbox/pr_AbCd1234-a', a],
      ['worktree', 'add', '-b', 'postbox/pr_AbCd1234-b', b],
    ],
  );
  assert.equal(branchFor(A, r.project), 'postbox/pr_AbCd1234-a', 'the project’s and the agent’s');
  assert.ok(
    r.adds().every((c) => c[0] === r.project.folder),
    'made from the project’s repository',
  );
  // So their turns don’t wait for each other: the queue is by folder.
  const queue = new FolderQueue();
  /** @type {string[]} */
  const order = [];
  let release = () => {};
  const held = new Promise((done) => {
    release = () => done(undefined);
  });
  const first = queue.run(a, async () => {
    order.push('a starts');
    await held;
    order.push('a ends');
  });
  await queue.run(b, async () => order.push('b runs'));
  assert.deepEqual(order, ['a starts', 'b runs'], 'b ran while a’s turn was still running');
  release();
  await first;
});

test('#1709 an agent’s worktree is made once and kept: its next turn, and two turns starting at once, use it', async (t) => {
  const r = rig(t);
  const [one, two] = await Promise.all([r.folderOf(A), r.folderOf(A)]);
  assert.equal(one, two);
  assert.equal(await r.folderOf(A), one);
  assert.equal(r.adds().length, 1, 'one worktree add');
});

test('#1709 an agent whose branch exists already gets a worktree on it, not a new branch', async (t) => {
  const r = rig(t, { branches: ['postbox/pr_AbCd1234-a'] });
  const dir = await r.folderOf(A);
  assert.deepEqual(r.adds()[0]?.slice(1), ['worktree', 'add', dir, 'postbox/pr_AbCd1234-a']);
});

test('#1709 a project folder below its repository’s top is the same folder within the worktree', async (t) => {
  const r = rig(t, { prefix: 'apps/web/' });
  assert.equal(await r.folderOf(A), join(r.wtOf(A), 'apps', 'web'));
});

test('#1709 elsewhere the folder is as it was: its own folder, a project with none, or one not in git', async (t) => {
  const r = rig(t);
  const own = join(r.workRoot, '..', 'own');
  assert.equal(await r.folderOf({ ...A, folder: own }), own);
  assert.equal(r.calls.length, 0, 'git isn’t asked for an agent with its own folder');
  const none = await agentWorktree(A, { id: 'pr_x', folder: null }, r.workRoot, { git: async () => assert.fail('no git') });
  assert.equal(none, join(r.workRoot, 'a'));
  const plain = rig(t, { repo: false });
  assert.equal(await plain.folderOf(A), plain.project.folder);
  assert.equal(plain.adds().length, 0);
});

test('#1709 a worktree git refuses leaves the agent in the project’s folder, and the log says why', async (t) => {
  const r = rig(t, { refuse: true });
  assert.equal(await r.folderOf(A), r.project.folder);
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /couldn’t make a worktree for @a .*already checked out/);
});

test('#1709 a worktree folder deleted by hand is pruned before it’s made again', async (t) => {
  const r = rig(t);
  await r.folderOf(A);
  await rm(r.wtOf(A), { recursive: true, force: true });
  await r.folderOf(A);
  assert.deepEqual(
    r.calls.filter((c) => c[1] === 'worktree').map((c) => c[2]),
    ['prune', 'add', 'prune', 'add'],
  );
});

test('#1709 a project pointed at another repository gets a worktree of that one', async (t) => {
  const r = rig(t);
  const first = await r.folderOf(A);
  const other = { ...r.project, folder: join(r.project.folder, '..', 'other') };
  mkdirSync(other.folder, { recursive: true });
  const second = await agentWorktree(A, other, r.workRoot, { git: fakeGit({ top: other.folder }).git });
  assert.notEqual(second, first);
  assert.ok(second.startsWith(join(worktreesRootFor(r.workRoot), 'pr_AbCd1234', 'pe_Aaaa1111-')));
});

test('#1709 a turn in an agent’s worktree isn’t also given the project’s shared folder', (t) => {
  const r = rig(t);
  assert.equal(sharedFolder(r.wtOf(A), r.project, r.workRoot), null);
  assert.equal(sharedFolder(join(r.wtOf(A), 'apps'), r.project, r.workRoot), null);
  assert.equal(sharedFolder(join(r.workRoot, 'a'), r.project, r.workRoot), r.project.folder);
});

test('#1709 the Antigravity adapter puts each agent in its own worktree', async (t) => {
  const r = rig(t);
  const adapter = new AntigravityCliAdapter({ bin: 'agy', workRoot: r.workRoot, git: fakeGit({ top: r.project.folder }).git });
  assert.equal(await adapter.folderFor(A, r.project), r.wtOf(A));
  assert.equal(await adapter.folderFor(B, r.project), r.wtOf(B));
});
