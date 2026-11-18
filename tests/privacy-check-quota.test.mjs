// The privacy check on a harness’s quota figures (tools/privacy-check.mjs): Antigravity’s `/usage` says how much of each
// window is left, which is the person’s own account data, so a recorded answer keeps every remaining fraction at 1 (#1466).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkContentPrivacy } from '../tools/privacy-check.mjs';

test('privacy checker flags an Antigravity window’s remaining fraction unless it is 1', () => {
  assert.ok(checkContentPrivacy(JSON.stringify({ remaining_fraction: 0.96 })).length > 0, 'flags 0.96');
  assert.ok(checkContentPrivacy(JSON.stringify({ remaining_fraction: 0 })).length > 0, 'flags 0');
  assert.ok(checkContentPrivacy(JSON.stringify(JSON.stringify({ remaining_fraction: 0.5 }))).length > 0, 'flags one escaped in a string');
  assert.equal(checkContentPrivacy('{"remaining_fraction":1,"window":"5h"}').length, 0);
  assert.equal(checkContentPrivacy('{"remaining_fraction": 1.0}').length, 0);
});
