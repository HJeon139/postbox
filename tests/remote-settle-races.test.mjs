// The race windows of the settle path (settle.md §5, #582 part 3): the same offline settle, held at the io seam so
// the other side arrives inside the window. Split from remote-settle.test.mjs to stay under the 300-line cap.
import assert from 'node:assert/strict';
// ── The race windows, held with the broker's io seam (settle.md §5). A held file call stands for the window: the
// read of the snapshot for T07, the journal append of the live reply for T08. Nothing sleeps.
import { promises as fsp, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, makeBroker, makeHome, turnToken, until } from './remote-broker-fixtures.mjs';
import { holdingIo, journal, reached } from './remote-settle-io.mjs';

test('a live reply that arrives while an offline settle reads the snapshot is refused, and the shim gets one answer (T07)', async () => {
  const h = makeHome();
  try {
    const turn = 't_t07';
    h.turn(turn);
    // The snapshot is on disk and nothing is cached: the offline read has to go to the file.
    writeFileSync(
      h.p.turn(turn, TURN_FILES.snapshot),
      JSON.stringify({ home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] }),
    );
    const hold = holdingIo((c) => c.kind === 'readFile' && c.path.endsWith(TURN_FILES.snapshot));
    const k = makeBroker(h, { io: hold.io });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    const first = s.call('call_r', 'read_message', { id: 'i0' });
    first.catch(() => {});
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_r'), 'the read sent to Postbox');
    k.state.attached = false;
    const s2 = connectShim(k.b, turn);
    await s2.next('welcome');
    s2.send('call', { id: 'call_r', name: 'read_message', args: { id: 'i0' } }); // the offline settle starts, and reads
    await reached(hold); // the snapshot read is in flight: the call is claimed
    const { errors } = await k.post('reply', { turn, id: 'call_r', ok: true, text: 'LIVE' });
    assert.ok(
      errors.some((e) => e.code === 'no-tool'),
      'the live reply is refused with no-tool while the call is claimed',
    );
    hold.release();
    const res = await first;
    assert.match(res.text, /x 0/, 'the shim gets the snapshot answer');
    const texts = s.got.filter((m) => m.type === 'result' && m.id === 'call_r').map((m) => m.text);
    assert.equal(new Set(texts).size, 1, 'the shim gets one answer, not two different ones');
  } finally {
    h.done();
  }
});

test('an offline settle that starts during a live reply’s journal write returns, and the shim gets the live answer (T08)', async () => {
  const h = makeHome();
  try {
    const turn = 't_t08';
    h.turn(turn);
    writeFileSync(
      h.p.turn(turn, TURN_FILES.snapshot),
      JSON.stringify({ home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] }),
    );
    const hold = holdingIo((c) => c.kind === 'appendFile' && c.line.includes('"op":"reply"'));
    const k = makeBroker(h, { io: hold.io });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    const first = s.call('call_r', 'read_message', { id: 'i0' });
    first.catch(() => {});
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_r'), 'the read sent to Postbox');
    const live = k.post('reply', { turn, id: 'call_r', ok: true, text: 'LIVE' }); // claims, then its journal write is held
    await reached(hold);
    k.state.attached = false;
    const s2 = connectShim(k.b, turn);
    await s2.next('welcome');
    s2.send('call', { id: 'call_r', name: 'read_message', args: { id: 'i0' } }); // the offline settle sees the claim and returns
    await new Promise((r) => setImmediate(r));
    hold.release();
    await live;
    const res = await first;
    assert.equal(res.text, 'LIVE', 'the live answer is the one the shim gets');
    const texts = s.got.filter((m) => m.type === 'result' && m.id === 'call_r').map((m) => m.text);
    assert.equal(new Set(texts).size, 1, 'the shim gets one answer, not two different ones');
  } finally {
    h.done();
  }
});

test('a journal write that fails for the offline reply still answers the shim, and the record is not in the journal (T09)', async () => {
  const h = makeHome();
  try {
    const turn = 't_t09';
    h.turn(turn);
    writeFileSync(
      h.p.turn(turn, TURN_FILES.snapshot),
      JSON.stringify({ home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] }),
    );
    const io = {
      readFile: (p, e) => fsp.readFile(p, e),
      stat: (p) => fsp.stat(p),
      appendFile: (p, line, o) => (line.includes('"op":"reply"') ? Promise.reject(new Error('disk full')) : fsp.appendFile(p, line, o)),
    };
    const k = makeBroker(h, { io });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    const pending = s.call('call_r', 'read_message', { id: 'i0' });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_r'), 'the read sent to Postbox');
    k.state.attached = false; // the link drops: a read with a call record is answered offline, and its reply record fails
    k.b.driverLost();
    const res = await pending;
    assert.match(res.text, /x 0/, 'the shim still gets the offline answer');
    await until(() => k.logs.some((l) => /disk full/.test(l)), 'the failed write to be logged');
    assert.ok(
      k.logs.some((l) => /disk full/.test(l)),
      'the failed write is logged',
    );
    assert.ok(!journal(h, turn).some((r) => r.op === 'reply'), 'no reply record reached the journal');
  } finally {
    h.done();
  }
});

// ── T17, T21, T22, T25: the remaining settle-path specs, with the io seam where a window must be held.

test('a link lost while the call record is being written sends no tool frame and answers the read offline (T17)', async () => {
  const h = makeHome();
  try {
    const turn = 't_t17';
    h.turn(turn);
    writeFileSync(
      h.p.turn(turn, TURN_FILES.snapshot),
      JSON.stringify({ home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] }),
    );
    const hold = holdingIo((c) => c.kind === 'appendFile' && c.line.includes('"op":"call"'));
    const k = makeBroker(h, { io: hold.io });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    const pending = s.call('call_r', 'read_message', { id: 'i0' });
    await reached(hold); // the call record is being written
    k.state.attached = false; // the link drops during the write
    hold.release();
    const res = await pending;
    assert.match(res.text, /x 0/, 'the read is answered offline');
    assert.equal(k.sent.filter((m) => m.type === 'tool' && m.id === 'call_r').length, 0, 'no tool frame is sent');
  } finally {
    h.done();
  }
});

test('a takeover hello that arrives while an offline settle holds the call does not resend the call (T21)', async () => {
  const h = makeHome();
  try {
    const turn = 't_t21';
    h.turn(turn);
    writeFileSync(
      h.p.turn(turn, TURN_FILES.snapshot),
      JSON.stringify({ home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] }),
    );
    const hold = holdingIo((c) => c.kind === 'readFile' && c.path.endsWith(TURN_FILES.snapshot));
    const k = makeBroker(h, { io: hold.io });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    const first = s.call('call_r', 'read_message', { id: 'i0' });
    first.catch(() => {});
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_r'), 'the read sent to Postbox');
    k.state.attached = false;
    const s2 = connectShim(k.b, turn);
    await s2.next('welcome');
    s2.send('call', { id: 'call_r', name: 'read_message', args: { id: 'i0' } });
    await reached(hold); // the offline settle holds the call, in its snapshot read
    const before = k.sent.filter((m) => m.type === 'tool' && m.id === 'call_r').length;
    k.state.attached = true;
    const resent = await k.hello(); // a takeover hello resends what is still open; its frames come back here
    assert.equal(resent.filter((m) => m.type === 'tool' && m.id === 'call_r').length, 0, 'the held call is not resent to the new driver');
    assert.equal(before, 1, 'the call was sent once, before the takeover');
    hold.release();
    const res = await first;
    assert.match(res.text, /x 0/, 'the shim gets the one offline answer');
  } finally {
    h.done();
  }
});

test('a live reply that arrives after the offline answer is refused with no-tool (T22)', async () => {
  const h = makeHome();
  try {
    const turn = 't_t22';
    h.turn(turn);
    writeFileSync(
      h.p.turn(turn, TURN_FILES.snapshot),
      JSON.stringify({ home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] }),
    );
    const k = makeBroker(h);
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    k.state.attached = false;
    const res = await s.call('call_r', 'read_message', { id: 'i0' }); // answered offline, call settled
    assert.match(res.text, /x 0/);
    const { errors } = await k.post('reply', { turn, id: 'call_r', ok: true, text: 'LATE' });
    assert.ok(
      errors.some((e) => e.code === 'no-tool'),
      'a late live reply is refused with no-tool',
    );
    const texts = s.got.filter((m) => m.type === 'result' && m.id === 'call_r').map((m) => m.text);
    assert.equal(new Set(texts).size, 1, 'the shim gets one answer');
  } finally {
    h.done();
  }
});

test('a shim whose send throws does not stop the answer reaching the other shims (T25)', async () => {
  const h = makeHome();
  try {
    const turn = 't_t25';
    h.turn(turn);
    writeFileSync(
      h.p.turn(turn, TURN_FILES.snapshot),
      JSON.stringify({ home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] }),
    );
    const k = makeBroker(h);
    await k.b.starting(turn);
    // A shim whose connection breaks after its welcome: each write after that throws.
    let broken = false;
    k.b.shim({
      first: JSON.stringify({ type: 'hello', token: turnToken(turn), turn }),
      write: () => {
        if (broken) throw new Error('connection gone');
        broken = true;
        return true;
      },
      end: () => {},
    });
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    k.state.attached = false;
    const res = await s.call('call_r', 'read_message', { id: 'i0' });
    assert.match(res.text, /x 0/, 'the good shim still gets the answer');
  } finally {
    h.done();
  }
});
