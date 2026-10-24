// The UAT runner’s own scripts on a host (#120; tools/uat/hosts-ssh.mjs), run for real by a local `sh -s` in place of
// ssh, in a temporary home: the run’s own folder, made once and removed alone; the measuring scripts failing closed
// when a program they measure with is missing; and Stop’s check finding a tool shell that outlived its runner.
// Where a program’s output is stood in for, the stand-in prints what the real one does: pgrep’s exit statuses are
// procps’s (pgrep(1), “EXIT STATUS”: 1 when nothing matched, 2 for a syntax error), and ss’s output is the recorded
// one tests/uat-hosts.test.mjs reads.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  cleanUpScript,
  hostListeners,
  launcherScript,
  measureOn,
  onHost,
  parseTree,
  SCRIPTS,
  stillRunning,
  turnTrees,
  workScript,
} from '../../tools/uat/hosts-ssh.mjs';

const TOOLS = ['id', 'sed', 'head', 'ls', 'rm', 'mkdir', 'rmdir', 'basename', 'dirname', 'cat', 'chmod', 'ps', 'pgrep', 'pkill', 'ss'];
const where = (cmd) => spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim();

/** A host’s home and the only programs on its PATH: this computer’s, less omit, with fakes in place of some. */
function host({ omit = /** @type {string[]} */ ([]), fakes = /** @type {Record<string, string>} */ ({}) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pb-uat-host-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  for (const c of TOOLS) {
    const p = where(c);
    if (!omit.includes(c) && !fakes[c] && p.startsWith('/')) symlinkSync(p, join(bin, c));
  }
  for (const [c, body] of Object.entries(fakes)) writeFileSync(join(bin, c), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  /** @type {any} */
  const sh = (_cmd, _args, o) => spawn('/bin/sh', ['-s'], { ...o, env: { HOME: home, PATH: bin } });
  return {
    home,
    run: (script) => onHost('host.example.com', script, { spawn: sh }),
    measure: (script) => measureOn('host.example.com', script, { spawn: sh }),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('#120 UAT host scripts: the run’s own folder is made once, refused when it’s there, and removed alone', async () => {
  const h = host();
  try {
    // Another run’s folder, and something of the person’s, under a ~/postbox-uat the run didn’t make.
    mkdirSync(join(h.home, 'postbox-uat', 'other'), { recursive: true });
    writeFileSync(join(h.home, 'postbox-uat', 'other', 'keep.txt'), 'theirs');
    const made = await h.run(workScript('r1'));
    assert.equal(made.code, 0, made.stderr);
    assert.doesNotMatch(made.stdout, /made/);
    for (const d of ['r1', 'r1/work', 'r1/bin']) assert.equal(statSync(join(h.home, 'postbox-uat', d)).mode & 0o777, 0o700, d);
    const again = await h.run(workScript('r1'));
    assert.equal(again.code, 3);
    assert.match(again.stderr, /~\/postbox-uat\/r1 is already there, and isn’t this run’s/);
    // The launcher goes in the run’s own bin, and nowhere another run shares.
    const node = process.execPath;
    const l = await h.run(launcherScript({ launcher: 'console.log(1)\n', node, claude: '/usr/bin/true', run: 'r1' }));
    assert.equal(l.code, 0, l.stderr);
    assert.equal(l.stdout, join(h.home, 'postbox-uat', 'r1', 'bin', 'claude'));
    assert.match(readFileSync(l.stdout, 'utf8'), /postbox-uat\/r1\/bin\/claude-launcher\.mjs/);
    assert.equal(existsSync(join(h.home, 'postbox-uat', 'bin')), false);
    // A file rm can’t delete (its folder is read-only): cleanup says the run’s folder is still there, never “removed”.
    const locked = join(h.home, 'postbox-uat', 'r1', 'work', 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'out.log'), 'x');
    chmodSync(locked, 0o500);
    const stuck = await h.run(cleanUpScript('r1'));
    chmodSync(locked, 0o700);
    assert.equal(stuck.code, 1);
    assert.match(stuck.stderr, /~\/postbox-uat\/r1 is still there\./);
    assert.doesNotMatch(stuck.stdout, /removed/);
    // Cleanup with parent set, as if the run had made ~/postbox-uat: rmdir leaves it, since it isn’t empty.
    const gone = await h.run(cleanUpScript('r1', { parent: true }));
    assert.equal(gone.code, 0, gone.stderr);
    assert.equal(existsSync(join(h.home, 'postbox-uat', 'r1')), false);
    assert.equal(readFileSync(join(h.home, 'postbox-uat', 'other', 'keep.txt'), 'utf8'), 'theirs');
  } finally {
    h.done();
  }
  const fresh = host();
  try {
    const made = await fresh.run(workScript('r2'));
    assert.equal(made.stdout.trim(), 'made');
    assert.equal((await fresh.run(cleanUpScript('r2', { parent: true }))).code, 0);
    assert.equal(existsSync(join(fresh.home, 'postbox-uat')), false);
  } finally {
    fresh.done();
  }
});

// What ss -ltnp printed on a Linux host (tests/uat-hosts.test.mjs has the recording), and ps’s lines after it.
const SS = `State  Recv-Q Send-Q      Local Address:Port  Peer Address:PortProcess
LISTEN 0      128               0.0.0.0:22         0.0.0.0:*`;

test('#120 UAT host scripts: without pgrep, pkill or ss, the measuring scripts say they couldn’t, not “nothing”', async () => {
  const h = host({ omit: ['pgrep', 'pkill', 'ss'] });
  try {
    const pre = await h.measure(SCRIPTS.preflight);
    assert.deepEqual(pre.out?.split('\n'), ['missing pgrep', 'missing pkill', 'missing ss']);
    const p = await h.measure(SCRIPTS.processes);
    assert.equal(p.out, null);
    assert.match(String(p.why), /pgrep/);
    assert.equal((await h.measure(SCRIPTS.listeners)).out, null);
    const k = await h.run(SCRIPTS.killDaemon);
    assert.notEqual(k.code, 0);
    assert.doesNotMatch(k.stdout, /none|killed/);
  } finally {
    h.done();
  }
  const ps = `printf '%s\\n' ' 4100  4100 /home/user/.postbox-remote/0.24.0/host.mjs serve'`;
  const ok = host({ fakes: { pgrep: 'exit 1', pkill: 'exit 1', ss: `cat <<'EOF'\n${SS}\nEOF`, ps } });
  try {
    assert.equal((await ok.measure(SCRIPTS.preflight)).out, '');
    // pgrep’s 1 is “nothing matched”: measured, and nothing runs.
    assert.deepEqual(await ok.measure(SCRIPTS.processes), { out: '', why: null });
    assert.equal((await ok.run(SCRIPTS.killDaemon)).stdout.trim(), 'none');
    const l = await ok.measure(SCRIPTS.listeners);
    assert.deepEqual(
      hostListeners(/** @type {string} */ (l.out)).map((x) => x.addr),
      ['0.0.0.0:22'],
    );
  } finally {
    ok.done();
  }
  const broken = host({ fakes: { pgrep: 'echo "pgrep: invalid option" >&2; exit 2', ss: 'exit 1' } });
  try {
    const p = await broken.measure(SCRIPTS.processes);
    assert.equal(p.out, null);
    assert.match(String(p.why), /invalid option/);
    assert.equal((await broken.measure(SCRIPTS.listeners)).out, null);
  } finally {
    broken.done();
  }
});

const LINUX = process.platform === 'linux' ? false : 'macOS’s ps has no sid column, which the host’s script reads: run on Linux';
const TURN = '0f8e2c1a-4b5d-4e6f-8a9b-0c1d2e3f4a5b';

test('#120 UAT host scripts: Stop’s check finds a tool shell left running after its runner and CLI were killed', { skip: LINUX }, async () => {
  const h = host();
  const kill = (pid, sig = 'SIGKILL') => {
    try {
      process.kill(pid, sig);
    } catch {}
  };
  let shell = 0;
  try {
    // A runner under ~/.postbox-remote, its CLI, and the CLI’s tool shell in a session of its own (setsid), as Claude
    // Code starts each Bash call; the shell runs a loop, so its sleep is its child.
    const dir = join(h.home, '.postbox-remote', '0.24.0');
    mkdirSync(dir, { recursive: true });
    const cli = `require('node:child_process').spawn('sh', ['-c', 'while :; do sleep 300; done'], { detached: true, stdio: 'ignore' }); setInterval(() => {}, 1000);`;
    writeFileSync(
      join(dir, 'runner.mjs'),
      `import { spawn } from 'node:child_process';\nspawn(process.execPath, ['-e', ${JSON.stringify(cli)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`,
    );
    const runner = spawn(process.execPath, [join(dir, 'runner.mjs'), TURN], { stdio: 'ignore', detached: true });
    mkdirSync(join(h.home, '.postbox-remote', 'turns', TURN), { recursive: true });
    writeFileSync(join(h.home, '.postbox-remote', 'turns', TURN, 'runner.json'), JSON.stringify({ turn: TURN, version: '0.24.0', pid: runner.pid }));
    let seen = [];
    for (let i = 0; i < 50 && seen.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const { out } = await h.measure(SCRIPTS.tree);
      seen = turnTrees(parseTree(/** @type {string} */ (out))).get(TURN) ?? [];
    }
    assert.equal(seen.length, 4, `the runner, its CLI, the tool shell and its sleep: ${JSON.stringify(seen)}`);
    const [, cliProc, sh] = seen;
    shell = Number(sh.pid);
    assert.equal(sh.sid, sh.pid, 'the tool shell leads its own session');
    kill(Number(cliProc.pid));
    kill(/** @type {number} */ (runner.pid));
    await new Promise((r) => setTimeout(r, 300));
    const after = parseTree(/** @type {string} */ ((await h.measure(SCRIPTS.tree)).out));
    const left = stillRunning(seen, after);
    assert.ok(
      left.some((p) => p.pid === sh.pid),
      `the tool shell is left: ${JSON.stringify(left)}`,
    );
    assert.ok(left.every((p) => p.pid !== String(runner.pid) && p.pid !== cliProc.pid));
    assert.ok(left.some((p) => p.args.startsWith('sleep 300')));
  } finally {
    if (shell) kill(-shell);
    h.done();
  }
});
