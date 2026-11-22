// A UAT runner’s own reads of its Postbox give up after a limit (tools/uat/postbox.mjs, readJson), so a request
// Postbox takes and never answers unwinds the runner into its cleanup instead of holding it, even while the run’s
// watch keeps getting answers (#1621). A wait the runner chose sleeps between reads that each answer, so it finishes.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { postboxReader, readJson } from '../../tools/uat/postbox.mjs';
import { settle } from '../../tools/uat/turns.mjs';

/** A Postbox stand-in: /api/state hangs once `stall` is set, and every other path answers at once. */
async function standIn() {
  const held = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/state' && server.stall) return void held.push(res);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ state: { threads: {}, sessions: {}, apps: {} } }));
  });
  server.stall = false;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    for (const res of held) res.destroy();
    server.close();
  };
  return { server, origin, close };
}

test('a read Postbox takes and never answers gives up after its limit, saying so', { timeout: 10_000 }, async () => {
  const { server, origin, close } = await standIn();
  try {
    server.stall = true;
    const started = Date.now();
    await assert.rejects(readJson(origin, '/api/state', 200), /Postbox didn’t answer GET \/api\/state within 0.2 s\./);
    assert.ok(Date.now() - started < 2000, 'and it gave up near its limit');
    server.stall = false;
    assert.deepEqual(await readJson(origin, '/api/state', 200), { state: { threads: {}, sessions: {}, apps: {} } });
  } finally {
    close();
  }
});

test('the runner’s wait unwinds when its read stalls, while the watch keeps getting answers beside it', { timeout: 10_000 }, async () => {
  const { server, origin, close } = await standIn();
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let watch;
  try {
    server.stall = true;
    // The run’s watch, answered throughout: as critic’s probe had it, 277 answered polls while the runner waited.
    let answered = 0;
    watch = setInterval(() => void readJson(origin, '/api/health', 1000).then(() => (answered += 1)), 5);
    // The runner’s reader, as startPostbox builds it.
    const api = postboxReader({ origin, exited: null }, 200);
    const facts = { samples: [] };
    const d = { working: async () => [], stopAll: async () => {} };
    const waiting = settle({ api, d, threadsUnderTest: () => [], facts, midTurnChecks: async () => {}, opt: { 'turn-timeout': '900' } });
    await assert.rejects(waiting, /didn’t answer GET \/api\/state/, 'settle() rejects, so the runner reaches its finally and its stop');
    assert.ok(answered > 0, `the watch was answered ${answered} times meanwhile`);
  } finally {
    clearInterval(watch);
    close();
  }
});
