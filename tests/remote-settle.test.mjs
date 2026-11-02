// The settle path for reads that can't reach Postbox (designs/508/582/settle.md, #582 part 3): a read answered once
// from the snapshot, the call journaled before its answer, and an ask call never answered from the snapshot.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { REMOTE_LIMITS, TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, makeBroker, makeHome, until } from './remote-broker-fixtures.mjs';

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

// T07 and T08 (settle.md §5), as a sweep: for each delay d between the offline trigger and the live reply, every shim of
// the turn gets exactly one result for the call, and the loser of the race is refused or silent. The claim is
// synchronous, so no delay lets a second answer through; a claim moved after an await lets one through at some d.
const raceOnce = async (d, liveFirst) => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const turn = `t_race_${d}_${liveFirst ? 'l' : 'o'}`;
    h.turn(turn);
    await k.post('snapshot', { turn, ...snapOf(2) });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    const first = s.call('call_r', 'read_message', { id: 'i0' });
    first.catch(() => {});
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_r'), 'the read sent to Postbox');
    k.state.attached = false;
    const s2 = connectShim(k.b, turn);
    await s2.next('welcome');
    const tick = async (n) => {
      for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
    };
    let live;
    let errors = [];
    const resend = () => s2.send('call', { id: 'call_r', name: 'read_message', args: { id: 'i0' } });
    if (liveFirst) {
      live = k.post('reply', { turn, id: 'call_r', ok: true, text: 'LIVE' });
      await tick(d);
      resend();
    } else {
      resend();
      await tick(d);
      live = k.post('reply', { turn, id: 'call_r', ok: true, text: 'LIVE' });
    }
    ({ errors } = await live);
    await tick(60);
    // One answer per shim: every result it gets for the call has the same text. A resend answered from the kept
    // result can add a second copy to the resending connection (the broadcast reaches it too); shim-link drops the
    // copy for a settled call (shim-link.mjs:82-83), so the agent sees one answer. That copy is a wire-level finding.
    const results = (sh) => sh.got.filter((m) => m.type === 'result' && m.id === 'call_r');
    for (const sh of [s, s2]) {
      assert.ok(results(sh).length >= 1, `d=${d}: the shim gets the answer`);
      assert.equal(new Set(results(sh).map((m) => m.text)).size, 1, `d=${d}: the shim gets one answer, not two different ones`);
    }
    const answer = s.got.find((m) => m.type === 'result' && m.id === 'call_r');
    const liveAccepted = errors.length === 0;
    if (liveAccepted) assert.equal(answer.text, 'LIVE', `d=${d}: a live reply accepted is the answer`);
    else {
      assert.ok(
        errors.some((e) => e.code === 'no-tool'),
        `d=${d}: a refused live reply is no-tool`,
      );
      assert.match(answer.text, /x 0/, `d=${d}: the offline settle is the answer`);
    }
  } finally {
    h.done();
  }
};

test('no delay between an offline settle and a live reply lets a second answer through (T07, T08 sweep)', async () => {
  for (let d = 0; d <= 12; d++) {
    await raceOnce(d, false);
    await raceOnce(d, true);
  }
});
