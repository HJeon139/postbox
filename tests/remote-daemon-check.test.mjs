// The host daemon’s sign-in check (server/remote/host/daemon.mjs, #120, G5), in-process with a fake spawn
// (tests/remote-daemon-setup.mjs).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SIGN_IN_CHECK_MS } from '../shared/remote-protocol.mjs';
import { fakeClock, hello, setup, until } from './remote-daemon-setup.mjs';

// ── The sign-in check (G5) ──

/** A spawn that records each call and hands back a child the test ends. */
function checkSpawn() {
  const calls = [];
  const spawn = (program, args, options) => {
    const child = Object.assign(new EventEmitter(), { kills: [], kill: (sig) => child.kills.push(sig) && true });
    calls.push({ program, args, options, child });
    return child;
  };
  return { spawn, calls };
}

test('check: runs hello’s signInCheck as an argument list, with no shell and no stdin, and answers checked with its exit', async () => {
  const sp = checkSpawn();
  const s = setup({ spawn: sp.spawn });
  try {
    const c = await hello(s, { settings: { signInCheck: ['klist', '-s', 'a b; rm -rf ~'] } });
    c.send('check');
    await until(() => sp.calls.length === 1, 'the check to start');
    const [call] = sp.calls;
    assert.equal(call.program, 'klist');
    assert.deepEqual(call.args, ['-s', 'a b; rm -rf ~'], 'each argument as given: nothing parses them');
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ['ignore', 'ignore', 'ignore']);
    assert.equal(call.options.cwd, s.home);
    // Other messages go on while it runs.
    c.send('read', { turn: 'nope', from: 0 });
    assert.equal((await c.msgs.next('error')).code, 'no-turn');
    call.child.emit('exit', 0, null);
    const ok = await c.msgs.next('checked');
    assert.equal(ok.ok, true);
    assert.equal(ok.code, 0);
    c.send('check');
    await until(() => sp.calls.length === 2, 'the second check');
    sp.calls[1].child.emit('exit', 1, null);
    assert.deepEqual((({ ok: o, code }) => ({ ok: o, code }))(await c.msgs.next('checked')), { ok: false, code: 1 });
    c.send('check');
    await until(() => sp.calls.length === 3, 'the third check');
    const e = Object.assign(new Error('spawn klist ENOENT'), { code: 'ENOENT' });
    sp.calls[2].child.emit('error', e);
    assert.deepEqual((({ ok: o, code }) => ({ ok: o, code }))(await c.msgs.next('checked')), { ok: false, code: null }, 'a check that can’t start fails');
  } finally {
    s.done();
  }
});

test('check: one that runs past SIGN_IN_CHECK_MS is killed and fails; without a signInCheck it’s no-check', async () => {
  const clock = fakeClock();
  const sp = checkSpawn();
  const s = setup({ spawn: sp.spawn, clock });
  try {
    const c = await hello(s, { settings: { signInCheck: ['klist', '-s'] } });
    c.send('check');
    await until(() => sp.calls.length === 1, 'the check to start');
    await clock.tick(SIGN_IN_CHECK_MS);
    assert.deepEqual(sp.calls[0].child.kills, ['SIGKILL']);
    const late = await c.msgs.next('checked');
    assert.deepEqual([late.ok, late.code, late.at], [false, null, clock.now()]);
    sp.calls[0].child.emit('exit', null, 'SIGKILL'); // its exit after the kill changes nothing
    const d = await hello(s, { takeover: true, settings: { signInCheck: null } });
    d.send('check');
    const none = await d.msgs.next('error');
    assert.equal(none.code, 'no-check');
    assert.equal(none.re, 'check');
    assert.equal(sp.calls.length, 1);
  } finally {
    s.done();
  }
});
