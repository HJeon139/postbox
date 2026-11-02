// A turn's work is recorded when it ends (runtime.mjs endWork), and nothing awaits it: if the ledger can't write, that
// must be a warning, not an unhandled rejection, which would take the server down.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './side-threads-fixture.mjs';

test('a ledger that rejects while a turn ends is warned about, and endWork still resolves', async () => {
  const { rt, t, alpha } = setup();
  rt.ledger.endTurn = () => Promise.reject(new Error('disk full'));
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await rt.endWork({ id: 'turn_1', threadId: t.id, sessionId: alpha.id, work: { convId: t.id, se: { handle: 'alpha' } } }, 'done');
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /@alpha.*wasn’t recorded.*disk full/);
});
