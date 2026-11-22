// #1125: git lfs doesn’t read GIT_ALLOW_PROTOCOL, so in a UAT run with no git-remote seed, which has no stand-in for
// git-lfs on its PATH, it would send a .netrc login to whatever server a repository names. The guard’s environment sets
// lfs.url and lfs.pushurl to a local path that isn’t there, which git config reads over every file, and an agent’s login
// profile doesn’t undo, as it can a PATH. Each way a repository can name its LFS server is tried, against a local server
// that counts what reaches it, with the rest of the guard, GIT_ALLOW_PROTOCOL=file included, as the control. Skipped where git lfs isn’t installed.

import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { LFS_OFF } from '../../tools/uat/git-remote.mjs';
import { noGithubEnv, preflightRun } from '../../tools/uat/github-guard.mjs';
import { tempDir } from '../temp-dirs.mjs';

const SECRET = 'made-up-1125-lfs-secret';
const person = () => ({ PATH: process.env.PATH, HOME: tempDir('postbox-uat-guard-lfs-'), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
const hasLfs = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8' }).status === 0;

/** An environment with the guard’s lfs entries taken out, the rest kept in their order. @param {Record<string, string|undefined>} env */
function withoutLfs(env) {
  const keep = Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k)));
  const entries = [];
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++)
    if (!String(env[`GIT_CONFIG_KEY_${i}`]).startsWith('lfs.')) entries.push([env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  entries.forEach(([k, v], i) => {
    keep[`GIT_CONFIG_KEY_${i}`] = k;
    keep[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return { ...keep, GIT_CONFIG_COUNT: String(entries.length) };
}

/** How a repository can name its LFS server, each set as the person would. */
const NAMED_BY = ['lfs.url', 'lfs.pushurl', 'remote.origin.lfsurl', 'remote.origin.lfspushurl', '.lfsconfig'];

test('#1125: git lfs in a run with no seed sends nothing, however the repository names an http server the .netrc has a login for', {
  skip: !hasLfs && 'git lfs isn’t installed',
}, async (t) => {
  const base = person();
  if (spawnSync('git', ['lfs', 'version'], { encoding: 'utf8', env: base }).status !== 0) return t.skip('git lfs doesn’t run with the test’s HOME');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(401, { 'lfs-authenticate': 'Basic realm="x"' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    writeFileSync(join(base.HOME, '.netrc'), `machine 127.0.0.1 login person password ${SECRET}\n`);
    const run = { ...base, ...noGithubEnv({}, tempDir('postbox-uat-guard-lfs-run-')) };
    const url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/lfs`;
    for (const how of NAMED_BY) {
      const repo = tempDir('postbox-uat-guard-lfs-repo-');
      const git = (/** @type {string[]} */ args, env = base) =>
        new Promise((r) => execFile('git', args, { cwd: repo, env, timeout: 30_000 }, (err) => r(err ? 1 : 0)));
      for (const args of [
        ['init', '-q'],
        ['remote', 'add', 'origin', join(repo, 'nowhere.git')],
        ['lfs', 'install', '--local'],
        ['lfs', 'track', '*.bin'],
      ])
        await git(args);
      if (how === '.lfsconfig') writeFileSync(join(repo, '.lfsconfig'), `[lfs]\n\turl = ${url}\n`);
      else await git(['config', how, url]);
      writeFileSync(join(repo, 'a.bin'), 'bytes');
      await git(['add', '-A']);
      await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x']);
      seen.length = 0;
      assert.notEqual(await git(['lfs', 'push', '--all', 'origin'], run), 0, `${how}: the run’s git lfs fails`);
      assert.deepEqual(seen, [], `${how}: no request reached the server`);
      // The control: the run’s guard without its lfs entries, which is the rest of it, GIT_ALLOW_PROTOCOL=file included.
      await git(['lfs', 'push', '--all', 'origin'], withoutLfs(run));
      assert.ok(seen.length > 0, `${how}: without them it reached the server`);
    }
  } finally {
    server.close();
  }
});

test('#1125: a run whose agents’ git has its lfs server back stops before any agent turn', () => {
  const env = { ...person(), ...noGithubEnv({}, tempDir('postbox-uat-guard-lfs-run-')) };
  assert.doesNotThrow(() => preflightRun({ seed: null }, env.HOME, env.HOME, env));
  // Each lfs entry of the guard, emptied in turn: git lfs would use the repository’s server again.
  for (const key of ['lfs.url', 'lfs.pushurl']) {
    const i = Object.keys(env)
      .find((k) => k.startsWith('GIT_CONFIG_KEY_') && env[k] === key)
      ?.slice('GIT_CONFIG_KEY_'.length);
    assert.ok(i, `the guard sets ${key}`);
    assert.throws(() => preflightRun({ seed: null }, env.HOME, env.HOME, { ...env, [`GIT_CONFIG_VALUE_${i}`]: '' }), /git lfs in the agent’s shell/, key);
  }
});

test('#1125: a custom LFS transfer agent neither runs under the guard nor lets a run whose git names one start', {
  skip: !hasLfs && 'git lfs isn’t installed',
}, async (t) => {
  const base = person();
  if (spawnSync('git', ['lfs', 'version'], { encoding: 'utf8', env: base }).status !== 0) return t.skip('git lfs doesn’t run with the test’s HOME');
  const ran = join(base.HOME, 'agent-ran');
  const agent = join(base.HOME, 'agent.sh');
  writeFileSync(agent, `#!/bin/sh\ntouch '${ran}'\nexit 1\n`, { mode: 0o755 });
  const run = { ...base, ...noGithubEnv({}, tempDir('postbox-uat-guard-lfs-run-')) };
  const repo = tempDir('postbox-uat-guard-lfs-repo-');
  const git = (/** @type {string[]} */ args, env = base) =>
    new Promise((r) => execFile('git', args, { cwd: repo, env, timeout: 30_000 }, (err) => r(err ? 1 : 0)));
  for (const args of [
    ['init', '-q'],
    ['remote', 'add', 'origin', join(repo, 'nowhere.git')],
    ['lfs', 'install', '--local'],
    ['lfs', 'track', '*.bin'],
  ])
    await git(args);
  // The repository picks a custom standalone transfer, for every server and for the guard’s own: the guard picks git lfs’s.
  await git(['config', 'lfs.customtransfer.mine.path', agent]);
  await git(['config', 'lfs.standalonetransferagent', 'mine']);
  await git(['config', `lfs.${LFS_OFF}.standalonetransferagent`, 'mine']);
  writeFileSync(join(repo, 'a.bin'), 'bytes');
  await git(['add', '-A']);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x']);
  await git(['lfs', 'push', '--all', 'origin'], run);
  assert.equal(existsSync(ran), false, 'the custom agent didn’t run in the run');
  await git(['lfs', 'push', '--all', 'origin'], withoutLfs(run));
  assert.equal(existsSync(ran), true, 'without the guard’s lfs entries it does: the control');
  // In the person’s own config, which a run with no seed keeps, one stops the run before any agent turn, as one only
  // the guard can’t pin (a URL spelled with a trailing slash) would still be picked.
  writeFileSync(join(base.HOME, '.gitconfig'), `[lfs "customtransfer.mine"]\n\tpath = ${agent}\n`);
  assert.throws(() => preflightRun({ seed: null }, base.HOME, base.HOME, run), /git lfs in the agent’s shell/, 'a custom transfer');
  writeFileSync(join(base.HOME, '.gitconfig'), `[lfs "${LFS_OFF}/"]\n\tstandalonetransferagent = mine\n`);
  assert.throws(() => preflightRun({ seed: null }, base.HOME, base.HOME, run), /git lfs in the agent’s shell/, 'a transfer picked past the pin');
});

test('#1125: the preflight reads git where the agents work, so the workspace’s own config can’t pass the runner’s check', () => {
  const base = person();
  const env = { ...base, ...noGithubEnv({}, tempDir('postbox-uat-guard-lfs-run-')) };
  const workspace = tempDir('postbox-uat-guard-lfs-ws-');
  spawnSync('git', ['init', '-q', workspace], { env: base });
  assert.doesNotThrow(() => preflightRun({ seed: null }, workspace, env.HOME, env), 'a plain workspace passes');
  // Settings only the workspace has: the runner’s own folder sees none of them.
  for (const [key, value, what] of [
    ['lfs.standalonetransferagent', 'mine', /git lfs in the agent’s shell/],
    [`lfs.${LFS_OFF}/.standalonetransferagent`, 'mine', /git lfs in the agent’s shell/],
  ]) {
    spawnSync('git', ['-C', workspace, 'config', key, value], { env: base });
    assert.throws(() => preflightRun({ seed: null }, workspace, env.HOME, env), what, key);
    spawnSync('git', ['-C', workspace, 'config', '--unset', key], { env: base });
  }
  // A credential helper only the workspace names is cleared by the guard’s empty one, which the environment adds after
  // every config file: the check passes, and so it should, since git there hands out nothing.
  spawnSync('git', ['-C', workspace, 'config', 'credential.https://github.com.helper', '!f() { echo password=x; }; f'], { env: base });
  assert.doesNotThrow(() => preflightRun({ seed: null }, workspace, env.HOME, env));
  const fill = spawnSync('git', ['credential', 'fill'], { cwd: workspace, env, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  assert.doesNotMatch(fill.stdout, /password=/);
});
