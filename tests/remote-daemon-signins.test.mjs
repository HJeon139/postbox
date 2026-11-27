// The host daemon’s `signins` (server/remote/host/daemon-signins.mjs, #1608), in-process with a fake spawn
// (tests/remote-daemon-setup.mjs) whose children answer as the CLIs did in tests/fixtures/remote/signin/.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATUS_OUTPUT_CHARS } from '../server/remote/host/harness-signin.mjs';
import { SIGN_IN_KEEP_MS, SIGN_IN_STATUS_MS } from '../shared/remote-protocol.mjs';
import { fakeClock, hello, PROGRAMS_FOUND, setup, until } from './remote-daemon-setup.mjs';
import { ALL_FOUND, carried, recorded, statusSpawn } from './remote-daemon-signins-helpers.mjs';

test('signins: each found harness’s status command runs as an argument list with no shell or stdin, and signed carries only its state', async () => {
  const sp = statusSpawn();
  const s = setup({ spawn: sp.spawn, findPrograms: ALL_FOUND, probeLoginPath: async () => ({ ok: true, entries: ['/opt/tools/bin'], ms: 5 }) });
  try {
    const c = await hello(s);
    const text = carried(c);
    c.send('signins');
    await until(() => sp.calls.length === 3, 'the three status commands');
    for (const call of sp.calls) {
      assert.equal(call.options.shell, false);
      assert.equal(call.options.stdio[0], 'ignore', 'no stdin');
      assert.equal(call.options.cwd, s.home);
      assert.equal(call.options.env.PATH.split(':')[0], '/opt/tools/bin', 'a turn’s PATH');
    }
    const byProgram = Object.fromEntries(sp.calls.map((x) => [x.program, x]));
    assert.deepEqual(byProgram['/home/user/.local/bin/claude'].args, ['auth', 'status']);
    assert.deepEqual(byProgram['/home/user/.local/bin/codex'].args, ['login', 'status']);
    assert.deepEqual(byProgram['/home/user/.local/bin/codex'].options.stdio, ['ignore', 'ignore', 'ignore'], 'Codex’s output is discarded');
    assert.deepEqual(byProgram['/home/user/.local/bin/kiro-cli'].args, ['whoami', '--format', 'json']);
    // Other messages go on while they run.
    c.send('read', { turn: 'nope', from: 0 });
    assert.equal((await c.msgs.next('error')).code, 'no-turn');
    for (const call of sp.calls) void sp.play(call, 'signed-in');
    const signed = await c.msgs.next('signed');
    assert.deepEqual(signed.harnesses, [
      { name: 'claude-code', state: 'signed-in', method: 'claude.ai', expiresAt: Date.parse('2026-12-01T00:00:00.000Z') },
      { name: 'kiro-cli', state: 'signed-in', method: 'BuilderId' },
      { name: 'codex', state: 'signed-in' },
    ]);
    for (const raw of ['robin', 'example.com', 'Organization', '00000000-0000', 'awsapps', '"pro"', 'firstParty'])
      assert.ok(!text().includes(raw), `“${raw}” from a command’s output never crosses`);
  } finally {
    await s.done();
  }
});

test('signins: with empty config folders each harness reads signed out', async () => {
  const sp = statusSpawn();
  const s = setup({ spawn: sp.spawn, findPrograms: ALL_FOUND });
  try {
    const c = await hello(s);
    c.send('signins');
    await until(() => sp.calls.length === 3, 'the three status commands');
    for (const call of sp.calls) void sp.play(call, 'signed-out');
    const signed = await c.msgs.next('signed');
    assert.deepEqual(
      signed.harnesses.map((h) => [h.name, h.state, Object.keys(h).length]),
      [
        ['claude-code', 'signed-out', 2],
        ['kiro-cli', 'signed-out', 2],
        ['codex', 'signed-out', 2],
      ],
    );
  } finally {
    await s.done();
  }
});

test('signins: a harness the host doesn’t have isn’t asked, and none found answers with none', async () => {
  const sp = statusSpawn();
  const s = setup({ spawn: sp.spawn });
  try {
    const c = await hello(s);
    c.send('signins');
    await until(() => sp.calls.length === 2, 'claude’s and codex’s');
    assert.ok(!sp.calls.some((x) => x.program.endsWith('kiro-cli')), 'kiro-cli wasn’t found');
    for (const call of sp.calls) void sp.play(call, 'signed-in');
    assert.deepEqual(
      (await c.msgs.next('signed')).harnesses.map((h) => h.name),
      ['claude-code', 'codex'],
    );
  } finally {
    await s.done();
  }
  const none = setup({ spawn: sp.spawn, findPrograms: async () => ({ ...structuredClone(PROGRAMS_FOUND), harnesses: [] }) });
  try {
    const c = await hello(none);
    c.send('signins');
    assert.deepEqual(await c.msgs.next('signed'), { type: 'signed', harnesses: [] });
  } finally {
    await none.done();
  }
});

test('signins: an answer is kept for SIGN_IN_KEEP_MS, then asked again', async () => {
  const clock = fakeClock();
  const sp = statusSpawn();
  const s = setup({ spawn: sp.spawn, clock });
  try {
    const c = await hello(s);
    c.send('signins');
    await until(() => sp.calls.length === 2, 'the first asking');
    for (const call of sp.calls) void sp.play(call, 'signed-in');
    const first = await c.msgs.next('signed');
    await clock.tick(SIGN_IN_KEEP_MS - 1);
    c.send('signins');
    assert.deepEqual(await c.msgs.next('signed'), first, 'the kept answer');
    assert.equal(sp.calls.length, 2, 'nothing ran again');
    await clock.tick(1);
    c.send('signins');
    await until(() => sp.calls.length === 4, 'the asking after the answer ran out');
    for (const call of sp.calls.slice(2)) void sp.play(call, 'signed-out');
    assert.deepEqual(
      (await c.msgs.next('signed')).harnesses.map((h) => h.state),
      ['signed-out', 'signed-out'],
    );
  } finally {
    await s.done();
  }
});

test('signins: a sign-out isn’t kept, so a sign-in fixed since is heard at the next asking', async () => {
  const clock = fakeClock();
  const sp = statusSpawn();
  const s = setup({ spawn: sp.spawn, clock });
  try {
    const c = await hello(s);
    c.send('signins');
    await until(() => sp.calls.length === 2, 'the first asking');
    for (const call of sp.calls) void sp.play(call, 'signed-out');
    await c.msgs.next('signed');
    // The person signs in on the host; Postbox asks again well within SIGN_IN_KEEP_MS.
    c.send('signins');
    await until(() => sp.calls.length === 4, 'the second asking to run the commands again');
    for (const call of sp.calls.slice(2)) void sp.play(call, 'signed-in');
    assert.deepEqual(
      (await c.msgs.next('signed')).harnesses.map((h) => h.state),
      ['signed-in', 'signed-in'],
    );
  } finally {
    await s.done();
  }
});

test('signins: a status command past SIGN_IN_STATUS_MS is killed and reads unknown', async () => {
  const clock = fakeClock();
  const sp = statusSpawn();
  const s = setup({ spawn: sp.spawn, clock });
  try {
    const c = await hello(s);
    c.send('signins');
    await until(() => sp.calls.length === 2, 'the status commands');
    await sp.play(sp.calls[1], 'signed-in');
    await clock.tick(SIGN_IN_STATUS_MS - 1);
    assert.deepEqual(sp.calls[0].child.kills, [], 'not before its time');
    await clock.tick(1);
    assert.deepEqual(sp.calls[0].child.kills, ['SIGKILL']);
    assert.deepEqual(await c.msgs.next('signed'), {
      type: 'signed',
      harnesses: [
        { name: 'claude-code', state: 'unknown' },
        { name: 'codex', state: 'signed-in' },
      ],
    });
  } finally {
    await s.done();
  }
});

test('signins: one that can’t start, ends on a signal, or exits otherwise is unknown, never signed out', async () => {
  const sp = statusSpawn();
  const failing = (program, args, options) => {
    if (program.endsWith('claude')) throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    return sp.spawn(program, args, options);
  };
  const s = setup({ spawn: failing, findPrograms: ALL_FOUND });
  try {
    const c = await hello(s);
    c.send('signins');
    await until(() => sp.calls.length === 2, 'kiro’s and codex’s');
    const [kiro, codex] = sp.calls;
    kiro.child.emit('close', null, 'SIGTERM');
    codex.child.emit('close', 2, null);
    assert.deepEqual(
      (await c.msgs.next('signed')).harnesses.map((h) => [h.name, h.state]),
      [
        ['claude-code', 'unknown'],
        ['kiro-cli', 'unknown'],
        ['codex', 'unknown'],
      ],
    );
    // An answer that was unknown is kept like any other; a spawn error reads the same.
    const t = setup({ spawn: sp.spawn });
    try {
      const d = await hello(t);
      d.send('signins');
      await until(() => sp.calls.length === 4, 'the next daemon’s');
      for (const call of sp.calls.slice(2)) call.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      assert.deepEqual(
        (await d.msgs.next('signed')).harnesses.map((h) => h.state),
        ['unknown', 'unknown'],
      );
    } finally {
      await t.done();
    }
  } finally {
    await s.done();
  }
});

test('signins: output past STATUS_OUTPUT_CHARS is cut, so it reads unknown, never as whatever it ends with', async () => {
  const sp = statusSpawn();
  const s = setup({ spawn: sp.spawn });
  try {
    const c = await hello(s);
    c.send('signins');
    await until(() => sp.calls.length === 2, 'the status commands');
    const claude = sp.calls.find((x) => x.program.endsWith('claude'));
    const codex = sp.calls.find((x) => x.program.endsWith('codex'));
    // Valid JSON, signed in, but longer than the daemon reads.
    const long = JSON.stringify({ ...JSON.parse(recorded('claude-signed-in').stdout), pad: 'x'.repeat(STATUS_OUTPUT_CHARS) });
    claude.child.stdout.end(long);
    await new Promise((resolve) => setImmediate(resolve));
    claude.child.emit('close', 0, null);
    await sp.play(codex, 'signed-in');
    assert.deepEqual(
      (await c.msgs.next('signed')).harnesses.map((h) => [h.name, h.state]),
      [
        ['claude-code', 'unknown'],
        ['codex', 'signed-in'],
      ],
    );
  } finally {
    await s.done();
  }
});

test('signins: a status command still running when the daemon closes is killed with it', async () => {
  const sp = statusSpawn();
  const s = setup({ spawn: sp.spawn });
  let closed = false;
  try {
    const c = await hello(s);
    c.send('signins');
    await until(() => sp.calls.length === 2, 'the status commands');
    await s.done();
    closed = true;
    assert.deepEqual(
      sp.calls.map((x) => x.child.kills),
      [['SIGKILL'], ['SIGKILL']],
    );
  } finally {
    if (!closed) await s.done();
  }
});
