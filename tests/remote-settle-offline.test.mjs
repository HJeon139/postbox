// An offline answer reaches the shim before any journal write (designs/508/582/settle.md; the integrator's review of
// #616): a hung or failing disk must not hold up an answer the host already has. Each case holds a file call at the
// broker's io seam and checks the shim hears the answer meanwhile.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectShim, makeBroker, makeHome, until } from './remote-broker-fixtures.mjs';
import { holdingIo, journal, reached } from './remote-settle-io.mjs';

const snap = { home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] };

/** A broker with the snapshot on file, its io held where `match` says, and a shim already welcomed. */
async function room(h, turn, match, opt) {
  h.turn(turn);
  const hold = holdingIo(match, opt);
  const k = makeBroker(h, { io: hold.io });
  await k.post('snapshot', { turn, ...snap });
  await k.b.starting(turn);
  const s = connectShim(k.b, turn);
  await s.next('welcome');
  return { hold, k, s };
}

/** The first result frame for `id`, or null after 1.5 s: a red run fails on this, not on a timeout of the whole suite. */
const heard = (s, id) => until(() => s.got.find((m) => m.type === 'result' && m.id === id), `the answer to ${id}`, 1500).catch(() => null);

test('a fresh detached read is answered while every journal append is held, and appends nothing', async () => {
  const h = makeHome();
  try {
    const { hold, k, s } = await room(h, 't_s1', (c) => c.kind === 'appendFile');
    k.state.attached = false;
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    const res = await heard(s, 'c1');
    assert.match(res?.text ?? '', /x 0/, 'the shim heard the answer with the journal held');
    hold.release();
    assert.deepEqual(journal(h, 't_s1'), [], 'and no record was written');
  } finally {
    h.done();
  }
});

test('an attached read that loses its link is answered before its reply record is written', async () => {
  const h = makeHome();
  try {
    const { hold, k, s } = await room(h, 't_s2', (c) => c.kind === 'appendFile' && c.line.includes('"op":"reply"'));
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c1'), 'the read sent to Postbox');
    k.state.attached = false;
    k.b.driverLost();
    const res = await heard(s, 'c1');
    assert.match(res?.text ?? '', /x 0/, 'the shim heard the answer while the reply append is held');
    await reached(hold); // the reply record is written afterwards
    hold.release();
    await until(() => journal(h, 't_s2').some((r) => r.op === 'reply'), 'the reply record, once the write is let go');
    assert.deepEqual(
      journal(h, 't_s2').map((r) => r.op),
      ['call', 'reply'],
      'a reply record follows its call record',
    );
  } finally {
    h.done();
  }
});

test('a link lost while the call record is written: the offline answer comes at once, and a call record that then fails answers nothing more', async () => {
  const h = makeHome();
  try {
    const { hold, k, s } = await room(h, 't_s3', (c) => c.kind === 'appendFile' && c.line.includes('"op":"call"'), { reject: true });
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await reached(hold); // the call record is being written
    k.state.attached = false;
    k.b.driverLost();
    const res = await heard(s, 'c1');
    assert.match(res?.text ?? '', /x 0/, 'answered while the call append is held');
    hold.release(); // the append now fails
    await until(() => k.logs.some((l) => /Couldn’t record call/.test(l)), 'the failed call record to be handled');
    assert.equal(s.got.filter((m) => m.type === 'result' && m.id === 'c1').length, 1, 'exactly one result for the call');
  } finally {
    h.done();
  }
});

test('after a restart, a resend of a fresh detached read is answered from the snapshot again', async () => {
  const h = makeHome();
  try {
    const { k, s } = await room(h, 't_s4', () => false);
    k.state.attached = false;
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    assert.match((await heard(s, 'c1'))?.text ?? '', /x 0/);
    const again = makeBroker(h);
    await again.b.load([{ turn: 't_s4', state: 'running' }]);
    again.state.attached = false;
    const s2 = connectShim(again.b, 't_s4');
    await s2.next('welcome');
    s2.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    assert.match((await heard(s2, 'c1'))?.text ?? '', /x 0/, 'the snapshot is read again');
  } finally {
    h.done();
  }
});

test('after a restart, a read that lost its link with no reply record replays open and is sent to Postbox again', async () => {
  const h = makeHome();
  try {
    const { hold, k, s } = await room(h, 't_s5', (c) => c.kind === 'appendFile' && c.line.includes('"op":"reply"'));
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c1'), 'the read sent to Postbox');
    k.state.attached = false;
    k.b.driverLost();
    assert.match((await heard(s, 'c1'))?.text ?? '', /x 0/, 'the shim holds the offline answer');
    await reached(hold); // the daemon dies here: the reply record is never written
    const again = makeBroker(h);
    await again.b.load([{ turn: 't_s5', state: 'running' }]);
    const resent = await again.hello();
    assert.equal(resent.filter((m) => m.type === 'tool' && m.id === 'c1').length, 1, 'the replayed call is open, and sent again');
  } finally {
    h.done();
  }
});
