// Every event the shared reducer applies is one the page listens for (#305: the page never heard turn.archive, so its
// seq stopped and it waited for an event it couldn't hear). The browser's EventSource drops a name nobody registered,
// so a reducer type missing from the client's list is a silent stall, not an error.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** The types the shared reducer handles: its switch cases and the `type === '…'` tests of its helpers. */
function reducerTypes() {
  const files = ['shared/state.mjs', 'shared/state-hosts.mjs', 'shared/state-archive.mjs'].map(read).join('\n');
  const types = new Set();
  for (const m of files.matchAll(/case '([a-z.]+)':/g)) types.add(m[1]);
  for (const m of files.matchAll(/type [!=]== '([a-z.]+)'/g)) types.add(m[1]);
  return types;
}

/** The names app/js/client.mjs registers on the stream. */
function clientTypes() {
  const src = read('app/js/client.mjs');
  const list = src.slice(src.indexOf('const EVENT_TYPES = ['), src.indexOf('];', src.indexOf('const EVENT_TYPES = [')));
  return new Set([...list.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]));
}

/**
 * The events the page can receive. Once A1a's classification exists (`shared/record-private.mjs`), that is its public
 * list, since private events reach the page only as a `cursor`; until then, every type the reducer applies.
 */
// TODO: Remove the compatibility branch when A1a lands and use its public event list.
async function pageTypes() {
  if (!existsSync(new URL('../shared/record-private.mjs', import.meta.url))) return reducerTypes();
  const { PUBLIC_EVENT_TYPES } = await import('../shared/record-private.mjs');
  return new Set([...PUBLIC_EVENT_TYPES, 'cursor']);
}

test('the page listens for every event type it can receive', async () => {
  const missing = [...(await pageTypes())].filter((t) => !clientTypes().has(t));
  assert.deepEqual(missing, [], 'add these to EVENT_TYPES in app/js/client.mjs');
});
