// login-path.mjs and the daemon’s use of it (#672, #474): sshd starts the daemon in a non-interactive shell whose PATH
// often misses the folders the person’s login shell adds (mise, nvm, a toolbox folder), so the daemon asks the login
// shell for its PATH once, finds the CLIs there first, and gives each turn that PATH ahead of its own. Real shells run
// in tests/process/remote-login-path.test.mjs; here the shell is a fake spawn.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { mergePath, pathMarkers, probeLoginPath } from '../server/remote/host/login-path.mjs';
import { findPrograms } from '../server/remote/host/programs.mjs';
import { lookedText, TURN_FILES, validateMessage } from '../shared/remote-protocol.mjs';
import { fakeClock, hello, PROGRAMS_FOUND, setup, startMsg } from './remote-daemon-setup.mjs';
import { tempDir } from './temp-dirs.mjs';

const TOKEN = '11111111-2222-4333-8444-555555555555';
const OLD = '99999999-8888-4777-8666-555555555555';

/**
 * A fake spawn whose shell, once spawned, writes `out(markers)` to stdout and exits with `code`.
 * @param {(m: { start: string, end: string }) => string} out @param {number} [code]
 */
function fakeShell(out, code = 0) {
  /** @type {{ file: string, args: string[], opts: any }[]} */
  const calls = [];
  const spawnImpl = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough() });
    setImmediate(() => {
      child.stdout.end(out(pathMarkers(TOKEN)));
      child.emit('exit', code, null);
      child.emit('close', code, null);
    });
    return child;
  };
  return { spawnImpl, calls };
}

const probe = (shell) => probeLoginPath({ shell: '/bin/zsh', spawnImpl: shell.spawnImpl, newToken: () => TOKEN });
const around = (path) => (m) => `\n${m.start}${path}${m.end}\n`;

test('#672: only the text between this probe’s own markers is read, past a banner and another probe’s markers', async () => {
  const old = pathMarkers(OLD);
  const shell = fakeShell((m) => `Welcome to the host!\n${old.start}/evil/bin${old.end}\nPATH=/also/evil\n${m.start}/login/bin:/usr/bin${m.end}\nbye\n`);
  const r = await probe(shell);
  assert.deepEqual({ ok: r.ok, entries: r.ok && r.entries }, { ok: true, entries: ['/login/bin', '/usr/bin'] });
  assert.equal(shell.calls.length, 1);
  const [{ file, args, opts }] = shell.calls;
  assert.equal(file, '/bin/zsh', 'the login shell itself, not a shell string');
  assert.equal(args[0], '-lic', 'a login, interactive shell, as an ssh session’s');
  assert.ok(!args[1].includes(pathMarkers(TOKEN).start), 'the script never holds a marker whole, so an echo of it can’t pass for one');
  assert.equal(opts.detached, true, 'in its own process group, so a time-out kills all of it');
  assert.equal(opts.stdio[0], 'ignore', 'stdin closed');
});

test('#672: relative, empty and control-character entries are dropped, and duplicates kept once', async () => {
  const r = await probe(fakeShell(around('/a/bin::bin:./x:/b/\tbin:/a/bin:/c/bin\u0007:/d/bin')));
  assert.ok(r.ok);
  assert.deepEqual(r.entries, ['/a/bin', '/d/bin']);
});

test('#672: a login PATH is cut at 200 entries and at 16 KB', async () => {
  const many = Array.from({ length: 300 }, (_, i) => `/p${i}`).join(':');
  const r = await probe(fakeShell(around(many)));
  assert.ok(r.ok);
  assert.equal(r.entries.length, 200);
  assert.deepEqual(r.entries.slice(0, 2), ['/p0', '/p1']);
  const long = Array.from({ length: 100 }, (_, i) => `/${String(i).padStart(3, '0')}${'x'.repeat(296)}`).join(':');
  const big = await probe(fakeShell(around(long)));
  assert.ok(big.ok);
  assert.ok(big.entries.join(':').length <= 16 * 1024, `${big.entries.join(':').length} bytes`);
  assert.ok(big.entries.length >= 50, 'cut at the limit, not emptied');
});

test('#672: a shell that prints no markers, or exits non-zero with none, fails with a reason', async () => {
  const none = await probe(fakeShell(() => 'Welcome!\n/login/bin:/usr/bin\n'));
  assert.equal(none.ok, false);
  assert.ok(!none.ok && none.why.length > 0);
  // A non-zero exit fails only without markers (#1066: an rc’s exit trap can follow a clean PATH).
  const failed = await probe(fakeShell(() => 'Welcome!\n', 1));
  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && /1/.test(failed.why), !failed.ok ? failed.why : '');
  const noShell = await probeLoginPath({ shell: null, spawnImpl: fakeShell(around('/x')).spawnImpl });
  assert.equal(noShell.ok, false);
});

test('#672: the merged PATH is the login entries, then the daemon’s own that aren’t in them', () => {
  assert.equal(mergePath(['/login/bin', '/usr/bin'], '/usr/bin:/bin:/login/bin:/sbin'), '/login/bin:/usr/bin:/bin:/sbin');
  assert.equal(mergePath(['/login/bin'], undefined), '/login/bin');
});

const loginOk = (entries) => async () => ({ ok: true, entries, ms: 7 });

/** Starts turn t1 on a daemon and returns its start.json. */
async function startedRecord(s, over = {}) {
  const c = await hello(s);
  c.send('start', startMsg('t1', over));
  await c.msgs.next('started');
  return JSON.parse(readFileSync(s.p.turn('t1', TURN_FILES.start), 'utf8'));
}

test('#672: a turn’s PATH holds the folder of the Node the daemon runs on, after the login shell’s, when the shell has none', async () => {
  const programs = structuredClone(PROGRAMS_FOUND);
  programs.node = { path: '/x/node/22/bin/node', version: 'v22.12.0' };
  const s = setup({ probeLoginPath: loginOk(['/login/bin']), findPrograms: async () => programs, env: { PATH: '/usr/bin:/bin' } });
  try {
    const record = await startedRecord(s);
    assert.equal(record.env.PATH, '/login/bin:/x/node/22/bin:/usr/bin:/bin');
  } finally {
    s.done();
  }
});

test('#672: a turn’s PATH is the login shell’s first, then the daemon’s, once each', async () => {
  const s = setup({ probeLoginPath: loginOk(['/login/bin', '/usr/bin']), env: { PATH: '/usr/bin:/bin' } });
  try {
    const record = await startedRecord(s);
    assert.equal(record.env.PATH, '/login/bin:/usr/bin:/bin');
    assert.equal(record.env.CLAUDE_CODE_ENTRYPOINT, 'postbox', 'the laptop’s variables still go');
  } finally {
    s.done();
  }
});

test('#672: a PATH the laptop sends still wins over the login shell’s', async () => {
  const s = setup({ probeLoginPath: loginOk(['/login/bin']), env: { PATH: '/usr/bin' } });
  try {
    const record = await startedRecord(s, { env: { PATH: '/laptop/bin' } });
    assert.equal(record.env.PATH, '/laptop/bin');
  } finally {
    s.done();
  }
});

test('#672: when the login shell fails, the turn’s PATH isn’t set, as before', async () => {
  const s = setup({ probeLoginPath: async () => ({ ok: false, why: 'no markers' }), env: { PATH: '/usr/bin' } });
  try {
    const record = await startedRecord(s);
    assert.equal(Object.hasOwn(record.env, 'PATH'), false);
  } finally {
    s.done();
  }
});

test('#672: the welcome says how many entries the login PATH had and how long it took, never the entries', async () => {
  const s = setup({ probeLoginPath: loginOk(['/secret/login/bin', '/usr/bin']) });
  try {
    const { welcome } = await hello(s);
    assert.deepEqual(welcome.loginPath, { ok: true, entries: 2, ms: 7 });
    assert.ok(!JSON.stringify(welcome).includes('/secret/login/bin'));
    assert.ok(validateMessage('daemon-to-postbox', welcome).ok, 'the laptop accepts it');
    const failed = setup({ probeLoginPath: async () => ({ ok: false, why: 'it timed out after 5 s' }) });
    try {
      assert.deepEqual((await hello(failed)).welcome.loginPath, { ok: false, why: 'it timed out after 5 s' });
    } finally {
      failed.done();
    }
  } finally {
    s.done();
  }
});

/** A findPrograms that finds claude only when the login PATH has /late/bin, and records what it was given. */
function findsLate(seen) {
  return async ({ loginPath = [] }) => {
    seen.push(loginPath);
    const found = structuredClone(PROGRAMS_FOUND);
    found.harnesses[0] = loginPath.includes('/late/bin')
      ? { name: 'claude-code', path: '/late/bin/claude', version: '2.1.296', looked: ['/late/bin/claude'] }
      : { name: 'claude-code', path: null, version: null, looked: ['/early/bin/claude'] };
    return found;
  };
}

test('#672: a harness missing at its start is looked for again with a fresh login PATH, and the turn starts', async () => {
  let probes = 0;
  const seen = [];
  const s = setup({
    probeLoginPath: async () => ({ ok: true, entries: ++probes === 1 ? ['/early/bin'] : ['/early/bin', '/late/bin'], ms: 1 }),
    findPrograms: findsLate(seen),
  });
  try {
    const record = await startedRecord(s);
    assert.equal(record.program, '/late/bin/claude');
    assert.equal(probes, 2);
    assert.deepEqual(seen.at(-1), ['/early/bin', '/late/bin'], 'the lookup used the fresh login PATH');
    assert.match(record.env.PATH, /^\/early\/bin:\/late\/bin/);
  } finally {
    s.done();
  }
});

test('#1084: the login shell is asked again at most once per 30 s, so a CLI installed since is found later', async () => {
  let probes = 0;
  const clock = fakeClock();
  const s = setup({ clock, probeLoginPath: async () => ({ ok: true, entries: [`/try${++probes}`], ms: 1 }), findPrograms: findsLate([]) });
  try {
    const c = await hello(s);
    assert.equal(probes, 1, 'once at the first hello');
    c.send('start', startMsg('t1'));
    assert.equal((await c.msgs.next('error')).code, 'no-harness');
    assert.equal(probes, 2, 'once more at the miss');
    c.send('start', startMsg('t2'));
    assert.equal((await c.msgs.next('error')).code, 'no-harness');
    assert.equal(probes, 2, 'not again within 30 s of the last probe’s start');
    const later = await hello(s, { takeover: true });
    assert.equal(probes, 2, 'nor at a later hello');
    await clock.tick(30_000);
    later.send('start', startMsg('t3'));
    assert.equal((await later.msgs.next('error')).code, 'no-harness');
    assert.equal(probes, 3, 'again once 30 s have passed');
  } finally {
    s.done();
  }
});

test('#1084: a claude installed after a Kiro start re-probed is found by a claude start 30 s later', async () => {
  let probes = 0;
  const clock = fakeClock();
  const s = setup({
    clock,
    probeLoginPath: async () => ({ ok: true, entries: ++probes <= 2 ? ['/early/bin'] : ['/early/bin', '/late/bin'], ms: 1 }),
    findPrograms: findsLate([]),
  });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1', { harness: 'kiro-cli' }));
    assert.equal((await c.msgs.next('error')).code, 'no-harness');
    assert.equal(probes, 2, 'the Kiro miss asked again, before claude was installed');
    await clock.tick(30_000);
    c.send('start', startMsg('t2'));
    await c.msgs.next('started');
    assert.equal(probes, 3);
    const record = JSON.parse(readFileSync(s.p.turn('t2', TURN_FILES.start), 'utf8'));
    assert.equal(record.program, '/late/bin/claude');
  } finally {
    s.done();
  }
});

test('#672: a re-probe that fails keeps the first probe’s PATH, so a CLI it found is still found', async () => {
  let probes = 0;
  const s = setup({
    probeLoginPath: async () => (++probes === 1 ? { ok: true, entries: ['/late/bin'], ms: 1 } : { ok: false, why: 'the shell timed out.' }),
    findPrograms: findsLate([]),
  });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1', { harness: 'kiro-cli' }));
    assert.equal((await c.msgs.next('error')).code, 'no-harness');
    assert.equal(probes, 2, 'the miss asked again, and that probe failed');
    c.send('start', startMsg('t2'));
    await c.msgs.next('started');
    const record = JSON.parse(readFileSync(s.p.turn('t2', TURN_FILES.start), 'utf8'));
    assert.equal(record.program, '/late/bin/claude', 'claude is still found on the first probe’s PATH');
    assert.match(record.env.PATH, /^\/late\/bin/);
  } finally {
    s.done();
  }
});

/** A temp home with an executable `name` in each of `dirs` (under it). */
function hostWith(dirs, name) {
  const home = tempDir('pblp-');
  for (const d of dirs) {
    mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, d, name), '#!/bin/sh\n');
    chmodSync(join(home, d, name), 0o755);
  }
  return home;
}

test('#672: findPrograms finds a CLI only on the login PATH, says it looked there for the login shell, and runs it with that PATH', async () => {
  const home = hostWith(['login-bin'], 'claude');
  const envs = [];
  const execFile = (_file, _args, opts, cb) => {
    envs.push(opts.env?.PATH);
    cb(null, '2.1.296 (Claude Code)\n', '');
  };
  const found = await findPrograms({ home, settings: {}, env: { PATH: '/nonexistent/bin' }, execFile, loginPath: [`${home}/login-bin`] });
  const claude = found.harnesses.find((h) => h.name === 'claude-code');
  assert.equal(claude?.path, `${home}/login-bin/claude`);
  assert.deepEqual(claude?.looked, [`${home}/login-bin/claude`]);
  assert.equal(claude?.fromLogin, 1);
  assert.match(lookedText(claude), /your login shell/);
  const kiro = found.harnesses.find((h) => h.name === 'kiro-cli');
  assert.equal(kiro?.looked[0], `${home}/login-bin/kiro-cli`, 'the login PATH before the daemon’s');
  assert.equal(kiro?.looked[1], '/nonexistent/bin/kiro-cli');
  assert.equal(envs[0], `${home}/login-bin:/nonexistent/bin`, '--version runs with the merged PATH, as an npm-installed CLI needs node on it');
});

test('#672: a configured path still wins over the login PATH, and is the only one tried', async () => {
  const home = hostWith(['login-bin'], 'claude');
  const execFile = (_file, _args, _opts, cb) => cb(null, '2.1.296\n', '');
  const found = await findPrograms({ home, settings: { claudePath: '/opt/none/claude' }, env: { PATH: '' }, execFile, loginPath: [`${home}/login-bin`] });
  const claude = found.harnesses.find((h) => h.name === 'claude-code');
  assert.equal(claude?.path, null);
  assert.deepEqual(claude?.looked, ['/opt/none/claude']);
  assert.ok(!lookedText(claude).includes('login shell'));
});
