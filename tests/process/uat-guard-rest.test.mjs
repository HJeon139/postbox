// #1125, the rest: ways the person's credentials still reached a UAT run's agents past the git guard, each probed with a
// made-up helper, askpass or .netrc that prints a fake secret, and each checked against the person's own git first.

import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitRemoteEnv, guardEnv, preflightRemote, remotePaths, seedGitRemote } from '../../tools/uat/git-remote.mjs';
import { noGithubEnv, preflightRun } from '../../tools/uat/github-guard.mjs';
import { tempDir } from '../temp-dirs.mjs';

const SECRET = 'made-up-1125-secret';
const HELPER = `!f() { echo username=person; echo password=${SECRET}; }; f`;
const ASK = 'protocol=https\nhost=github.com\n\n';
/** A person's home with nothing in it, and git asked for a github.com password there. */
const person = () => ({ PATH: process.env.PATH, HOME: tempDir('postbox-uat-guard-rest-'), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
const fill = (env) => spawnSync('git', ['credential', 'fill'], { env, input: ASK, encoding: 'utf8', timeout: 20_000 }).stdout ?? '';

test('#1125: a helper named in an inherited GIT_CONFIG_PARAMETERS hands the guarded git nothing', () => {
  const theirs = { ...person(), GIT_CONFIG_PARAMETERS: `'credential.helper=${HELPER}'` };
  assert.match(fill(theirs), new RegExp(`password=${SECRET}`), 'the control: the person’s own git gets it');
  assert.doesNotMatch(fill({ ...theirs, ...guardEnv() }), /password=/);
});

/** A seeded git-remote run, and the environment its agents get over the person's. */
function remoteRun(base) {
  const dir = tempDir('postbox-uat-guard-rest-run-');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  spawnSync('git', ['init', '-q', '-b', 'main', workspace], { env: base });
  seedGitRemote(workspace, dir);
  return { dir, env: { ...base, ...gitRemoteEnv({ seed: 'git-remote' }, dir) } };
}

for (const name of ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_PARAMETERS']) {
  test(`#1125: a login profile that exports ${name} gives the agent’s shell nothing, once it sources the run’s env file`, () => {
    const base = person();
    const askpass = join(base.HOME, 'askpass');
    writeFileSync(askpass, `#!/bin/sh\necho ${SECRET}\n`);
    chmodSync(askpass, 0o755);
    const value = name === 'GIT_CONFIG_PARAMETERS' ? `"'credential.helper=${HELPER}'"` : askpass;
    writeFileSync(join(base.HOME, '.bash_profile'), `export ${name}=${value}\n`);
    const { dir, env } = remoteRun(base);
    const asked = (sourced) =>
      spawnSync('/bin/bash', ['-lc', `${sourced ? `. '${remotePaths(dir).envFile}'; ` : ''}printf '${ASK.replaceAll('\n', '\\n')}' | git credential fill`], {
        env,
        encoding: 'utf8',
        timeout: 20_000,
      }).stdout ?? '';
    if (name !== 'SSH_ASKPASS') assert.match(asked(false), new RegExp(`password=${SECRET}`), 'the control: the profile alone hands it out');
    assert.doesNotMatch(asked(true), /password=/);
  });
}

/** env without the guard's config entries, as an environment that lost them would be. */
const withoutGuardConfig = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k)));
const STOPS = /git in the agent’s shell can still hand out a password, so the run stops before any agent turn/;

test('#1125: the preflight stops a run whose git would still run the person’s credential helper', () => {
  const base = person();
  writeFileSync(join(base.HOME, '.gitconfig'), `[credential]\n\thelper = "${HELPER}"\n`);
  const dir = tempDir('postbox-uat-guard-rest-pre-');
  const env = { ...base, SHELL: '/bin/sh', ...noGithubEnv({ github: null }, dir) };
  assert.doesNotThrow(() => preflightRun({ seed: null }, dir, dir, env), 'the control: the whole guard passes');
  assert.match(fill(withoutGuardConfig(env)), new RegExp(`password=${SECRET}`), 'without its config, git hands it out');
  assert.throws(() => preflightRun({ seed: null }, dir, dir, withoutGuardConfig(env)), STOPS);
  assert.throws(() => preflightRun({ seed: null }, dir, dir, { ...env, GIT_CONFIG_PARAMETERS: `'credential.helper=${HELPER}'` }), STOPS);
  assert.throws(() => preflightRun({ seed: null }, dir, dir, { ...env, SSH_ASKPASS: '/bin/true' }), STOPS, 'an askpass variable');
  const askHome = person().HOME;
  writeFileSync(join(askHome, '.gitconfig'), '[core]\n\taskPass = /bin/true\n');
  assert.throws(() => preflightRun({ seed: null }, dir, dir, { ...withoutGuardConfig(env), HOME: askHome }), STOPS, 'a core.askPass');
});

test('#1125: the preflight stops a run whose git would still run a helper set for github.com alone', () => {
  const base = person();
  writeFileSync(join(base.HOME, '.gitconfig'), `[credential "https://github.com"]\n\thelper = "${HELPER}"\n`);
  const dir = tempDir('postbox-uat-guard-rest-url-');
  const env = { ...base, SHELL: '/bin/sh', ...noGithubEnv({ github: null }, dir) };
  // The guard's empty helper comes last, so git clears the site's one too, though it's the more specific.
  assert.doesNotMatch(fill(env), /password=/, 'the guard holds');
  assert.doesNotThrow(() => preflightRun({ seed: null }, dir, dir, env), 'the control: the whole guard passes');
  assert.match(fill(withoutGuardConfig(env)), new RegExp(`password=${SECRET}`), 'without its config, git hands it out');
  assert.throws(() => preflightRun({ seed: null }, dir, dir, withoutGuardConfig(env)), STOPS);
  const after = { ...env, GIT_CONFIG_PARAMETERS: `'credential.https://github.com.helper=${HELPER}'` };
  assert.match(fill(after), new RegExp(`password=${SECRET}`), 'a site helper set after the guard answers');
  assert.throws(() => preflightRun({ seed: null }, dir, dir, after), STOPS, 'a site helper after the guard');
});

test('#1125: a git-remote run’s preflight stops one whose agent shell would still answer with an askpass', () => {
  const { dir, env } = remoteRun({ ...person(), SHELL: '/bin/sh' });
  const workspace = join(dir, 'workspace');
  assert.doesNotThrow(() => preflightRemote(workspace, dir, env), 'the control');
  // Without the env file, the agent's shell keeps what it inherited: here, an askpass.
  const { CLAUDE_ENV_FILE: _f, ...noFile } = env;
  assert.throws(() => preflightRemote(workspace, dir, { ...noFile, GIT_ASKPASS: '/bin/true' }), STOPS);
});

const hasLfs = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8' }).status === 0;

test('#1125: git lfs in a git-remote run sends nothing, though lfs.url names an http server the .netrc has a login for', {
  skip: !hasLfs && 'git lfs isn’t installed',
}, async () => {
  const base = person();
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(401, { 'lfs-authenticate': 'Basic realm="x"' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    writeFileSync(join(base.HOME, '.netrc'), `machine 127.0.0.1 login person password ${SECRET}\n`);
    const { dir, env } = remoteRun(base);
    const repo = join(dir, 'workspace');
    const git = (args, e = env) => new Promise((r) => execFile('git', args, { cwd: repo, env: e, timeout: 30_000 }, (err) => r(err ? 1 : 0)));
    // Set up as the person would, with their own git lfs: one file in LFS, and lfs.url at the server.
    for (const args of [
      ['lfs', 'install', '--local'],
      ['lfs', 'track', '*.bin'],
      ['config', 'lfs.url', `http://127.0.0.1:${server.address().port}/lfs`],
      ['config', 'lfs.locksverify', 'false'],
    ])
      await git(args, base);
    writeFileSync(join(repo, 'a.bin'), 'bytes');
    await git(['add', '.gitattributes', 'a.bin'], base);
    await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x'], base);
    assert.notEqual(await git(['lfs', 'push', '--all', 'origin']), 0, 'the run’s git lfs refuses');
    assert.deepEqual(seen, [], 'no request reached the server');
    // The control: the person's own git lfs, outside the run, sends the login.
    await git(['lfs', 'push', '--all', 'origin'], base);
    assert.ok(seen.length > 0, 'the control reached it');
  } finally {
    server.close();
  }
});
