// A page still reading /api/state mustn’t hold the state as a string on the V8 heap (#1210). The body is one JSON string
// as long as the whole state, and a string with any character past Latin-1 takes two bytes a character. Handed to
// res.end as that string, it stays on the heap until the page has read every byte: at 28,000 items each such page held
// 425 MB of heap, and a few slow or frozen tabs, with the snapshot’s own string, ran Postbox out of its 4 GB.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, afterEach, before, test } from 'node:test';
import { assertNoServerFailures, captureServerLog } from './server-log.mjs';
import { tempDir } from './temp-dirs.mjs';

// Its Postbox runs in this process: a test fails on an error or a warning it logs (tests/server-log.mjs).
captureServerLog();
afterEach(assertNoServerFailures);

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4461;
let app;
before(async () => {
  const dir = tempDir('pb-unread-body-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  app.store.emit('thread', { id: 't1', title: 'A room’s title, with a curly quote', members: [] });
  await app.store.flush();
});
after(async () => {
  await app.close();
});

test('#1210 /api/state goes to the socket as bytes, not as a string the heap keeps while the page reads', async () => {
  const req = /** @type {any} */ (Readable.from([]));
  Object.assign(req, { method: 'GET', url: '/api/state', headers: { host: `127.0.0.1:${PORT}` }, socket: { remoteAddress: '127.0.0.1' } });
  const body = await new Promise((resolve) => {
    const res = { headersSent: false, writeHead() {}, write() {}, end: resolve, destroy() {} };
    app.handle(req, res);
  });
  assert.ok(Buffer.isBuffer(body), `the body is a ${typeof body}`);
  assert.equal(JSON.parse(body.toString('utf8')).state.threads.t1.title, 'A room’s title, with a curly quote');
});
