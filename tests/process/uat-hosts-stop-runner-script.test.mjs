// #872’s stop-runner script (tools/uat/hosts-ssh.mjs, SCRIPTS.stopRunner), run for real in sh against a stand-in
// runner: a node process started as the daemon starts one, `<node> <folder>/<version>/server/remote/host/runner.mjs
// <turn>`. On a host whose $HOME is a symlink, the daemon’s runners name the resolved folder, so the script must
// accept that one too, and still refuse a process that only looks like a runner.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SCRIPTS } from '../../tools/uat/hosts-ssh.mjs';

const TURN = '55555555-5555-4555-8555-555555555555';

/**
 * A home folder at real/, a symlink to it at link/, and a stand-in runner for TURN started under real/.
 * @param {{ turnArg?: string }} [o] the turn the runner names on its command line
 */
async function setup({ turnArg = TURN } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pb-stop-runner-')));
  const real = join(base, 'real');
  const code = join(real, '.postbox-remote', '1.0.0', 'server', 'remote', 'host');
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, 'runner.mjs'), 'setInterval(() => {}, 1000);\n');
  symlinkSync(real, join(base, 'link'));
  const child = spawn(process.execPath, [join(code, 'runner.mjs'), turnArg], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const turnDir = join(real, '.postbox-remote', 'turns', TURN);
  mkdirSync(turnDir, { recursive: true });
  writeFileSync(join(turnDir, 'runner.json'), JSON.stringify({ pid: child.pid, turn: TURN }));
  const done = () => {
    child.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  };
  return { base, real, link: join(base, 'link'), child, done };
}

/** @param {string} home */
const run = (home) => spawnSync('sh', ['-c', SCRIPTS.stopRunner], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10_000 });

/** @param {number} pid the process’s state letter, as ps gives it (T when stopped) */
const stateOf = (pid) => spawnSync('ps', ['-p', String(pid), '-o', 'state='], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();

test('#872 stop-runner stops a runner that names the resolved folder when $HOME is a symlink', async () => {
  const s = await setup();
  try {
    const r = run(s.link);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `turn ${TURN}\nstopped ${s.child.pid}\n`);
    assert.match(stateOf(s.child.pid), /^T/);
  } finally {
    s.done();
  }
});

test('#872 stop-runner stops a runner under $HOME itself', async () => {
  const s = await setup();
  try {
    const r = run(s.real);
    assert.equal(r.stdout, `turn ${TURN}\nstopped ${s.child.pid}\n`);
  } finally {
    s.done();
  }
});

test('#872 stop-runner leaves a process that names another turn, under either folder', async () => {
  const s = await setup({ turnArg: '66666666-6666-4666-8666-666666666666' });
  try {
    for (const home of [s.link, s.real]) {
      const r = run(home);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'none\n');
    }
    assert.doesNotMatch(stateOf(s.child.pid), /^T/);
  } finally {
    s.done();
  }
});
