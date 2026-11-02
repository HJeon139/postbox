// A read whose live reply fails to write while the link is up (settle.md §5, deadline.md): the reply's failure hands the
// read back to its deadline. Already past, it is answered from the snapshot at once; still ahead, it waits for the deadline.
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import test from 'node:test';
import { REMOTE_READ_TIMEOUT_MS } from '../shared/limits.mjs';
import { connectShim, fakeClock, makeBroker, makeHome, sleep, until } from './remote-broker-fixtures.mjs';

const snap = (turn, text = 'Snapshot text') => ({
  turn,
  home: 'th',
  threads: [{ id: 'th', items: [{ id: 'item_1', line: 'Item 1 line', text }] }],
});

/** How many results for a call reached the shim. */
const results = (s, id) => s.got.filter((m) => m.type === 'result' && m.id === id).length;

/** A file layer whose first reply write waits at `gate` and then fails; `reached` resolves when it is waiting. Later writes succeed. */
const failingReplyIo = () => {
  let release = () => {};
  const gate = new Promise((r) => (release = r));
  let arrive = () => {};
  const reached = new Promise((r) => (arrive = r));
  let failed = false;
  return {
    io: {
      readFile: (p, e) => fsp.readFile(p, e),
      stat: (p) => fsp.stat(p),
      appendFile: async (p, line, o) => {
        if (failed || !line.includes('"op":"reply"')) return fsp.appendFile(p, line, o);
        failed = true;
        arrive();
        await gate;
        throw new Error('disk full');
      },
    },
    reached,
    release,
  };
};

test('T24: a live write that fails after the deadline has passed answers the read offline at once', async () => {
  const h = makeHome();
  const clock = fakeClock(1_000_000);
  const w = failingReplyIo();
  try {
    const k = makeBroker(h, { now: clock.now, timers: clock.timers, io: w.io });
    await k.post('snapshot', snap('t_t24a'));
    h.turn('t_t24a');
    await k.b.starting('t_t24a');
    const s = connectShim(k.b, 't_t24a');
    await s.next('welcome');

    const callPromise = s.call('c_t24a', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c_t24a'), 'tool sent', 250);

    const replied = k.post('reply', { turn: 't_t24a', id: 'c_t24a', ok: true, text: 'Live reply' });
    await w.reached;
    // The deadline fires while the reply is being written: settleOffline sees the claim and returns.
    await clock.tick(REMOTE_READ_TIMEOUT_MS);
    w.release();
    await replied;

    // The write failed with the link up and the deadline already past: the read is settled now, not left open.
    const res = await callPromise;
    assert.equal(res.ok, true);
    assert.match(res.text, /Snapshot text/);
    assert.match(res.text, /Read offline/);
    await sleep(100);
    assert.equal(results(s, 'c_t24a'), 1, 'exactly one answer to the shim');
    k.b.close();
  } finally {
    h.done();
  }
});

test('T24: a live write that fails with the deadline still ahead waits for the deadline, then answers offline once', async () => {
  const h = makeHome();
  const clock = fakeClock(1_000_000);
  const w = failingReplyIo();
  try {
    const k = makeBroker(h, { now: clock.now, timers: clock.timers, io: w.io });
    await k.post('snapshot', snap('t_t24b'));
    h.turn('t_t24b');
    await k.b.starting('t_t24b');
    const s = connectShim(k.b, 't_t24b');
    await s.next('welcome');

    const callPromise = s.call('c_t24b', 'read_message', { id: 'item_1' });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c_t24b'), 'tool sent', 250);

    await clock.tick(1000);
    const replied = k.post('reply', { turn: 't_t24b', id: 'c_t24b', ok: true, text: 'Live reply' });
    await w.reached;
    w.release();
    await replied;

    // The failed write re-arms the deadline with the time that is left: nothing is answered yet.
    await sleep(100);
    assert.equal(results(s, 'c_t24b'), 0, 'the read stays open until the deadline');

    await clock.tick(REMOTE_READ_TIMEOUT_MS - 1000);
    const res = await callPromise;
    assert.equal(res.ok, true);
    assert.match(res.text, /Read offline/);
    await sleep(100);
    assert.equal(results(s, 'c_t24b'), 1, 'exactly one answer to the shim');
    k.b.close();
  } finally {
    h.done();
  }
});
