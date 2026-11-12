// A route answers with a body: send() in server/index.mjs refuses to answer with nothing. Since #1210 it sends bytes,
// and Buffer.from(JSON.stringify(undefined)) threw a TypeError after the status was written, so the page got an empty
// 200 and the CLI printed a bare stack that named neither the route nor its runtime call (v4.0.7’s Send now on a
// queued wake, #1247). Now it’s a 500 that says what happened, logged as a programming error with the route.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { format } from 'node:util';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4463;
let app;
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
before(async () => {
  const dir = tempDir('pb-empty-answer-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
});
after(async () => {
  await app.close();
});

/** What console.error printed while fn ran, each call formatted as the console writes it. */
async function logged(fn) {
  const lines = [];
  const error = console.error;
  console.error = (...args) => lines.push(format(...args));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = error;
  }
}

test('a route whose runtime call answers with nothing gets a 500 that names the route, not an empty 200', async () => {
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  const sendQueuedNow = app.rt.sendQueuedNow;
  app.rt.sendQueuedNow = () => undefined;
  try {
    const { result: r, lines } = await logged(() => call({ method: 'POST', path: '/api/threads/th_1/queue/q_1/send', body: {}, cookie }));
    assert.equal(r.status, 500);
    assert.match(r.json?.error ?? '', /sent no answer/);
    assert.equal(lines.length, 1, 'one line in the log');
    assert.match(lines[0], /POST \/api\/threads\/th_1\/queue\/q_1\/send/, 'the log names the route');
    assert.match(lines[0], /answered with nothing/, 'and says what went wrong');
    assert.doesNotMatch(lines[0], /ERR_INVALID_ARG_TYPE/, 'not Buffer’s TypeError');
  } finally {
    app.rt.sendQueuedNow = sendQueuedNow;
  }
});

test('a path with %s in it is logged as it was asked for, and the error’s stack still follows it', async () => {
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  const sendQueuedNow = app.rt.sendQueuedNow;
  app.rt.sendQueuedNow = () => undefined;
  try {
    const { lines } = await logged(() => call({ method: 'POST', path: '/api/threads/%s/queue/%s/send', body: {}, cookie }));
    assert.equal(lines.length, 1, 'one line in the log');
    assert.match(lines[0], /POST \/api\/threads\/%s\/queue\/%s\/send:/, 'the path as asked for');
    assert.match(lines[0], /answered with nothing[^\n]*\n\s+at /, 'and the error with its stack');
  } finally {
    app.rt.sendQueuedNow = sendQueuedNow;
  }
});
