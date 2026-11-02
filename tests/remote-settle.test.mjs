// The settle path for reads that can't reach Postbox (designs/508/582/settle.md, #582 part 3): a read answered once
// from the snapshot, the call journaled before its answer, and an ask call never answered from the snapshot.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { REMOTE_LIMITS, TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, makeBroker, makeHome, turnToken, until } from './remote-broker-fixtures.mjs';

const OFFLINE_NOTE = '\n\n(Read offline as of this turn’s start; earlier or changed items may be missing.)';

/** The turn's journal records; none when the file is not there yet, so the assertion reads as behavior. */
const journal = (h, turn) => {
  const file = h.p.turn(turn, TURN_FILES.tools);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

/** A snapshot with one thread of n items. */
const snapOf = (n, text = 'x') => ({
  home: 'th',
  threads: [{ id: 'th', items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, line: `line ${i}`, text: `${text} ${i}` })) }],
});

test('a fresh read while detached is journaled as a call, then a reply, and answered once', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const turn = 't_detached';
    h.turn(turn);
    await k.post('snapshot', { turn, ...snapOf(3) });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    k.state.attached = false;
    const res = await s.call('call_1', 'read_message', { id: 'i1' });
    assert.equal(res.ok, true);
    assert.match(res.text, /x 1/);
    const rec = journal(h, turn);
    assert.deepEqual(
      rec.map((r) => r.op),
      ['call', 'reply'],
      'the call is journaled before its answer',
    );
    assert.equal(k.sent.filter((m) => m.type === 'tool').length, 0, 'no tool frame is sent to Postbox while detached');
  } finally {
    h.done();
  }
});

// Guard: passes on main too, since main never answers an ask from the snapshot. It fails if the route check goes.
test('an ask call whose live journal write fails while the link is down is not answered from the snapshot', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const turn = 't_ask';
    h.turn(turn);
    await k.post('snapshot', { turn, ...snapOf(2) });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    const pending = s.call('call_ask', 'wake_agent', { handle: 'x', text: 'y' });
    pending.catch(() => {}); // the shim gives up after the test ends; that is not the behavior under test
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_ask'), 'the ask sent to Postbox');
    // The live reply's journal write fails (the file goes read-only) while the link drops.
    chmodSync(h.p.turn(turn, TURN_FILES.tools), 0o400);
    k.state.attached = false;
    await k.post('reply', { turn, id: 'call_ask', ok: true, text: 'done' });
    chmodSync(h.p.turn(turn, TURN_FILES.tools), 0o600); // writable again, so the barrier read can be journaled
    // Barrier: a second, detached read is answered now. Its answer proves the broker has run past the ask's settle attempt.
    const read = await s.call('call_read2', 'read_message', { id: 'i0' });
    assert.match(read.text, /x 0/, 'the read is answered from the snapshot');
    let answered = false;
    pending.then(
      () => (answered = true),
      () => {},
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(answered, false, 'the ask stays open for Postbox; nothing answers it from the snapshot');
  } finally {
    h.done();
  }
});

// Unit: the cap on an offline answer (settle.md §4). No reader in this tree can produce an answer over replyChars end
// to end (a snapshot line is capped at 2,300 characters and read_conversation returns at most 200 items), so the cap is
// tested on the helper. The end-to-end record and wire equality is covered by the detached-read spec above.
test('an offline answer over replyChars is cut to replyChars and keeps the offline notice', async () => {
  // Imported here, not at the top, so the other specs still run where the helper is missing.
  const { offlineText } = await import('../server/remote/host/broker-tools.mjs');
  const big = 'x'.repeat(REMOTE_LIMITS.replyChars + 5000);
  const cut = offlineText(big + OFFLINE_NOTE);
  assert.ok(cut.length <= REMOTE_LIMITS.replyChars, 'within replyChars');
  assert.ok(cut.length > REMOTE_LIMITS.replyChars - 100, 'close to the cap');
  assert.ok(cut.endsWith(OFFLINE_NOTE), 'the offline notice is kept at the end');
  assert.equal(offlineText('short' + OFFLINE_NOTE), 'short' + OFFLINE_NOTE, 'a short answer is unchanged');
});

test('a detached read on a turn at its waiting-call limit is admitted and answered from the snapshot (T19)', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h, { queueLimits: { calls: 1, bytes: 1_000_000_000, recordBytes: 1_000_000_000 } });
    const turn = 't_t19';
    h.turn(turn);
    await k.post('snapshot', { turn, ...snapOf(2) });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    const ask = s.call('call_ask', 'wake_agent', { handle: 'x', text: 'y' });
    ask.catch(() => {});
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_ask'), 'the ask sent and waiting');
    k.state.attached = false;
    const res = await s.call('call_r', 'read_message', { id: 'i1' });
    assert.match(res.text, /x 1/, 'the read is answered from the snapshot even at the waiting limit');
  } finally {
    h.done();
  }
});

test('a detached read on a turn whose record is full is refused with the record-full message (T20)', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h, { queueLimits: { calls: 256, bytes: 64 * 1024 * 1024, recordBytes: 1 } });
    const turn = 't_t20';
    h.turn(turn);
    await k.post('snapshot', { turn, ...snapOf(2) });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    k.state.attached = false;
    const res = await s.call('call_r', 'read_message', { id: 'i0' });
    assert.match(res.text, /record of its calls/, 'refused with the record-full message');
    assert.equal(journal(h, turn).length, 0, 'nothing is journaled for a refused read');
  } finally {
    h.done();
  }
});

// ── The race windows, held with the broker's io seam (settle.md §5). A held file call stands for the window: the
// read of the snapshot for T07, the journal append of the live reply for T08. Nothing sleeps.
import { promises as fsp } from 'node:fs';

/** The held call reached, or a failure naming it, after 2 s: a red run fails here instead of waiting forever. */
const reached = (hold) => Promise.race([hold.entered, new Promise((_, rej) => setTimeout(() => rej(new Error('the held file call was never reached')), 2000))]);

/** A file layer whose first matching call is held until released; `entered` resolves when it is reached. */
const holdingIo = (match) => {
  let release = () => {};
  let arrive = () => {};
  const gate = new Promise((r) => (release = r));
  const entered = new Promise((r) => (arrive = r));
  let held = false;
  const hold = async (call) => {
    if (!held && match(call)) {
      held = true;
      arrive();
      await gate;
    }
  };
  return {
    io: {
      readFile: async (path, enc) => {
        await hold({ kind: 'readFile', path });
        return fsp.readFile(path, enc);
      },
      appendFile: async (path, line, opt) => {
        await hold({ kind: 'appendFile', path, line });
        return fsp.appendFile(path, line, opt);
      },
      stat: (path) => fsp.stat(path),
    },
    entered,
    release,
  };
};

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
    k.state.attached = false;
    const res = await s.call('call_r', 'read_message', { id: 'i0' });
    assert.match(res.text, /x 0/, 'the shim still gets the offline answer');
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
