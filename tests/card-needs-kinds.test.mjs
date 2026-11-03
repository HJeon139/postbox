// Every kind an agent's need can have is ranked (#366; the integrator's re-review of #633: a table that ranks a kind it
// doesn't list fell to a default, so a failed turn's need lost to any card). The kinds are shared/needs.mjs's
// NEEDS_KINDS, which the page's rings and ⌃J read too.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RANK } from '../server/card-needs.mjs';
import { NEEDS_KINDS } from '../shared/needs.mjs';

test('RANK ranks exactly the kinds a need can have', () => {
  assert.deepEqual(Object.keys(RANK).sort(), [...NEEDS_KINDS].sort());
});
