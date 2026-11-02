// broker.close() waits for the writes still landing (#426; the teardown race of #582): an offline answer reaches the shim
// before its reply record is written, so a close that returned at once let a spec, or a shutdown, remove the folder
// under that last append. close() now resolves when the appends and claims in flight have settled, and never rejects.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, makeBroker, makeHome, until } from './remote-broker-fixtures.mjs';
import { holdingIo, journal, reached } from './remote-settle-io.mjs';

const snap = { home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] };

/** An attached read whose link drops: answered offline, and its reply append held (and failing, if `reject`). */
async function lostRead(h, turn, opt) {
  h.turn(turn);
  const hold = holdingIo((c) => c.kind === 'appendFile' && c.line.includes('"op":"reply"'), opt);
  const k = makeBroker(h, { io: hold.io });
  await k.post('snapshot', { turn, ...snap });
  await k.b.starting(turn);
  const s = connectShim(k.b, turn);
  await s.next('welcome');
  s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
  await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c1'), 'the read sent to Postbox');
  k.state.attached = false;
  k.b.driverLost();
  await until(() => s.got.some((m) => m.type === 'result' && m.id === 'c1'), 'the offline answer');
  await reached(hold); // the reply record is being written
  return { hold, k };
}

/** 'pending' if the promise has not settled yet, else its value. */
const state = (p) => Promise.race([Promise.resolve(p), Promise.resolve('pending')]);

test('close waits for the reply record still being written, then resolves', async () => {
  const h = makeHome();
  try {
    const { hold, k } = await lostRead(h, 't_c1');
    const closing = k.b.close();
    assert.equal(await state(closing), 'pending', 'close has not resolved while the append is held');
    hold.release();
    await closing;
    assert.ok(
      journal(h, 't_c1').some((r) => r.op === 'reply'),
      'and the reply record is on disk when it does',
    );
  } finally {
    await h.done();
  }
});

test('close resolves, and does not reject, when the append it waited for fails', async () => {
  const h = makeHome();
  try {
    const { hold, k } = await lostRead(h, 't_c2', { reject: true });
    const closing = k.b.close();
    hold.release();
    await assert.doesNotReject(closing);
  } finally {
    await h.done();
  }
});

test('close with nothing in flight resolves', async () => {
  const h = makeHome();
  try {
    h.turn('t_c3');
    const k = makeBroker(h);
    await assert.doesNotReject(k.b.close());
  } finally {
    await h.done();
  }
});

test('close also waits for an answer still being read from the snapshot, before its reply record is even queued', async () => {
  const h = makeHome();
  try {
    const turn = 't_c4';
    h.turn(turn);
    // On disk and not cached, so the offline read goes to the file, and the held read keeps the claim.
    writeFileSync(h.p.turn(turn, TURN_FILES.snapshot), JSON.stringify(snap));
    const hold = holdingIo((c) => c.kind === 'readFile' && c.path.endsWith(TURN_FILES.snapshot));
    const k = makeBroker(h, { io: hold.io });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c1'), 'the read sent to Postbox');
    k.state.attached = false;
    k.b.driverLost();
    await reached(hold); // the snapshot read is in flight: the call is claimed, and no append is queued yet
    const closing = k.b.close();
    assert.equal(await state(closing), 'pending', 'close waits for the claim');
    hold.release();
    await closing;
    assert.ok(
      journal(h, turn).some((r) => r.op === 'reply'),
      'and the reply record has landed when it does',
    );
  } finally {
    await h.done();
  }
});

test('close also waits for a call record that no claim covers, still being written', async () => {
  const h = makeHome();
  try {
    const turn = 't_c5';
    h.turn(turn);
    const hold = holdingIo((c) => c.kind === 'appendFile' && c.line.includes('"op":"call"'));
    const k = makeBroker(h, { io: hold.io });
    await k.post('snapshot', { turn, ...snap });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await reached(hold); // the call record is being written; the call holds no claim
    const closing = k.b.close();
    assert.equal(await state(closing), 'pending', 'close waits for the append');
    hold.release();
    await closing;
    assert.ok(
      journal(h, turn).some((r) => r.op === 'call'),
      'and the call record has landed when it does',
    );
  } finally {
    await h.done();
  }
});
