// Nothing the broker writes starts after its close (#426; the integrator's review of #629, points 2 to 4): close() waits
// for the writes started before it, so a write admitted before the close but starting after it would land in a folder
// the caller is removing. A closed broker starts no journal append and no snapshot write; the call or prompt that
// needed one is refused, as when its record can't be written, and nothing goes to Postbox.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, lines, makeBroker, makeHome, REQUEST, sleep, until } from './remote-broker-fixtures.mjs';
import { holdingIo, journal, reached } from './remote-settle-io.mjs';

const snap = { home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] };

test('a call stopped in its queue check across the close writes no call record and sends nothing to Postbox', async () => {
  const h = makeHome();
  try {
    const turn = 't_a1';
    h.turn(turn);
    const hold = holdingIo((c) => c.kind === 'stat' && c.path.endsWith(TURN_FILES.tools));
    const k = makeBroker(h, { io: hold.io });
    await k.post('snapshot', { turn, ...snap });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await reached(hold); // in queueFull's stat: admitted, holding no claim and no append
    await k.b.close();
    hold.release();
    const result = await until(() => s.got.find((m) => m.type === 'result' && m.id === 'c1'), 'the shim to hear about c1');
    assert.deepEqual(journal(h, turn), [], 'no call record after the close');
    assert.ok(!k.sent.some((m) => m.type === 'tool'), 'nothing went to Postbox');
    assert.equal(result.ok, false, 'and the shim is told it was not taken');
  } finally {
    await h.done();
  }
});

test('a prompt after the close writes no prompt record and goes nowhere', async () => {
  const h = makeHome();
  try {
    const turn = 't_a2';
    h.turn(turn);
    const k = makeBroker(h);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    await k.b.close();
    s.send('permission', { id: 'p1', request: REQUEST });
    const answer = await until(() => s.got.find((m) => m.type === 'permission-answer' && m.id === 'p1'), 'the shim to hear an answer to p1');
    assert.ok(!existsSync(h.p.turn(turn, TURN_FILES.prompts)), 'no prompt record after the close');
    assert.ok(!k.sent.some((m) => m.type === 'prompt'), 'nothing went to Postbox');
    assert.equal(answer.result.behavior, 'deny', 'and it is denied, never left waiting');
  } finally {
    await h.done();
  }
});

test('a read whose call record lands across the close is not settled offline after it', async () => {
  const h = makeHome();
  try {
    const turn = 't_a3';
    h.turn(turn);
    const hold = holdingIo((c) => c.kind === 'appendFile' && c.line.includes('"op":"call"'));
    const k = makeBroker(h, { io: hold.io });
    await k.post('snapshot', { turn, ...snap });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await reached(hold); // waiting on its call record, before any claim
    k.state.attached = false; // Postbox gone: once the record lands, the read is detached
    const closing = k.b.close();
    hold.release();
    await closing;
    await sleep(50);
    assert.deepEqual(
      journal(h, turn).map((r) => r.op),
      ['call'],
      'the call record started before the close, and no reply record after it',
    );
  } finally {
    await h.done();
  }
});

test('a start admitted before the close writes no snapshot after it', async () => {
  const h = makeHome();
  try {
    const turn = 't_a4';
    const k = makeBroker(h);
    // Sent before the folder exists, so it waits in memory for `starting` to write it.
    await k.post('snapshot', { turn, ...snap });
    h.turn(turn);
    const writing = k.b.starting(turn); // admitted: it checks the folder before it writes
    await k.b.close();
    await writing.catch(() => {});
    await sleep(50);
    assert.ok(!existsSync(h.p.turn(turn, TURN_FILES.snapshot)), 'no snapshot after the close');
  } finally {
    await h.done();
  }
});

test('a reply Postbox sends after the close writes no record, and leaves the call for the next daemon', async () => {
  const h = makeHome();
  try {
    const turn = 't_a6';
    h.turn(turn);
    const k = makeBroker(h);
    await k.post('snapshot', { turn, ...snap });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    s.send('call', { id: 'c1', name: 'read_message', args: { id: 'i0' } });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'c1'), 'the read sent to Postbox');
    await k.b.close();
    const got = await k.post('reply', { turn, id: 'c1', ok: true, text: 'from Postbox' });
    await sleep(50);
    assert.deepEqual(
      journal(h, turn).map((r) => r.op),
      ['call'],
      'no reply record after the close',
    );
    assert.equal(got.errors[0]?.code, 'internal', 'Postbox is told it was not taken, so it replies again');
  } finally {
    await h.done();
  }
});

test('an answer Postbox sends after the close writes no record', async () => {
  const h = makeHome();
  try {
    const turn = 't_a7';
    h.turn(turn);
    const k = makeBroker(h);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    await until(() => k.sent.some((m) => m.type === 'prompt'), 'the prompt sent to Postbox');
    await k.b.close();
    const got = await k.post('answer', { turn, prompt: 'p1', result: { behavior: 'allow', updatedInput: {} } });
    await sleep(50);
    assert.deepEqual(
      lines(h.p.turn(turn, TURN_FILES.prompts)).map((r) => r.op),
      ['prompt'],
      'no answer record after the close',
    );
    assert.equal(got.errors[0]?.code, 'internal');
  } finally {
    await h.done();
  }
});
