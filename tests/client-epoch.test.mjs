// The page’s history epoch (app/js/client.mjs; gpt’s r10 review of #553, blocker 2). The page’s epoch is only ever the
// one that came with a state it loaded (/api/state): a stream frame naming another epoch makes it load the state again,
// and until that load succeeds the page keeps naming its old epoch, so the server resyncs it (server/live-streams.mjs)
// rather than taking a page still showing old history as synchronized with the replacement.
//
// client.mjs runs in a browser; here it runs in a vm context with its imports stripped and fakes for fetch, EventSource
// and the page’s events, so the test sees the URL each stream connects with.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { liveStreams } from '../server/live-streams.mjs';

/** A snapshot /api/state would give, on an epoch, its one item naming the epoch. @param {string} epoch */
const snapshot = (epoch) => ({ epoch, seq: 4, state: { items: { room: [{ text: epoch }] } }, config: {} });

/** The frames the server sends a stream connecting with this URL, when the store runs on `epoch` at seq 4. @param {string} url @param {string} epoch */
async function framesFor(url, epoch) {
  const store = /** @type {any} */ ({
    epoch,
    state: { seq: 4 },
    status: { state: 'running' },
    watchers: new Set(),
    reloads: new Set(),
    subscribe() {},
    backlog: async () => [],
    since: () => [],
  });
  const live = liveStreams(store);
  const frames = [];
  const req = /** @type {any} */ (Object.assign(new EventEmitter(), { headers: {} }));
  try {
    await live.stream(req, /** @type {any} */ ({ writeHead() {}, write: (line) => frames.push(line) }), new URL(url, 'http://localhost'));
  } finally {
    live.stop();
  }
  return frames.join('');
}

/** client.mjs loaded into a vm context with fakes; `fetch` answers /api/state with `answer()` each time. */
async function pageWith(answer) {
  let source = await readFile(new URL('../app/js/client.mjs', import.meta.url), 'utf8');
  source = source.replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
  source += '\nglobalThis.apiUnderTest = { client, load, connect };';
  const streams = [];
  const events = {};
  const timers = [];
  class EventSource {
    static CLOSED = 2;
    handlers = {};
    constructor(url) {
      this.url = url;
      streams.push(this);
    }
    addEventListener(name, fn) {
      this.handlers[name] = fn;
    }
    close() {
      this.readyState = 2;
    }
  }
  const ctx = vm.createContext({
    EventSource,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout() {},
    encodeURIComponent,
    addEventListener: (name, fn) => {
      events[name] = fn;
    },
    ownState: (s) => s,
    apply() {},
    needsYouNow() {},
    whereNeeds() {},
    fetch: async () => answer(),
  });
  vm.runInContext(source, ctx);
  return { ...ctx.apiUnderTest, streams, events, timers };
}

test('a failed replacement snapshot cannot make reconnect accept stale state as current', async () => {
  let release;
  const pending = new Promise((r) => {
    release = r;
  });
  let reads = 0;
  const { client, load, connect, streams, events } = await pageWith(async () => (++reads === 1 ? { ok: true, json: async () => snapshot('old') } : pending));
  await load();
  connect();
  // The store ran a repair’s reload meanwhile: the stream’s first frame names the new epoch, then says resync.
  streams[0].handlers.epoch({ data: JSON.stringify('new') });
  const reloading = Promise.resolve(streams[0].handlers.resync()).catch((e) => e);
  release({ ok: false }); // and /api/state fails
  await reloading;
  events.pagehide({});
  events.pageshow({ persisted: true });
  assert.equal(client.state.items.room[0].text, 'old', 'the page still shows the old state');
  assert.equal(client.epoch, 'old', 'so it keeps naming the epoch that state came with');
  const frames = await framesFor(streams[1].url, 'new');
  assert.ok(frames.includes('event: resync'), `a page still showing old history is resynced, not accepted: ${streams[1].url} got ${frames}`);
});

test('a stream frame naming another epoch makes the page load the state again, once, and the new epoch comes with that state', async () => {
  let reads = 0;
  const { client, load, connect, streams } = await pageWith(async () => ({ ok: true, json: async () => snapshot(++reads === 1 ? 'old' : 'new') }));
  await load();
  connect();
  streams[0].handlers.epoch({ data: JSON.stringify('new') });
  await streams[0].handlers.resync(); // the server says resync right after the epoch frame: one load, not two
  assert.equal(reads, 2, 'one load for the epoch frame and the resync together');
  assert.equal(client.epoch, 'new');
  assert.equal(client.state.items.room[0].text, 'new');
  assert.equal(streams.length, 2, 'and one new stream');
  assert.equal(new URL(streams[1].url, 'http://x').searchParams.get('epoch'), 'new');
  streams[1].handlers.epoch({ data: JSON.stringify('new') });
  await Promise.resolve();
  assert.equal(reads, 2, 'a frame naming the epoch the page has loads nothing');
});

test('while the load after a resync fails, the page connects again naming its old epoch, until a load succeeds', async () => {
  let reads = 0;
  const { client, load, connect, streams, timers } = await pageWith(async () => ({
    ok: reads++ === 0 || reads > 2,
    json: async () => snapshot(reads === 1 ? 'old' : 'new'),
  }));
  await load();
  connect();
  await streams[0].handlers.resync(); // the load fails (read 2)
  assert.equal(client.epoch, 'old');
  assert.equal(streams.length, 1, 'no stream names an epoch the page hasn’t loaded');
  assert.equal(timers.length, 1, 'a retry is scheduled');
  timers[0].fn();
  assert.equal(new URL(streams[1].url, 'http://x').searchParams.get('epoch'), 'old', 'the retry connects naming the old epoch, which the server resyncs');
  await streams[1].handlers.resync(); // this load succeeds (read 3)
  assert.equal(client.epoch, 'new');
  assert.equal(client.state.items.room[0].text, 'new');
});
