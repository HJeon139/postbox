// `- seed: git-remote`’s guard against what the integrator’s read of #1001 found it missed: a per-protocol setting in a
// config file beats `protocol.allow=never`, the guard’s wiring had nothing that checked it before a run, and on a Mac
// the agent’s shell puts the real gh back first on PATH from its profile. Real git and a real shell, in temp folders
// (tests/AGENTS.md): HOME is a temp folder of its own and system config is off, so nothing here reads your config.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { gitRemoteEnv, preflightRemote, remotePaths, seedGitRemote } from '../../tools/uat/git-remote.mjs';

process.env.HOME = mkdtempSync(join(tmpdir(), 'postbox-uat-guard-home-'));
process.env.GIT_CONFIG_NOSYSTEM = '1';
const home = process.env.HOME;
after(() => rmSync(home, { recursive: true, force: true }));
const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sh = (cmd, args, cwd, env) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 20_000 });
/** A run folder with its workspace, a git repository of its own as makeWorkspace makes it, and the remote seeded. */
function run() {
  const dir = mkdtempSync(join(tmpdir(), 'postbox-uat-guard-'));
  made.push(dir);
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  sh('git', ['init', '-q', '-b', 'main', workspace]);
  seedGitRemote(workspace, dir);
  return { dir, workspace, env: { ...process.env, ...gitRemoteEnv({ seed: 'git-remote' }, dir) } };
}
const commit = (r) => {
  writeFileSync(join(r.workspace, 'note.txt'), 'a line\n');
  sh('git', ['add', 'note.txt'], r.workspace, r.env);
  return sh('git', ['-c', 'user.name=UAT', '-c', 'user.email=uat@example.invalid', 'commit', '-q', '-m', 'a'], r.workspace, r.env);
};
const UNREACHABLE = 'https://127.0.0.1:9/uat/none.git';

describe('a per-protocol setting doesn’t get past the guard', () => {
  test('with protocol.https.allow=always in the global config, https is still refused, and origin still takes a push', () => {
    const r = run();
    const global = join(r.dir, 'global.gitconfig');
    writeFileSync(global, '[protocol "https"]\n\tallow = always\n');
    const env = { ...r.env, GIT_CONFIG_GLOBAL: global };
    const out = sh('git', ['ls-remote', UNREACHABLE], r.workspace, env);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /transport 'https' not allowed/);
    assert.equal(commit({ ...r, env }).status, 0);
    const p = sh('git', ['push', '-q', 'origin', 'main'], r.workspace, env);
    assert.equal(p.status, 0, p.stderr);
  });
});

describe('the run checks its guard before any turn', () => {
  test('a run seeded as it should be passes', () => {
    const r = run();
    assert.doesNotThrow(() => preflightRemote(r.workspace, r.dir, r.env));
  });

  test('origin pointing anywhere but the run’s remote stops the run', () => {
    const r = run();
    sh('git', ['remote', 'set-url', 'origin', join(r.dir, 'elsewhere.git')], r.workspace, r.env);
    assert.throws(() => preflightRemote(r.workspace, r.dir, r.env), /origin is .*elsewhere\.git, not the run’s remote/);
  });

  test('a run whose git can still reach https stops the run', () => {
    const r = run();
    for (const k of ['protocol.allow', 'protocol.file.allow']) sh('git', ['config', '--unset', k], r.workspace);
    const bare = { PATH: r.env.PATH, HOME: r.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', CLAUDE_ENV_FILE: r.env.CLAUDE_ENV_FILE };
    assert.throws(() => preflightRemote(r.workspace, r.dir, bare), /git in the run isn’t refused an https remote/);
  });

  test('a gh that resolves to anything but the fake stops the run', () => {
    const r = run();
    const real = join(r.dir, 'real-bin');
    mkdirSync(real);
    writeFileSync(join(real, 'gh'), '#!/bin/sh\necho real\n');
    chmodSync(join(real, 'gh'), 0o755);
    // As a Mac profile does: the real gh’s folder first on PATH, after Postbox put the fake’s there.
    const env = { ...r.env, PATH: `${real}:${r.env.PATH}`, CLAUDE_ENV_FILE: '' };
    assert.throws(() => preflightRemote(r.workspace, r.dir, env), /gh in the agent’s shell is .*real-bin\/gh, not the run’s fake/);
  });

  test('the agent’s env file puts the fake gh first again, after the profile', () => {
    const r = run();
    const real = join(r.dir, 'real-bin');
    mkdirSync(real);
    writeFileSync(join(real, 'gh'), '#!/bin/sh\necho real\n');
    chmodSync(join(real, 'gh'), 0o755);
    assert.doesNotThrow(() => preflightRemote(r.workspace, r.dir, { ...r.env, PATH: `${real}:${r.env.PATH}` }));
  });
});

describe('the seed says when a step fails', () => {
  test('seeding a folder that isn’t a git repository throws, naming the step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postbox-uat-guard-'));
    made.push(dir);
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    assert.throws(() => seedGitRemote(workspace, dir), /Couldn’t seed the run’s remote: git .*config protocol\.allow never/);
    assert.ok(remotePaths(dir).remote);
  });
});
