// The settle path for reads that can't reach Postbox (designs/508/582/settle.md, #582 part 3): a read answered once
// from the snapshot, the call journaled before its answer, and an ask call never answered from the snapshot.
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, makeBroker, makeHome, until } from './remote-broker-fixtures.mjs';

const journal = (h, turn) =>
  readFileSync(h.p.turn(turn, TURN_FILES.tools), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

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
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_ask'), 'the ask sent to Postbox');
    // The live reply's journal write fails (the file goes read-only) while the link drops.
    chmodSync(h.p.turn(turn, TURN_FILES.tools), 0o400);
    k.state.attached = false;
    await k.post('reply', { turn, id: 'call_ask', ok: true, text: 'done' });
    const won = await Promise.race([pending.then(() => 'answered'), new Promise((r) => setTimeout(() => r('open'), 100))]);
    assert.equal(won, 'open', 'an ask stays open for Postbox; nothing answers it from the snapshot');
  } finally {
    h.done();
  }
});

test('an offline read longer than replyChars keeps the offline notice, and the record and the wire match', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const turn = 't_long';
    h.turn(turn);
    await k.post('snapshot', { turn, ...snapOf(1, 'z'.repeat(20000)) });
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    k.state.attached = false;
    const res = await s.call('call_long', 'read_conversation', {});
    assert.ok(res.text.length <= 1_000_000, 'the answer is within replyChars');
    assert.match(res.text, /earlier or changed items may be missing/, 'the notice is kept');
    const rec = journal(h, turn).find((r) => r.op === 'reply');
    assert.equal(rec.text, res.text, 'the journal and the wire carry the same text');
  } finally {
    h.done();
  }
});
