// #1987: a turn’s stop names who stopped it, with no default. Since #1928, a stop by the person ('you') marks the
// session’s stoppedTurnId, so that turn’s cards stay quiet; a stop that left `by` out would count as the person’s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stop } from '../server/turn-stop.mjs';

/** A runtime with no turn running: stop would return false at once, so the check has to come first. */
const idle = { turns: new Map() };

test('#1987 a stop that doesn’t say who stopped the turn is refused, whether or not a turn runs', () => {
  for (const opts of [undefined, {}, { silent: true }, { by: 'someone' }, { by: 'store' }])
    assert.throws(() => stop(/** @type {any} */ (idle), 'se_1', /** @type {any} */ (opts)), /who stopped the turn/, JSON.stringify(opts));
});

test('#1987 each kind of stop is taken', () => {
  for (const by of ['you', 'shutdown', 'hung', 'clock', 'pause'])
    assert.equal(stop(/** @type {any} */ (idle), 'se_1', { by }), false, `${by}: no turn running, so nothing to stop`);
});
