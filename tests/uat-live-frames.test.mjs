// The UAT runner keeps every live frame its stream receives (tools/uat/history.mjs): a running turn’s progress isn’t
// stored between commit points (designs/architecture/live-progress.md), so the #722 scan of what reached the browser
// reads the frames beside the events, in the run and in a --recheck from its saved files.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { liveSession, liveStep } from '../server/live-buffer.mjs';
import { liveStreams } from '../server/live-streams.mjs';
import { Store } from '../server/store.mjs';
import { followEvents, readHistory, readLive, writeHistory } from '../tools/uat/history.mjs';

test('the runner’s stream keeps the live frames, which writeHistory saves and a recheck reads back', async () => {
  const store = await new Store(null).load();
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'tool' });
  const live = liveStreams(store);
  // The runner’s stream, through fetch, answered by the streams as /api/stream would be.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = new TransformStream();
    const writer = body.writable.getWriter();
    const enc = new TextEncoder();
    const write = (/** @type {string} */ s) => {
      void writer.write(enc.encode(s));
      return true;
    };
    const res = { writeHead() {}, write, destroy() {}, once() {} };
    live.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), new URL(String(url)));
    return /** @type {any} */ ({ body: body.readable });
  };
  const dir = await mkdtemp(join(tmpdir(), 'pb-uat-live-'));
  const history = followEvents('http://127.0.0.1:1');
  try {
    await new Promise((r) => setTimeout(r, 20));
    const turn = { id: 'tu_1', sessionId: 'se_1', threadId: 'th_1', first: 'it_1' };
    const rt = { store, sessions: { update() {} } };
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'done', output: 'the file’s text' });
    liveSession(rt, turn, { glimpse: 'Reading it' });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      history.live().map((f) => f.kind),
      ['step', 'session'],
    );
    assert.equal(history.live()[0].step.output, 'the file’s text');
    await writeHistory(dir, { events: history.events(), live: history.live() });
    assert.deepEqual(readLive(dir), history.live());
    assert.deepEqual(readHistory(dir), history.events());
  } finally {
    history.close();
    globalThis.fetch = realFetch;
    live.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run from before the live frames were kept reads none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-uat-live-'));
  try {
    assert.deepEqual(readLive(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
