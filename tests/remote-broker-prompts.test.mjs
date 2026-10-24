// The daemon’s broker (server/remote/host/broker.mjs, #120), driven in-process: permission prompts, their answers and
// their ends. A shim is a pair of functions, Postbox is a list of what the broker sent it, and the turn folders are in
// a temp home (tests/remote-broker-fixtures.mjs). Nothing is spawned; the real daemon, runner and shim are in
// tests/integration/remote-broker.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { STOPPED_TEXT } from '../server/remote/host/broker.mjs';
import { HOST_DEFAULTS, TURN_FILES } from '../shared/remote-protocol.mjs';
import { blockFile, connectShim, fakeClock, lines, makeBroker, makeHome, REQUEST, sleep, until } from './remote-broker-fixtures.mjs';

// ── Permission prompts ──

test('a prompt crosses to Postbox, its answer reaches the shim, and again when the shim resends it after a reconnect', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    await until(() => k.sent.length, 'the prompt');
    assert.deepEqual(k.sent[0], { type: 'prompt', id: 'p1', turn: 't1', request: REQUEST });
    assert.deepEqual(
      lines(h.p.turn('t1', TURN_FILES.prompts)).map((x) => x.op),
      ['prompt'],
    );
    assert.equal((await k.post('answer', { turn: 't1', prompt: 'nope', result: { behavior: 'deny', message: 'no' } })).errors[0].code, 'no-prompt');
    // The shim went away; the answer waits for it.
    s.close();
    const allow = { behavior: 'allow', updatedInput: { command: 'ls' } };
    assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: allow })).errors, []);
    assert.equal(s.got.filter((m) => m.type === 'permission-answer').length, 0);
    assert.deepEqual(
      (await k.hello()).filter((m) => m.type === 'prompt'),
      [],
      'an answered prompt isn’t sent again',
    );
    // A restarted daemon still has the answer.
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    const s2 = connectShim(again.b, 't1');
    await s2.next('welcome');
    s2.send('permission', { id: 'p1', request: REQUEST });
    assert.deepEqual(await s2.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: allow });
    assert.deepEqual(again.sent, [], 'a resent prompt isn’t a new one');
  } finally {
    h.done();
  }
});

test('a prompt the shim expired or the harness canceled ends: Postbox hears prompt-expired, now or at its next hello', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    s.send('permission', { id: 'p2', request: REQUEST });
    s.send('permission', { id: 'p3', request: REQUEST });
    await until(() => k.sent.length === 3, 'three prompts');
    s.send('permission-expired', { id: 'p1', at: 111 });
    await until(() => k.sent.length === 4, 'the expiry');
    assert.deepEqual(k.sent[3], { type: 'prompt-expired', id: 'p1', turn: 't1', at: 111, reason: 'expired' });
    k.state.attached = false;
    s.send('permission-canceled', { id: 'p2', at: 222 });
    await until(() => k.b.pending.expiries.length, 'the held expiry');
    // Across a restart, the unsent expiry and the prompt still waiting are sent at the next hello.
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(await again.hello(), [
      { type: 'prompt', id: 'p3', turn: 't1', request: REQUEST },
      { type: 'prompt-expired', id: 'p2', turn: 't1', at: 222, reason: 'canceled' },
    ]);
    assert.deepEqual(
      (await again.hello()).map((m) => m.type),
      ['prompt'],
      'an expiry is sent once',
    );
    assert.equal((await again.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'late' } })).errors[0].code, 'no-prompt');
    // Once the turn has ended, a prompt still waiting can’t be answered: the hello ends it instead.
    writeFileSync(h.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
    const after = await again.hello();
    assert.deepEqual(
      after.map((m) => [m.type, m.id]),
      [['prompt-expired', 'p3']],
    );
    assert.equal(after[0].reason, 'canceled');
  } finally {
    h.done();
  }
});

test('Stop ends a turn’s waiting prompts, and an answer for them is refused', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    await until(() => k.sent.length, 'the prompt');
    await k.b.stopping('t1');
    assert.deepEqual(k.sent.at(-1), { type: 'prompt-expired', id: 'p1', turn: 't1', at: k.sent.at(-1).at, reason: 'canceled' });
    assert.equal((await k.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'x' } })).errors[0].code, 'no-prompt');
    s.send('permission', { id: 'p2', request: REQUEST });
    assert.equal((await s.next('error', (m) => m.code === 'turn-ended')).message, STOPPED_TEXT);
  } finally {
    h.done();
  }
});

test('an expiry the broker can’t write down still ends the prompt, unanswerable, and Postbox hears an error, not prompt-expired', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('t1');
    const file = h.p.turn('t1', TURN_FILES.prompts);
    const wait = 60_000;
    const opts = { now: clock.now, timers: clock.timers, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) };
    const k = makeBroker(h, opts);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    s.send('permission', { id: 'p2', request: REQUEST });
    await until(() => k.sent.length === 2, 'the prompts');
    // prompts.jsonl can’t be appended to while the harness cancels p1; what it held before is put back after.
    const before = readFileSync(file, 'utf8');
    blockFile(file);
    s.send('permission-canceled', { id: 'p1', at: clock.now() });
    await until(() => k.sent.length === 3, 'the error');
    assert.deepEqual(
      k.sent.slice(2).map((m) => [m.type, m.code, m.re, m.turn, m.id]),
      [['error', 'internal', 'prompt-expired', 't1', 'p1']],
      'no prompt-expired, as if it were on disk; the error names the prompt, so Postbox ends exactly its card',
    );
    assert.match(k.sent[2].message, /couldn’t write down that prompt p1 in turn t1 was canceled/);
    // The shim gave up on it all the same: it can’t be answered, and isn’t sent again.
    const late = await k.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'late' } });
    assert.equal(late.errors[0]?.code, 'no-prompt');
    assert.deepEqual(
      (await k.hello()).map((m) => [m.type, m.id]),
      [['prompt', 'p2']],
    );
    assert.deepEqual(
      s.got.filter((m) => m.type === 'permission-answer'),
      [],
    );
    rmSync(file, { recursive: true });
    writeFileSync(file, before);
    k.b.close();
    // A restart from those records: nothing said p1 ended, so it waits again, and Postbox is shown it. No shim waits for
    // it (the shim sent its notice, and resends only p2), so at permissionWaitMax from when it was asked, when any shim
    // would have given up, it ends.
    const again = makeBroker(h, opts);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(
      (await again.hello()).map((m) => [m.type, m.id]),
      [
        ['prompt', 'p1'],
        ['prompt', 'p2'],
      ],
    );
    const s2 = connectShim(again.b, 't1');
    await s2.next('welcome');
    s2.send('permission', { id: 'p2', request: REQUEST });
    await sleep(20);
    await clock.tick(wait);
    await until(() => again.sent.length, 'p1’s expiry');
    assert.deepEqual(
      again.sent.map((m) => [m.type, m.id, m.reason]),
      [['prompt-expired', 'p1', 'expired']],
      'p2’s shim still waits on it, and ends it itself',
    );
    assert.deepEqual(
      again.b.pending.prompts.map((q) => q.id),
      ['p2'],
    );
    assert.equal((await again.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'late' } })).errors[0]?.code, 'no-prompt');
    again.b.close();
    // Restarted past that point, the prompts nobody has sent again are ended at the hello, not shown.
    const third = makeBroker(h, opts);
    writeFileSync(file, `${JSON.stringify({ op: 'prompt', id: 'p3', request: REQUEST, at: clock.now() - wait })}\n`, { flag: 'a' });
    await third.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(
      (await third.hello()).map((m) => [m.type, m.id]),
      [
        ['prompt-expired', 'p2'],
        ['prompt-expired', 'p3'],
      ],
    );
    third.b.close();
  } finally {
    h.done();
  }
});
