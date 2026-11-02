// Tests for the remote read execution deadline and restart replay (#582, designs/508/582/deadline.md):
// 100-second deadline timer, two-sided wall-clock clamp, hello pre-send expiry check, replayed arrival
// restoration with integer validation, and zero leaked timers across reconnects and teardown.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, fakeClock, makeBroker, makeHome, until } from './remote-broker-fixtures.mjs';

const snap = (turn, text = 'Item 1 snapshot') => ({
  turn,
  home: 'th',
  threads: [{ id: 'th', items: [{ id: 'item_1', line: 'Item 1 line', text }] }],
});

const writeCall = (p, id, at) =>
  writeFileSync(p, `${JSON.stringify({ op: 'call', id, name: 'read_message', route: 'read', args: { id: 'item_1' }, at })}\n`, 'utf8');

test('T02: 100s deadline expiration triggers offline fallback via fake clock', async () => {
  const h = makeHome();
  const clock = fakeClock(1_000_000);
  try {
    const k = makeBroker(h, { now: clock.now, timers: clock.timers });
    await k.post('snapshot', snap('t_t02'));
    h.turn('t_t02');
    await k.b.starting('t_t02');
    const s = connectShim(k.b, 't_t02');
    await s.next('welcome');

    const callPromise = s.call('c_t02', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c_t02'), 'tool sent');

    await clock.tick(99_900);
    assert.equal(
      s.got.some((m) => m.type === 'result' && m.id === 'c_t02'),
      false,
      'call remains pending before 100s',
    );

    await clock.tick(100);
    const res = await callPromise;
    assert.equal(res.ok, true);
    assert.match(res.text, /Item 1 snapshot/);
    assert.match(res.text, /\(Read offline as of this turn’s start; earlier or changed items may be missing\.\)$/);

    const t = k.b.pending.tools.find((x) => x.id === 'c_t02');
    assert.equal(t?.timer, undefined);
    k.b.close();
  } finally {
    h.done();
  }
});

test('T10: restart replay after failed reply write resends if <100s', async () => {
  const h = makeHome();
  const t0 = 1_000_000;
  const clock = fakeClock(t0);
  try {
    h.turn('t_t10_resend');
    writeCall(h.p.turn('t_t10_resend', TURN_FILES.tools), 'c_t10', t0);
    await clock.tick(50_000);
    const k = makeBroker(h, { now: clock.now, timers: clock.timers });
    await k.post('snapshot', snap('t_t10_resend'));
    await k.b.load([{ turn: 't_t10_resend', state: 'running' }]);

    const helloSent = await k.hello();
    assert.ok(
      helloSent.some((m) => m.type === 'tool' && m.id === 'c_t10'),
      'hello resends tool when age < 100s',
    );
    k.b.close();
  } finally {
    h.done();
  }
});

test('T10: restart replay settles offline immediately without sending if >=100s', async () => {
  const h = makeHome();
  const t0 = 1_000_000;
  const clock = fakeClock(t0 + 105_000);
  try {
    h.turn('t_t10_expire');
    writeCall(h.p.turn('t_t10_expire', TURN_FILES.tools), 'c_t10', t0);
    const k = makeBroker(h, { now: clock.now, timers: clock.timers });
    await k.post('snapshot', snap('t_t10_expire'));
    await k.b.load([{ turn: 't_t10_expire', state: 'running' }]);

    const s = connectShim(k.b, 't_t10_expire');
    await s.next('welcome');

    const helloSent = await k.hello();
    assert.equal(
      helloSent.some((m) => m.type === 'tool' && m.id === 'c_t10'),
      false,
      'no resend when age >= 100s',
    );

    const resultMsg = await s.next('result');
    assert.equal(resultMsg.id, 'c_t10');
    assert.equal(resultMsg.ok, true);
    assert.match(resultMsg.text, /Item 1 snapshot/);
    assert.match(resultMsg.text, /\(Read offline as of this turn’s start; earlier or changed items may be missing\.\)$/);
    k.b.close();
  } finally {
    h.done();
  }
});

test('T11: replayed unsettled read arms timer anchored on at', async () => {
  const h = makeHome();
  const t0 = 1_000_000;
  const clock = fakeClock(t0);
  try {
    h.turn('t_t11_anchor');
    writeCall(h.p.turn('t_t11_anchor', TURN_FILES.tools), 'c_60s', t0);
    await clock.tick(60_000);
    const k = makeBroker(h, { now: clock.now, timers: clock.timers });
    await k.post('snapshot', snap('t_t11_anchor'));
    await k.b.load([{ turn: 't_t11_anchor', state: 'running' }]);
    const s = connectShim(k.b, 't_t11_anchor');
    await s.next('welcome');
    await k.hello();

    await clock.tick(39_000);
    assert.equal(
      s.got.some((m) => m.type === 'result' && m.id === 'c_60s'),
      false,
      'waiting before 40s expire',
    );

    await clock.tick(1000);
    const r = await s.next('result', (m) => m.id === 'c_60s');
    assert.equal(r.ok, true);
    assert.match(r.text, /Item 1 snapshot/);
    assert.match(r.text, /\(Read offline as of this turn’s start; earlier or changed items may be missing\.\)$/);
    k.b.close();
  } finally {
    h.done();
  }
});

test('T11 negative control: corrupted at safely defaults to b.now()', async () => {
  const h = makeHome();
  const clock = fakeClock(1_000_000);
  try {
    h.turn('t_t11_corrupt');
    writeCall(h.p.turn('t_t11_corrupt', TURN_FILES.tools), 'c_corrupt', -500);
    const k = makeBroker(h, { now: clock.now, timers: clock.timers });
    await k.post('snapshot', snap('t_t11_corrupt'));
    await k.b.load([{ turn: 't_t11_corrupt', state: 'running' }]);
    const s = connectShim(k.b, 't_t11_corrupt');
    await s.next('welcome');
    const helloSent = await k.hello();
    assert.ok(
      helloSent.some((m) => m.type === 'tool' && m.id === 'c_corrupt'),
      'hello sends call with corrupted at',
    );
    await clock.tick(99_000);
    assert.equal(
      s.got.some((m) => m.type === 'result' && m.id === 'c_corrupt'),
      false,
      'corrupt at arms full 100s timer',
    );
    await clock.tick(1000);
    const r = await s.next('result', (m) => m.id === 'c_corrupt');
    assert.equal(r.ok, true);
    k.b.close();
  } finally {
    h.done();
  }
});

test('T11 clock clamp: wall-clock backward jump clamps remaining time <= 100s', async () => {
  const h = makeHome();
  const clock = fakeClock(2_000_000);
  let clockTime = 2_000_000;
  const jumpClock = { now: () => clockTime, timers: clock.timers };
  try {
    h.turn('t_t11_jump');
    const k = makeBroker(h, { now: jumpClock.now, timers: jumpClock.timers });
    await k.post('snapshot', snap('t_t11_jump'));
    await k.b.starting('t_t11_jump');
    const s = connectShim(k.b, 't_t11_jump');
    await s.next('welcome');
    const callJump = s.call('c_jump', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c_jump'), 'tool sent');

    clockTime = 1_950_000;
    await clock.tick(100_000);
    const r = await callJump;
    assert.equal(r.ok, true);
    assert.match(r.text, /Item 1 snapshot/);
    k.b.close();
  } finally {
    h.done();
  }
});

test('T13: negative control: live reply at 50ms clears timer and delivers without offline notice', async () => {
  const h = makeHome();
  const clock = fakeClock(1_000_000);
  try {
    const k = makeBroker(h, { now: clock.now, timers: clock.timers });
    await k.post('snapshot', snap('t_t13', 'Snapshot text'));
    h.turn('t_t13');
    await k.b.starting('t_t13');
    const s = connectShim(k.b, 't_t13');
    await s.next('welcome');

    const callPromise = s.call('c_live50', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c_live50'), 'tool sent');

    await clock.tick(50);
    await k.post('reply', { turn: 't_t13', id: 'c_live50', ok: true, text: 'Live transcript reply' });

    const res = await callPromise;
    assert.equal(res.ok, true);
    assert.equal(res.text, 'Live transcript reply');
    assert.doesNotMatch(res.text, /Read offline/);

    await clock.tick(100_000);
    const results = s.got.filter((m) => m.type === 'result' && m.id === 'c_live50');
    assert.equal(results.length, 1, 'exactly one result frame reached the shim');
    k.b.close();
  } finally {
    h.done();
  }
});

test('T14: zero leaked timers across live reply, expiry, and teardown', async () => {
  const h = makeHome();
  const activeTimers = new Set();
  const clock = fakeClock(1_000_000);
  const trackedTimers = {
    setTimeout(fn, ms) {
      const handle = clock.timers.setTimeout(async () => {
        activeTimers.delete(handle);
        await fn();
      }, ms);
      activeTimers.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      activeTimers.delete(handle);
      clock.timers.clearTimeout(handle);
    },
  };

  try {
    const k = makeBroker(h, { now: clock.now, timers: trackedTimers });
    await k.post('snapshot', snap('t_t14', 'Text 1'));
    h.turn('t_t14');
    await k.b.starting('t_t14');
    const s = connectShim(k.b, 't_t14');
    await s.next('welcome');

    // 1. Live reply clears its timer
    const p1 = s.call('c_leak1', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.id === 'c_leak1'), 'sent c_leak1');
    assert.equal(activeTimers.size, 1);
    await k.post('reply', { turn: 't_t14', id: 'c_leak1', ok: true, text: 'Live 1' });
    await p1;
    assert.equal(activeTimers.size, 0, 'timer cleared on live reply');

    // 2. Timer expiry clears its timer
    const p2 = s.call('c_leak2', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.id === 'c_leak2'), 'sent c_leak2');
    assert.equal(activeTimers.size, 1);
    await clock.tick(100_000);
    await p2;
    assert.equal(activeTimers.size, 0, 'timer cleared on deadline expiry');

    // 3. Broker close clears any remaining timers
    s.send('call', { id: 'c_leak3', name: 'read_message', args: { id: 'item_1' } });
    await until(() => k.sent.some((m) => m.id === 'c_leak3'), 'sent c_leak3');
    assert.equal(activeTimers.size, 1);
    k.b.close();
    assert.equal(activeTimers.size, 0, 'surviving timers cleared on broker close');
  } finally {
    h.done();
  }
});
