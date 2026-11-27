// The log of refused sign-ins (server/identity/refusal-log.mjs): the reason’s name for whoever runs a hosted Postbox,
// at most one line a minute for each reason, and nothing of the request.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refusalLog } from '../server/identity/refusal-log.mjs';

test('each reason is written once a minute, and the next line says how many it stood for', () => {
  let now = 0;
  /** @type {string[]} */
  const lines = [];
  const refused = refusalLog({ now: () => now, log: (line) => lines.push(line) });
  for (let i = 0; i < 5; i++) refused({ status: 401, code: 'sign-in', reason: 'signer' });
  refused({ status: 403, code: 'not-allowed' });
  assert.deepEqual(lines, ['Postbox refused a sign-in: signer.', 'Postbox refused a sign-in: not-allowed.']);
  now = 60_000;
  refused({ status: 401, code: 'sign-in', reason: 'signer' });
  assert.equal(lines[2], 'Postbox refused a sign-in: signer, and 4 more like it since it last said so.');
});

test('a refusal says its reason’s name and nothing the request carried', () => {
  /** @type {string[]} */
  const lines = [];
  const refused = refusalLog({ now: () => 0, log: (line) => lines.push(line) });
  refused(Object.assign(new Error('You’re signed in as Robin Example, and this Postbox isn’t open to you.'), { status: 403, code: 'not-allowed' }));
  assert.deepEqual(lines, ['Postbox refused a sign-in: not-allowed.']);
});
