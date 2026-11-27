// How a hosted Postbox fetches a load balancer’s key (server/identity/alb-key-fetch.mjs): what an answer may cost is
// bounded. `fetch` is a fake here, answering with real Response objects, so no test reaches the network.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchKeyText } from '../server/identity/alb-key-fetch.mjs';

const URL_ = 'https://public-keys.auth.elb.us-west-2.amazonaws.com/12345678-1234-1234-1234-123456789012';
const PEM = '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n';

test('a 200 answers with its text, asked for with no redirect followed and a time limit', async () => {
  /** @type {any[]} */
  const asked = [];
  const ask = async (/** @type {any} */ url, /** @type {any} */ init) => {
    asked.push([url, init.redirect, init.signal instanceof AbortSignal]);
    return new Response(PEM);
  };
  assert.equal(await fetchKeyText(URL_, { ask }), PEM);
  assert.deepEqual(asked, [[URL_, 'error', true]]);
});

test('any answer but 200 is no key, whatever its body says', async () => {
  for (const status of [204, 403, 404, 500])
    await assert.rejects(fetchKeyText(URL_, { ask: async () => new Response(status === 204 ? null : PEM, { status }) }), new RegExp(`answered ${status}`));
});

test('an answer longer than a key is refused once it passes the bound, without reading the rest', async () => {
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  await assert.rejects(fetchKeyText(URL_, { mostBytes: 2048, ask: async () => new Response(body) }), /more than 2048 bytes/);
  assert.ok(pulled < 10, `read ${pulled} chunks of an endless answer`);
});

test('an endpoint that doesn’t answer in time is given up on', async () => {
  const ask = (/** @type {any} */ _url, /** @type {any} */ init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  // The deadline’s own timer doesn’t keep a process alive, and here nothing else would: this one does, until it fires.
  const alive = setTimeout(() => {}, 10_000);
  try {
    await assert.rejects(fetchKeyText(URL_, { timeoutMs: 5, ask: /** @type {any} */ (ask) }), { name: 'TimeoutError' });
  } finally {
    clearTimeout(alive);
  }
});
