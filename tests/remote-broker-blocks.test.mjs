// The daemon’s broker (server/remote/host/broker-tools.mjs’s prepare, #120) and the blocks a host’s agent sends: what
// it checks before a call is queued for Postbox, and what it leaves to Postbox. Driven in-process, as
// tests/remote-broker.test.mjs drives it, with the fixtures in tests/remote-broker-fixtures.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectShim, makeBroker, makeHome } from './remote-broker-fixtures.mjs';

test('#854 an outcome or a withdraw update_block from a host is queued for Postbox, as the laptop takes it', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const outcome = { id: 'pick', outcome: 'Filed as #1' };
    const withdraw = { id: 'pick', withdraw: 'The question is stale.' };
    assert.equal((await s.call('c1', 'update_block', { block: outcome })).ok, true);
    assert.equal((await s.call('c2', 'update_block', { block: withdraw })).ok, true);
    assert.deepEqual(
      k.sent.map((m) => [m.id, m.args.block]),
      [
        ['c1', outcome],
        ['c2', withdraw],
      ],
    );
    assert.doesNotMatch(k.logs.join('\n'), /was refused/);
  } finally {
    await h.done();
  }
});
