// #1715: the page reads a progress step as stalled once the turn that owns it has ended (its session's finishedAt).
// A turn a crash cut off never reached its end here, so the restart's sweep now stamps finishedAt as it settles the
// session, and a step that turn left running reads as stalled rather than running for good.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleInterrupted } from '../server/restart-sweep.mjs';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';

test('#1715 a restart marks the turn it cut off as ended, and leaves an idle session as it was', () => {
  const f = setup();
  arrange.setSession(f.rt, f.alpha.id, { state: 'tool', finishedAt: null });
  arrange.setSession(f.rt, f.beta.id, { state: 'idle', finishedAt: 1234 });
  const before = Date.now();
  settleInterrupted(f.rt);
  assert.ok(f.store.state.sessions[f.alpha.id].finishedAt >= before, 'the cut-off turn has ended');
  assert.equal(f.store.state.sessions[f.beta.id].finishedAt, 1234, 'an idle session is untouched');
});
