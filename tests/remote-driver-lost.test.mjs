// driverLost on a broker that is already closed (the integrator's review of #616): the daemon closes the broker, then
// its connections, so the last close of a driver reaches a broker whose folders may be gone. It must do nothing: no
// snapshot read, no result to a shim, no journal write.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, makeBroker, makeHome, until } from './remote-broker-fixtures.mjs';
import { journal } from './remote-settle-io.mjs';

test('driverLost on a closed broker answers nothing and writes nothing', async () => {
  const h = makeHome();
  try {
    const turn = 't_closed';
    h.turn(turn);
    writeFileSync(
      h.p.turn(turn, TURN_FILES.snapshot),
      JSON.stringify({ home: 'th', threads: [{ id: 'th', items: [{ id: 'i0', line: 'line 0', text: 'x 0' }] }] }),
    );
    const k = makeBroker(h);
    await k.b.starting(turn);
    const s = connectShim(k.b, turn);
    await s.next('welcome');
    s.send('call', { id: 'call_r', name: 'read_message', args: { id: 'i0' } });
    await until(() => k.sent.some((m) => m.type === 'tool' && m.id === 'call_r'), 'the read sent to Postbox');
    const before = journal(h, turn).length;
    k.b.close();
    k.state.attached = false;
    k.b.driverLost();
    // The claim is the observable: an unguarded driverLost claims the read (settleOffline sets it before any await),
    // and the hello then skips it; a guarded one leaves the read open, so the hello sends it again.
    const resent = await k.hello();
    assert.equal(resent.filter((m) => m.type === 'tool' && m.id === 'call_r').length, 1, 'the read was not claimed');
    assert.equal(s.got.filter((m) => m.type === 'result').length, 0, 'no result reached the shim');
    assert.equal(journal(h, turn).length, before, 'and nothing was written to the journal');
  } finally {
    h.done();
  }
});
