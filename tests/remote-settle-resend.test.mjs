// A reply's journal write that fails must leave the call sendable (#616, the integrator's review at 9f7934c7): while
// Postbox's reply is being written the call counts as taken (settled), but only a read that settleOffline holds may be
// skipped by the hello's resend. For any other call the write can still fail, and then nothing else would send it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectShim, makeBroker, makeHome, until } from './remote-broker-fixtures.mjs';
import { holdingIo, reached } from './remote-settle-io.mjs';

const CALLS = [
  ['an ask call', 'corpus_search', { query: 'y' }],
  ['a queue call', 'define_term', { term: 'x', definition: 'y' }],
  ['a read', 'read_conversation', {}],
];

for (const [what, name, args] of CALLS)
  test(`${what} whose reply write fails after a reconnect is sent again by that hello (the integrator's trace)`, async () => {
    const h = makeHome();
    try {
      const turn = 't_resend';
      h.turn(turn);
      const hold = holdingIo((c) => c.kind === 'appendFile' && c.line.includes('"op":"reply"'), { reject: true });
      const k = makeBroker(h, { io: hold.io });
      await k.b.starting(turn);
      const s = connectShim(k.b, turn);
      await s.next('welcome');
      s.send('call', { id: 'call_r', name, args });
      await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_r'), 'the call sent to Postbox');
      const posting = k.post('reply', { turn, id: 'call_r', ok: true, text: 'LIVE' });
      await reached(hold); // Postbox's reply is being written: the call is taken
      const resent = await k.hello(); // the same Postbox reconnects meanwhile
      hold.release(); // the write fails
      const { errors } = await posting;
      assert.deepEqual(
        errors.map((e) => e.code),
        ['internal'],
        'Postbox is told to reply again',
      );
      assert.equal(
        resent.filter((m) => m.type === 'tool' && m.id === 'call_r').length,
        1,
        'and the reconnect sent the call again, since the reply that was in flight never landed',
      );
    } finally {
      h.done();
    }
  });
