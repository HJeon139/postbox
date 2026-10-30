// #296, the review of #562: a git command a request covers runs as the repository’s config and hooks say, so Postbox
// reads them, and where a push goes, before it runs without a card. Each case here is one the review reproduced on a
// local bare repository. It runs git, so it’s a process test: in temp folders it removes, with none of your own git
// config (HOME and the global config point at an empty folder of its own).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gitOffRequest } from '../../server/git-request.mjs';

const home = await mkdtemp(join(tmpdir(), 'pb-git-home-'));
const roots = [home];
// gitOffRequest runs git with this process’s environment, so this file’s git reads only its own config.
Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
await writeFile(join(home, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.com\n');
after(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

/** A clone on feat/now, pushed with its upstream set, of a bare remote whose default branch is main. */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'pb-git-request-'));
  roots.push(root);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 10000 }).toString().trim();
  const work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  git(root, 'clone', '-q', join(root, 'remote.git'), 'work');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'first');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feat/now');
  git(work, 'push', '-q', '-u', 'origin', 'feat/now');
  return { work, git: (...args) => git(work, ...args) };
}

test('a plain push of the branch checked out, to origin, passes; one to the default branch needs its name', async () => {
  const r = await repo();
  for (const command of ['git push', 'git push origin', 'git push -u origin feat/now', 'git add -A && git commit -m "fix: x" && git push'])
    assert.equal(await gitOffRequest(r.work, command, 'push it.'), null, command);
  assert.equal(await gitOffRequest(r.work, 'git status', ''), null);
  assert.match(await gitOffRequest(r.work, 'git push origin main', 'push it to my feature branch.'), /branch main/);
  assert.equal(await gitOffRequest(r.work, 'git push origin main', 'push it to main.'), null);
  r.git('checkout', '-q', 'main');
  assert.match(await gitOffRequest(r.work, 'git push', 'push it.'), /branch main/, 'a bare push of the default branch');
});

test('#562’s review: a remote the person didn’t name, and a push or a program set in config, keep the card', async () => {
  const r = await repo();
  r.git('remote', 'add', 'evil', join(r.work, '..', 'remote.git'));
  assert.match(await gitOffRequest(r.work, 'git push evil feat/now', 'push it.'), /remote evil/);
  for (const [key, value] of [
    ['remote.origin.mirror', 'true'],
    ['remote.origin.push', '+refs/heads/*:refs/heads/*'],
    ['remote.origin.pushurl', '/tmp/elsewhere.git'],
    ['url./tmp/elsewhere.git.insteadOf', 'origin'],
    ['core.hooksPath', '.githooks'],
    ['push.default', 'matching'],
    ['core.fsmonitor', './watch.sh'],
    ['diff.external', './diff.sh'],
    ['gpg.program', './sign.sh'],
    ['credential.helper', '!./steal.sh'],
  ]) {
    const c = await repo();
    c.git('config', key, value);
    assert.ok(await gitOffRequest(c.work, 'git push', 'push it.'), key);
    assert.ok(await gitOffRequest(c.work, 'git status && gh pr create --title x --body y', 'open the pr.'), `${key} with git status`);
  }
});

test('#562’s review: a hook the agent could have written keeps the card for a push or a commit', async () => {
  for (const hook of ['pre-push', 'pre-commit', 'commit-msg']) {
    const r = await repo();
    await writeFile(join(r.work, '.git', 'hooks', hook), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.match(await gitOffRequest(r.work, 'git commit -am x && git push', 'commit and push it.'), new RegExp(hook));
  }
  assert.ok(await gitOffRequest(null, 'git push', 'push it.'), 'no folder, no reading');
  assert.equal(await gitOffRequest(null, 'gh pr create --title x --body y', 'open the pr.'), null, 'no git, nothing to read');
});
