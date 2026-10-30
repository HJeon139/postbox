// #296, the review of #562: a push the person asked for is made by Postbox itself, from an empty repository of its
// own that borrows the agent’s objects, so nothing the agent set in its repository’s git config or hooks applies. It
// runs git, so it’s a process test: in temp folders it removes, with none of your own git config.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pushConsequence, pushOf, pushPlan, runPush } from '../../server/push-on-request.mjs';

const home = await mkdtemp(join(tmpdir(), 'pb-push-home-'));
const roots = [home];
const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
await writeFile(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');
after(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

/** A bare remote with main, and a clone on feat/now one commit ahead. */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'pb-push-'));
  roots.push(root);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe', timeout: 10000 }).toString().trim();
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  git(root, 'clone', '-q', remote, 'work');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'first');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feat/now');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'second');
  return { root, work, remote, git: (...args) => git(work, ...args), at: (ref) => git(remote, 'rev-parse', '--verify', '-q', ref) };
}

test('only a lone push to origin is one Postbox makes: no chain, other remote, refspec or other flag', () => {
  assert.deepEqual(pushOf('git push'), { branch: null });
  assert.deepEqual(pushOf('git push -u origin feat/now'), { branch: 'feat/now' });
  assert.deepEqual(pushOf('git push origin HEAD'), { branch: null });
  for (const command of [
    'git add -A && git push',
    'git push evil feat/now',
    'git push origin +feat/now',
    'git push origin feat/now:main',
    'git push origin :feat/now',
    'git push --force',
    'git push --mirror',
    'git push origin feat/now extra',
    'git push origin ../x',
    'git push origin -x',
    'GIT_DIR=x git push',
  ])
    assert.equal(pushOf(command), null, command);
});

test('#562’s review: Postbox’s push lands the branch at its commit, whatever the agent set in config or hooks', async () => {
  const r = await repo();
  const elsewhere = join(r.root, 'elsewhere.git');
  execFileSync('git', ['init', '-q', '--bare', elsewhere], { env, timeout: 10000 });
  // Each of these redirected or widened an agent’s own push, or ran a program, in the review.
  for (const [key, value] of [
    ['remote.origin.mirror', 'true'],
    ['remote.origin.push', '+refs/heads/*:refs/heads/*'],
    ['remote.origin.pushurl', elsewhere],
    [`url.${elsewhere}.insteadOf`, r.remote],
    ['core.hooksPath', join(r.root, 'hooks')],
    ['push.recurseSubmodules', 'on-demand'],
  ])
    r.git('config', key, value);
  r.git('remote', 'set-url', 'origin', elsewhere);
  const ran = join(r.root, 'hook-ran');
  await writeFile(join(r.work, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch ${ran}\n`, { mode: 0o755 });
  const plan = await pushPlan(r.work, { branch: null });
  assert.deepEqual([plan?.branch, plan?.current, plan?.sha], ['feat/now', 'feat/now', r.git('rev-parse', 'HEAD')]);
  assert.deepEqual(await runPush({ url: r.remote, ...plan }), { ok: true });
  assert.equal(r.at('refs/heads/feat/now'), plan.sha, 'the branch landed at its commit, in the project’s repository');
  assert.ok(r.at('refs/heads/main'), 'a mirror would have deleted main');
  assert.equal(existsSync(ran), false, 'no hook ran');
  assert.equal(execFileSync('git', ['-C', elsewhere, 'for-each-ref'], { env }).toString(), '', 'nothing went where the agent pointed origin');
});

test('Postbox’s push never forces, and reads a packed branch and a worktree from their files', async () => {
  const r = await repo();
  const plan = await pushPlan(r.work, { branch: 'feat/now' });
  assert.deepEqual(await runPush({ url: r.remote, ...plan }), { ok: true });
  r.git('reset', '-q', '--hard', 'main');
  r.git('commit', '-q', '--allow-empty', '-m', 'rewritten');
  r.git('pack-refs', '--all');
  const rewritten = await pushPlan(r.work, { branch: 'feat/now' });
  assert.equal(rewritten?.sha, r.git('rev-parse', 'HEAD'), 'read from packed-refs');
  const refused = await runPush({ url: r.remote, ...rewritten });
  assert.equal(refused.ok, false, 'a push that isn’t a fast-forward is refused, never forced');
  assert.equal(r.at('refs/heads/feat/now'), plan.sha);
  const wt = join(r.root, 'wt');
  r.git('worktree', 'add', '-q', '-b', 'feat/wt', wt);
  const inTree = await pushPlan(wt, { branch: null });
  assert.deepEqual([inTree?.branch, inTree?.current], ['feat/wt', 'feat/wt']);
  assert.deepEqual(await runPush({ url: r.remote, ...inTree }), { ok: true });
});

test('a branch the person didn’t name must be the one checked out, and never the default; no repository, no push', async () => {
  const r = await repo();
  const at = (named, push = { branch: null }, url = r.remote) => pushConsequence({ folder: r.work, url, push, named });
  const c = await at('push it.');
  assert.match(c?.sentence ?? '', /^commit [0-9a-f]{7} lands on branch feat\/now of .*remote\.git, with no force$/);
  assert.equal(await at('push it.', { branch: 'main' }), null, 'main, not named');
  assert.ok(await at('push main too.', { branch: 'main' }), 'main, named');
  assert.equal(await at('push it.', { branch: 'other' }), null, 'a branch with no commit');
  assert.equal(await at('push it.', { branch: null }, null), null, 'no repository set on the project');
  assert.equal(await at('push it.', { branch: null }, 'ext::sh -c touch% /tmp/x'), null);
  r.git('checkout', '-q', 'main');
  assert.equal(await at('push it.'), null, 'a bare push from the default branch');
});
