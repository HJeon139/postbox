// `npm run hooks` (tools/hooks.mjs, #787): it points git at .githooks/, and says where hooks now come from, naming what
// git stops running: a hook of the person’s own in the clone’s hooks folder, or another core.hooksPath. Each case runs
// the real script through npm, as package.json names it, in a throwaway repository whose tools/ is the repo’s own. It
// runs git and npm, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'pb-test-hooks-'));
after(() => rm(home, { recursive: true, force: true }));
// Git and npm as a fresh install would be, whoever runs this: none of the person’s hooks, signing or npm config.
await writeFile(join(home, 'gitconfig'), '[user]\n\tname = Agent\n\temail = agent@example.com\n[init]\n\tdefaultBranch = main\n');
await writeFile(join(home, 'npmrc'), '');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  npm_config_userconfig: join(home, 'npmrc'),
  npm_config_update_notifier: 'false',
};
const { scripts } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

const run = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const git = (cwd, ...args) => run(cwd, 'git', args);
const hooks = (cwd) => run(cwd, 'npm', ['run', '-s', 'hooks']);
const hooksPath = (cwd) => git(cwd, 'config', '--get', 'core.hooksPath').out.trim();

/** A repository with one commit, the repo’s hooks script in its package.json, and the repo’s tools/. */
async function repo() {
  const dir = await mkdtemp(join(home, 'repo-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'hooks-test', private: true, scripts: { hooks: scripts.hooks } }));
  await symlink(join(ROOT, 'tools'), join(dir, 'tools'));
  git(dir, 'init', '-q', '.');
  git(dir, 'add', '.');
  assert.equal(git(dir, 'commit', '-q', '--no-verify', '-m', 'Start').code, 0);
  return dir;
}

/** Plants a hook of the person’s own in the clone’s hooks folder. */
async function plant(dir) {
  await writeFile(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho mine\n');
  await chmod(join(dir, '.git/hooks/pre-commit'), 0o755);
}

const NOW = 'hooks: git now runs the hooks in .githooks: commit-msg checks each message, and pre-commit runs npm run lint:project.';

test('npm run hooks names a hook of the person’s own in .git/hooks that git no longer runs, and points git at .githooks', async () => {
  const dir = await repo();
  await plant(dir);
  const r = hooks(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^hooks: git no longer runs pre-commit in \S*\.git\/hooks; move what you still need into \.githooks\.$/m);
  assert.ok(r.out.split('\n').includes(NOW), r.out);
  assert.equal(hooksPath(dir), '.githooks');
});

test('npm run hooks names a hook of the person’s own that is a symlink, as a hook manager installs one', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'mine.sh'), '#!/bin/sh\necho mine\n');
  await chmod(join(dir, 'mine.sh'), 0o755);
  await symlink(join(dir, 'mine.sh'), join(dir, '.git/hooks/pre-push'));
  const r = hooks(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^hooks: git no longer runs pre-push in \S*\.git\/hooks; move what you still need into \.githooks\.$/m);
});

test('npm run hooks with only git’s .sample hooks prints one line and no warning', async () => {
  const dir = await repo();
  const r = hooks(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, `${NOW}\n`);
  assert.equal(hooksPath(dir), '.githooks');
});

test('npm run hooks names the core.hooksPath it replaces, then sets it to .githooks', async () => {
  const dir = await repo();
  git(dir, 'config', 'core.hooksPath', '.husky');
  const r = hooks(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^hooks: core\.hooksPath was \.husky, so git no longer runs the hooks there; move what you still need into \.githooks\.$/m);
  assert.ok(r.out.split('\n').includes(NOW), r.out);
  assert.equal(hooksPath(dir), '.githooks');
});

test('npm run hooks in a worktree names a hook of the person’s own in the clone’s hooks folder', async () => {
  const dir = await repo();
  await plant(dir);
  assert.equal(git(dir, 'worktree', 'add', '-q', join(dir, 'wt')).code, 0);
  const r = hooks(join(dir, 'wt'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^hooks: git no longer runs pre-commit in \S*\.git\/hooks; /m);
  assert.equal(hooksPath(dir), '.githooks', 'the worktree shares the clone’s config');
});
