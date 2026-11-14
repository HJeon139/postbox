// session.joined’s listener runs where its call ran (designs/architecture/services.md, “Risks”): when an agent joins a
// conversation, a decline of adding it there is lifted by the time the join returns (#789). If the lift ran late, a
// wake the same request makes next would still read the decline and hold, as if the person had said no.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';

test('the person adding an agent lifts its decline before the add returns, not after (#789)', () => {
  const f = setup();
  const decline = arrange.post(f.rt, f.t.id, { kind: 'hop', join: true, fromSessionId: f.alpha.id, from: 'alpha', to: 'gamma', text: 'x', status: 'declined' });
  f.rt.ensureSession(f.t.id, f.c.id);
  // Read in the same synchronous run as the add.
  assert.equal(typeof f.store.item(f.t.id, decline.id).lifted, 'number');
});
