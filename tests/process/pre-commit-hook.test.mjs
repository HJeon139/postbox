// The opt-in pre-commit hook (#508): `npm run hooks` points git at .githooks/, and .githooks/pre-commit runs
// `npm run -s lint:project` before each commit, so a lint CI would fail stops the commit on the machine instead.
// Each case makes a throwaway repository with the real hook, the real lint-copy and its lint-lib, and a package.json
// whose lint:project runs only lint-copy, so a commit runs the real hook through real git and npm in a second or two.
// It runs git and npm, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'pb-test-pre-commit-'));
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

const run = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const git = (cwd, ...args) => run(cwd, 'git', args);

/** A repository with one commit, the hook turned on as `npm run hooks` does, and lint-copy as its lint:project. */
async function repo() {
  const dir = await mkdtemp(join(home, 'repo-'));
  await mkdir(join(dir, '.githooks'));
  await mkdir(join(dir, 'tools'));
  await mkdir(join(dir, 'server'));
  await copyFile(join(ROOT, '.githooks/pre-commit'), join(dir, '.githooks/pre-commit'));
  for (const f of ['lint-copy.mjs', 'lint-lib.mjs']) await copyFile(join(ROOT, 'tools', f), join(dir, 'tools', f));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'hook-test', private: true, type: 'module', scripts: { 'lint:project': 'node tools/lint-copy.mjs' } }),
  );
  await writeFile(join(dir, 'server/a.mjs'), '// One file.\nexport const a = 1;\n');
  git(dir, 'init', '-q', '.');
  git(dir, 'add', '.');
  assert.equal(git(dir, 'commit', '-q', '--no-verify', '-m', 'Start').code, 0);
  git(dir, 'config', 'core.hooksPath', '.githooks');
  return dir;
}
const commits = (dir) => Number(git(dir, 'rev-list', '--count', 'HEAD').out.trim());

test('a commit that a project lint fails is stopped, and the hook names the lint and the way around it', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'server/b.mjs'), '// The colour of the button.\nexport const b = 2;\n');
  git(dir, 'add', 'server/b.mjs');
  const r = git(dir, 'commit', '-m', 'Add b');
  assert.notEqual(r.code, 0, r.out);
  assert.equal(commits(dir), 1, 'nothing was committed');
  assert.match(r.out, /server\/b\.mjs:1 {2}.*colour/);
  assert.match(r.out, /pre-commit: lint-copy failed.*git commit --no-verify/);
});

test('a commit that passes the project lints goes through', async () => {
  const dir = await repo();
  await writeFile(join(dir, 'server/b.mjs'), '// The color of the button.\nexport const b = 2;\n');
  git(dir, 'add', 'server/b.mjs');
  const r = git(dir, 'commit', '-q', '-m', 'Add b');
  assert.equal(r.code, 0, r.out);
  assert.equal(commits(dir), 2);
});
