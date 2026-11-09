// A UAT run’s agents can’t change the person’s real GitHub unless the scenario says so (tools/uat/github-guard.mjs).
// Real git, a real gh and a real shell, on the environment the runner gives Postbox, in temp folders (tests/AGENTS.md):
// the “person’s” sign-in here is a made-up token in a folder of this test’s, and no remote is one anything listens on.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { NO_TOKEN, remotePaths, seedGitRemote } from '../../tools/uat/git-remote.mjs';
import { preflightRun } from '../../tools/uat/github-guard.mjs';
import { runEnv } from '../../tools/uat/run-env.mjs';
import { tempDir } from '../temp-dirs.mjs';

const home = tempDir('postbox-uat-github-home-');
const TOKEN = 'made-up-person-token';
const sh = (cmd, args, env, cwd) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 20_000 });
const hasGh = sh('gh', ['--version'], process.env).status === 0;
const needsGh = { skip: !hasGh && 'gh isn’t installed' };

/** A gh config folder signed in as the person, with a token that’s made up. */
function signedIn() {
  const dir = tempDir('postbox-uat-github-person-');
  writeFileSync(join(dir, 'hosts.yml'), `github.com:\n    oauth_token: ${TOKEN}\n    user: person\n    git_protocol: https\n`);
  return dir;
}
/** This computer as the person left it: signed in to gh, with nothing of the test runner’s own GitHub variables. */
function personEnv() {
  const { GH_TOKEN: _a, GITHUB_TOKEN: _b, GH_ENTERPRISE_TOKEN: _c, GITHUB_ENTERPRISE_TOKEN: _d, ...rest } = process.env;
  return { ...rest, HOME: home, SHELL: '/bin/sh', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GH_CONFIG_DIR: signedIn() };
}
/** The environment a run’s Postbox and its agents get, over the person’s. */
function agentEnv(scenario, base = personEnv()) {
  const dir = tempDir('postbox-uat-github-run-');
  const paths = { streams: join(dir, 'streams'), kiroStreams: '', agyStreams: '', codexStreams: '' };
  return {
    dir,
    env: {
      ...base,
      ...runEnv({ gate: { env: {} }, paths, scenario: { seed: null, gh: 'yes', skills: 'on', ...scenario }, dir, opt: { telemetry: 'no' }, faults: null }),
    },
  };
}
/** A clone of the person’s, somewhere else on this computer, with a commit and this remote. */
function clone(url) {
  const path = join(tempDir('postbox-uat-github-clone-'), 'clone');
  mkdirSync(path);
  const env = personEnv();
  sh('git', ['init', '-q', '-b', 'main', path], env);
  sh('git', ['-C', path, 'remote', 'add', 'origin', url], env);
  sh('git', ['-C', path, '-c', 'user.name=UAT', '-c', 'user.email=uat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'a'], env);
  return path;
}

describe('an agent’s gh has no login', () => {
  test('the person’s gh sign-in doesn’t reach an agent', needsGh, () => {
    const out = sh('gh', ['auth', 'token'], agentEnv({}).env);
    assert.equal(out.stdout.trim(), NO_TOKEN);
  });

  test('a GH_TOKEN or GITHUB_TOKEN of the person’s doesn’t reach an agent', needsGh, () => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      const out = sh('gh', ['auth', 'token'], agentEnv({}, { ...personEnv(), [name]: TOKEN }).env);
      assert.equal(out.stdout.trim(), NO_TOKEN, name);
    }
  });

  test('a scenario that says `- github: real` keeps the person’s sign-in', needsGh, () => {
    const out = sh('gh', ['auth', 'token'], agentEnv({ github: 'real' }).env);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), TOKEN);
  });
});

describe('an agent’s git reaches no network remote', () => {
  for (const [transport, url] of [
    ['https', 'https://127.0.0.1:9/uat/none.git'],
    ['ssh', 'ssh://127.0.0.1:9/uat/none.git'],
  ]) {
    test(`a push to ${transport} from a real clone at an absolute path is refused before it connects`, () => {
      const path = clone(url);
      const out = sh('git', ['-C', path, 'push', 'origin', 'main'], agentEnv({}).env, home);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, new RegExp(`transport '${transport}' not allowed`));
    });
  }

  test('git hands an agent no credential from the person’s helper', () => {
    // The person’s global config names a helper, as osxkeychain is on a Mac; this one prints a made-up password.
    const person = tempDir('postbox-uat-github-helper-home-');
    writeFileSync(join(person, '.gitconfig'), `[credential]\n\thelper = "!f() { echo username=person; echo password=${TOKEN}; }; f"\n`);
    const ask = 'protocol=https\nhost=github.com\n\n';
    const fill = (env) => spawnSync('git', ['credential', 'fill'], { env: { ...env, HOME: person }, input: ask, encoding: 'utf8', timeout: 20_000 });
    assert.match(fill(personEnv()).stdout, new RegExp(`password=${TOKEN}`), 'the control: the person’s own git gets it');
    assert.doesNotMatch(fill(agentEnv({}).env).stdout, /password=/);
  });

  test('a push to a local path still lands', () => {
    const remote = join(tempDir('postbox-uat-github-bare-'), 'remote.git');
    sh('git', ['init', '-q', '--bare', '-b', 'main', remote], personEnv());
    const path = clone(remote);
    const { env } = agentEnv({});
    const out = sh('git', ['-C', path, 'push', '-q', 'origin', 'main'], env, home);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(sh('git', ['-C', remote, 'rev-parse', '--verify', '-q', 'main'], env).status, 0);
  });
});

describe('the run checks the guard before Postbox starts', () => {
  test('it passes on the environment the runner gives Postbox', () => {
    const { dir, env } = agentEnv({});
    assert.doesNotThrow(() => preflightRun({ seed: null }, dir, dir, env));
  });

  test('a shell whose gh still has a login stops the run', needsGh, () => {
    const { dir, env } = agentEnv({});
    const unguarded = { ...env, GH_CONFIG_DIR: signedIn(), GH_TOKEN: '', GH_ENTERPRISE_TOKEN: '' };
    assert.throws(() => preflightRun({ seed: null }, dir, dir, unguarded), /gh in the agent’s shell can still reach a GitHub login, so the run stops/);
  });

  test('a shell whose git can still reach https stops the run', () => {
    const { dir, env } = agentEnv({});
    const { GIT_ALLOW_PROTOCOL: _a, GIT_CONFIG_COUNT: _b, ...open } = env;
    assert.throws(() => preflightRun({ seed: null }, dir, dir, open), /git in the agent’s shell isn’t refused an https remote/);
  });

  test('a computer with no gh at all has no login to reach, and the run goes on', () => {
    const { dir, env } = agentEnv({});
    // A shell that skips the profile, with only git on PATH: a login shell could bring an installed gh back.
    const bin = join(dir, 'only-git');
    mkdirSync(bin);
    symlinkSync(sh('/bin/sh', ['-c', 'command -v git'], process.env).stdout.trim(), join(bin, 'git'));
    const shell = join(dir, 'shell');
    writeFileSync(shell, `#!/bin/sh\nPATH=${bin}; export PATH\nexec /bin/sh -c "$2"\n`);
    chmodSync(shell, 0o755);
    assert.doesNotThrow(() => preflightRun({ seed: null }, dir, dir, { ...env, SHELL: shell }));
  });

  test('a `- github: real` run isn’t held to it', () => {
    const { dir, env } = agentEnv({ github: 'real' });
    assert.doesNotThrow(() => preflightRun({ seed: null, github: 'real' }, dir, dir, env));
  });

  test('a git-remote run’s fake gh, which answers every call, doesn’t read as a login', () => {
    const { dir } = agentEnv({});
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    sh('git', ['init', '-q', '-b', 'main', workspace], personEnv());
    seedGitRemote(workspace, dir);
    const paths = { streams: join(dir, 'streams'), kiroStreams: '', agyStreams: '', codexStreams: '' };
    const scenario = { seed: 'git-remote', gh: 'yes', skills: 'on' };
    const env = { ...personEnv(), ...runEnv({ gate: { env: {} }, paths, scenario, dir, opt: { telemetry: 'no' }, faults: null }) };
    assert.doesNotThrow(() => preflightRun(scenario, workspace, dir, env));
    assert.equal(env.PATH.split(':')[0], remotePaths(dir).bin);
    const fromFile = sh('/bin/sh', ['-c', `. '${remotePaths(dir).envFile}'; printf %s "$GH_TOKEN"`], { ...env, GH_TOKEN: '' });
    assert.equal(fromFile.stdout, NO_TOKEN, 'the file the agent’s shell sources after its profile keeps gh off the keychain');
  });
});

describe('the check runs in a shell like the agent’s, a login shell', () => {
  test('a login profile that undoes the guard stops the run', needsGh, () => {
    const { dir, env } = agentEnv({});
    // A login shell reads the profile after the environment it inherited, so a profile can put a login back.
    const profileHome = tempDir('postbox-uat-github-profile-');
    writeFileSync(join(profileHome, '.profile'), `unset GH_TOKEN\nexport GH_CONFIG_DIR='${signedIn()}'\n`);
    assert.throws(
      () => preflightRun({ seed: null }, dir, dir, { ...env, HOME: profileHome }),
      /gh in the agent’s shell can still reach a GitHub login, so the run stops/,
    );
  });
});
