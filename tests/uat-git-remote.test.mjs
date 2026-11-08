// `- seed: git-remote` (#305, #296): the run’s throwaway remote takes pushes, nothing in the run reaches a real remote
// or a real gh, and the end of the run removes the remote and says what’s left. Real git, in temp folders.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { gitRemoteEnv, guardEnv, remoteFacts, remoteNote, remotePaths, seedGitRemote, tearDownRemote } from '../tools/uat/git-remote.mjs';

const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A run folder with its workspace, a git repository of its own as makeWorkspace makes it, and the remote seeded. */
function run() {
  const dir = mkdtempSync(join(tmpdir(), 'postbox-uat-git-remote-'));
  made.push(dir);
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  spawnSync('git', ['init', '-q', '-b', 'main', workspace]);
  seedGitRemote(workspace, dir);
  return { dir, workspace, env: { ...process.env, ...gitRemoteEnv({ seed: 'git-remote' }, dir) } };
}
const sh = (cmd, args, cwd, env) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 20_000 });
const commit = (r, n) => {
  writeFileSync(join(r.workspace, 'note.txt'), `change ${n}\n`);
  sh('git', ['add', 'note.txt'], r.workspace, r.env);
  return sh('git', ['-c', 'user.name=UAT', '-c', 'user.email=uat@example.invalid', 'commit', '-q', '-m', `change ${n}`], r.workspace, r.env);
};

describe('the throwaway remote', () => {
  test('takes every push to origin, and remote.json counts each one in order', () => {
    const r = run();
    for (let n = 1; n <= 3; n++) {
      assert.equal(commit(r, n).status, 0);
      const p = sh('git', ['push', '-q', 'origin', 'main'], r.workspace, r.env);
      assert.equal(p.status, 0, p.stderr);
    }
    const shas = sh('git', ['rev-list', '--reverse', 'main'], r.workspace, r.env).stdout.trim().split('\n');
    const facts = remoteFacts(r.dir, { state: { work: { c1: [{ kind: 'push' }, { kind: 'command' }] } }, threads: ['c1'] });
    assert.deepEqual(
      facts.pushes.map((x) => x.sha),
      shas,
    );
    const sample = facts.samples.at(-1);
    assert.deepEqual([sample.pushes, sample.entries, sample.ledgerPushes], [3, 2, 1]);
    assert.equal(JSON.parse(readFileSync(remotePaths(r.dir).record, 'utf8')).pushes.length, 3);
  });
});

describe('no git in the run reaches a real remote', () => {
  // 127.0.0.1:9 refuses at once, so the control case fails fast, with a connection error and not the guard’s.
  for (const url of ['https://127.0.0.1:9/uat/none.git', 'ssh://127.0.0.1:9/uat/none.git', 'git://127.0.0.1:9/uat/none.git']) {
    const transport = url.split(':')[0];
    test(`a push to ${url} is refused by the guard, before any connection`, () => {
      const r = run();
      commit(r, 1);
      const p = sh('git', ['push', url, 'main'], r.workspace, r.env);
      assert.notEqual(p.status, 0);
      assert.match(p.stderr, new RegExp(`transport '${transport}' not allowed`));
    });
  }

  test('a repository outside the workspace, with no guard of its own, is refused by the environment', () => {
    const r = run();
    const other = join(r.dir, 'elsewhere');
    sh('git', ['init', '-q', '-b', 'main', other], r.dir);
    writeFileSync(join(other, 'a.txt'), 'a\n');
    sh('git', ['add', 'a.txt'], other, r.env);
    sh('git', ['-c', 'user.name=UAT', '-c', 'user.email=uat@example.invalid', 'commit', '-q', '-m', 'a'], other, r.env);
    const p = sh('git', ['push', 'https://127.0.0.1:9/uat/none.git', 'main'], other, r.env);
    assert.match(p.stderr, /transport 'https' not allowed/);
  });

  test('the workspace’s own config refuses it too, when a shell drops the environment', () => {
    const r = run();
    commit(r, 1);
    const p = sh('git', ['push', 'https://127.0.0.1:9/uat/none.git', 'main'], r.workspace, { PATH: process.env.PATH, HOME: r.dir });
    assert.match(p.stderr, /transport 'https' not allowed/);
  });

  test('control: with neither guard, the same push tries to connect', () => {
    const r = run();
    commit(r, 1);
    for (const k of ['protocol.allow', 'protocol.file.allow']) sh('git', ['config', '--unset', k], r.workspace);
    const env = { PATH: process.env.PATH, HOME: r.dir, GIT_TERMINAL_PROMPT: '0' };
    const p = sh('git', ['push', 'https://127.0.0.1:9/uat/none.git', 'main'], r.workspace, env);
    assert.notEqual(p.status, 0);
    assert.doesNotMatch(p.stderr, /not allowed/);
  });
});

describe('what the guard is, and gh', () => {
  test('the guard is protocol.allow=never with only file allowed', () => {
    assert.deepEqual(guardEnv(), {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'protocol.allow',
      GIT_CONFIG_VALUE_0: 'never',
      GIT_CONFIG_KEY_1: 'protocol.file.allow',
      GIT_CONFIG_VALUE_1: 'always',
    });
  });

  test('gh on the run’s PATH is the fake one: it records the call and creates nothing', () => {
    const r = run();
    const p = sh('gh', ['pr', 'create', '--title', 'A change', '--body', 'Why.'], r.workspace, r.env);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /^https:\/\/example\.invalid\/uat\/pull\/\d+/);
    assert.deepEqual(
      remoteFacts(r.dir).gh.map((c) => c.args),
      [['pr', 'create', '--title', 'A change', '--body', 'Why.']],
    );
    assert.equal(r.env.GH_CONFIG_DIR, remotePaths(r.dir).ghConfig, 'a real gh found another way has no login');
  });

  test('another seed gets none of it', () => {
    assert.deepEqual(gitRemoteEnv({ seed: 'fake-env' }, '/x'), {});
  });
});

describe('the end of the run', () => {
  test('removes the remote and the temp folder, keeps remote.json, and says nothing is left', () => {
    const r = run();
    commit(r, 1);
    sh('git', ['push', '-q', 'origin', 'main'], r.workspace, r.env);
    const lines = [];
    assert.deepEqual(
      tearDownRemote(r.dir, (l) => lines.push(l)),
      [],
    );
    assert.equal(existsSync(remotePaths(r.dir).remote), false);
    assert.equal(existsSync(remotePaths(r.dir).tmp), false);
    assert.match(lines.join('\n'), /nothing|no pb-\* folder/);
    assert.equal(remoteFacts(r.dir).pushes.length, 1, 'remote.json still has the push, for --recheck');
  });

  test('a pb-* folder Postbox left is named, though the run removes it', () => {
    const r = run();
    mkdirSync(join(remotePaths(r.dir).tmp, 'pb-push-abc'));
    const left = tearDownRemote(r.dir, () => {});
    assert.deepEqual(left, ['tmp/pb-push-abc (Postbox’s, before the run removed it)']);
    assert.equal(existsSync(join(remotePaths(r.dir).tmp, 'pb-push-abc')), false);
  });
});

test('the tester is told where the remote is, for a git-remote run only', () => {
  assert.match(remoteNote({ seed: 'git-remote' }, '/runs/r1'), /the folder \/runs\/r1\/remote\.git, a bare repository/);
  assert.equal(remoteNote({ seed: null }, '/runs/r1'), '');
});
