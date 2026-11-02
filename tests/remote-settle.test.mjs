// The settle path for reads that can't reach Postbox (designs/508/582/settle.md, #582 part 3): a read answered once
// from the snapshot, the call journaled before its answer, and an ask call never answered from the snapshot.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { offlineText } from '../server/remote/host/broker-tools.mjs';
import { REMOTE_LIMITS } from '../shared/remote-protocol.mjs';
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
test('an offline answer over replyChars is cut to replyChars and keeps the offline notice', () => {
  const big = 'x'.repeat(REMOTE_LIMITS.replyChars + 5000);
  const cut = offlineText(big + OFFLINE_NOTE);
  assert.ok(cut.length <= REMOTE_LIMITS.replyChars, 'within replyChars');
  assert.ok(cut.length > REMOTE_LIMITS.replyChars - 100, 'close to the cap');
  assert.ok(cut.endsWith(OFFLINE_NOTE), 'the offline notice is kept at the end');
  assert.equal(offlineText('short' + OFFLINE_NOTE), 'short' + OFFLINE_NOTE, 'a short answer is unchanged');
});
