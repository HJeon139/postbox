// Grant once (#852): a push a room rule passes is Postbox’s own (push-on-request.mjs), and a lease is the remote’s to
// check. Postbox pushes the commit it read from .git with --force-with-lease=refs/heads/<b>:<sha>, where <sha> is the
// one the agent’s command named: the remote replaces the branch only while it’s still there, and the line names what
// it replaced. It runs git, so it’s a process test, in temp folders it removes, with none of your own git config.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pushPlan, runPush } from '../../server/push-on-request.mjs';
import { tempDir } from '../temp-dirs.mjs';

const home = tempDir('pb-grant-home-');
const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
await writeFile(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');

/** A bare remote with main and feat/now pushed, and a clone on feat/now with its history rewritten since. */
function rewritten() {
  const root = tempDir('pb-grant-');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe', timeout: 10000 }).toString().trim();
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  git(root, 'clone', '-q', remote, 'work');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'first');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feat/now');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'second');
  git(work, 'push', '-q', 'origin', 'feat/now');
  const pushed = git(work, 'rev-parse', 'HEAD');
  git(work, 'reset', '-q', '--hard', 'main');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'rewritten');
  return { work, remote, pushed, at: () => git(remote, 'rev-parse', 'refs/heads/feat/now') };
}

test('grant once: a lease on the commit the remote holds replaces the branch, and says what it replaced', async () => {
  const r = rewritten();
  const plan = await pushPlan(r.work, { branch: 'feat/now' });
  assert.deepEqual(await runPush({ url: r.remote, ...plan, lease: r.pushed }), { ok: true, replaced: r.pushed });
  assert.equal(r.at(), plan.sha);
});

test('grant once: a stale lease is refused by the remote, and the branch stays as it was', async () => {
  const r = rewritten();
  const plan = await pushPlan(r.work, { branch: 'feat/now' });
  const stale = '1'.repeat(40);
  const refused = await runPush({ url: r.remote, ...plan, lease: stale });
  assert.equal(refused.ok, false);
  assert.equal(r.at(), r.pushed);
  const noLease = await runPush({ url: r.remote, ...plan });
  assert.equal(noLease.ok, false, 'without a lease it never forces');
  assert.deepEqual(await runPush({ url: r.remote, ...plan, lease: 'not-a-sha' }), { ok: false, error: 'the push wasn’t one Postbox can make' });
});
