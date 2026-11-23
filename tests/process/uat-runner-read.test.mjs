// A UAT runner’s own reads of its Postbox give up after a limit (tools/uat/postbox.mjs, readJson), so a request
// Postbox takes and never answers unwinds the runner into its cleanup instead of holding it, even while the run’s
// watch keeps getting answers (#1621). A wait the runner chose sleeps between reads that each answer, so it finishes.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../../server/store.mjs';
import { postboxReader, readJson, startPostbox } from '../../tools/uat/postbox.mjs';
import { settle } from '../../tools/uat/turns.mjs';
import { tempDir } from '../temp-dirs.mjs';

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
    assert.ok(Date.now() - started < 5000, 'and it gave up near its limit, not at the test’s own limit');
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
  /** @type {Promise<unknown>[]} */
  const reads = [];
  try {
    server.stall = true;
    // The run’s watch, answered throughout: as critic’s probe had it, 277 answered polls while the runner waited.
    let answered = 0;
    // Each read is kept and settles quietly, so none is left to reject after the test, once the server has closed.
    watch = setInterval(() => {
      reads.push(
        readJson(origin, '/api/health', 1000).then(
          () => (answered += 1),
          () => {},
        ),
      );
    }, 5);
    // The runner’s reader, as startPostbox builds it.
    const api = postboxReader({ origin, exited: null }, 200);
    const facts = { samples: [] };
    const d = { working: async () => [], stopAll: async () => {} };
    const waiting = settle({ api, d, threadsUnderTest: () => [], facts, midTurnChecks: async () => {}, opt: { 'turn-timeout': '900' } });
    await assert.rejects(waiting, /didn’t answer GET \/api\/state/, 'settle() rejects, so the runner reaches its finally and its stop');
    assert.ok(answered > 0, `the watch was answered ${answered} times meanwhile`);
  } finally {
    clearInterval(watch);
    await Promise.all(reads);
    close();
  }
});

test('the watch’s read of the state asks for no items, and the checks’ read asks for every thread’s (#1621)', { timeout: 10_000 }, async () => {
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.startsWith('/api/threads/') ? { items: [] } : { state: { threads: { t1: {}, t2: {} }, sessions: {} } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await postboxReader({ origin, exited: null }, 1000, { items: false })('/api/state');
    assert.deepEqual(asked, ['/api/state'], 'the watch’s read: the state alone');
    asked.length = 0;
    await postboxReader({ origin, exited: null }, 1000)('/api/state');
    assert.deepEqual(
      asked.sort(),
      ['/api/state', '/api/threads/t1/items?limit=all', '/api/threads/t2/items?limit=all'],
      'the checks’ read: with each thread’s items',
    );
  } finally {
    server.close();
  }
});

test('a real Postbox’s watchApi reads the state without its items, and its api with them (#1638)', { timeout: 60_000 }, async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  probe.close();
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const data = tempDir('pb-watch-api-');
  const postbox = await startPostbox({ root, port, data, env: { POSTBOX_BACKENDS: 'mock' }, log: () => {} });
  try {
    // A conversation with one item, written while Postbox is down, so the two reads can differ.
    await postbox.restart({
      whileDown: async () => {
        const store = await new Store(data).load();
        store.emit('thread', { id: 'th_w', kind: 'room', title: 'Watched', members: ['se_w'] });
        store.emit('session', { id: 'se_w', threadId: 'th_w', handle: 'researcher', personaId: 'pe_w' });
        store.emit('item.add', { threadId: 'th_w', item: { id: 'it_w', kind: 'user', text: 'Hello.', at: 1 } });
        await store.close();
      },
    });
    const watched = (await postbox.watchApi('/api/state')).state;
    assert.ok(watched.threads?.th_w, 'the state, with its conversation');
    assert.equal(watched.items?.th_w, undefined, 'the watch’s read has none of its items: it never asked for them');
    assert.deepEqual(
      (await postbox.api('/api/state')).state.items.th_w.map((/** @type {any} */ it) => it.id),
      ['it_w'],
      'the checks’ read has them',
    );
  } finally {
    await postbox.kill();
  }
});
