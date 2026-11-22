// The Stop tests’ runtime (tests/stop-fixture.mjs) with run clocks on, as a Postbox started with POSTBOX_RUN_CLOCK=1
// has them (server/run-clock-install.mjs, #1526).

import { installRunClock } from '../server/run-clock-install.mjs';
import { setup } from './stop-fixture.mjs';

/** @param {import('../server/store.mjs').Store} [store] */
export function clocked(store) {
  const f = setup(store);
  installRunClock(f.rt);
  return f;
}
