// A thread’s header frames on the page’s stream (app/js/client.mjs, #1264). A header frame is unnumbered and follows the
// event that changed it. When a page loads its state while a burst of events is still on its way, as a busy computer’s
// lagging stream sends them, the events arrive after the state that already has them: the page drops each as old by
// its seq, and must drop the header frame that follows it too. Applied, each old header would put back the thread as
// it was mid-burst: an ask gone and back, its agent’s “1 open choice” hidden and shown, thousands of times over.
//
// client.mjs runs in a vm context with its imports stripped and fakes, as tests/client-epoch.test.mjs runs it.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { PUBLIC_EVENT_TYPES, STREAM } from '../shared/state.mjs';

const NOW = { count: 3, lastAt: 3, speakers: ['researcher'], asks: [{ id: 'ask', type: 'choice', sessionId: 'se' }], blocks: {} };
const OLD = { count: 1, lastAt: 1, speakers: [], asks: [], blocks: {} };

/** client.mjs loaded with a state at seq 3 whose thread's header is NOW, its stream connected, and what it emits. */
async function loadedPage() {
  let source = await readFile(new URL('../app/js/client.mjs', import.meta.url), 'utf8');
  source = source.replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
  source += '\nglobalThis.apiUnderTest = { client, load, connect, headerOf };';
  const streams = [];
  const loads = { n: 0 };
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
    close() {}
  }
  const ctx = vm.createContext({
    EventSource,
    setTimeout() {},
    clearTimeout() {},
    encodeURIComponent,
    addEventListener() {},
    ownState: (s) => s,
    PUBLIC_EVENT_TYPES,
    STREAM,
    apply() {},
    gate: () => 'apply',
    needsYouNow() {},
    whereNeeds() {},
    fetch: async () => {
      loads.n++;
      return { ok: true, json: async () => ({ epoch: 'e', seq: 3, state: { items: {} }, config: {}, headers: { th: NOW } }) };
    },
  });
  vm.runInContext(source, ctx);
  const { client, load, connect, headerOf } = ctx.apiUnderTest;
  await load();
  connect();
  const heard = [];
  client.on((/** @type {any} */ ch) => ch.type === 'header' && heard.push(ch.data.header));
  const s = streams[0];
  /** An event frame with its seq, then the header frame that follows it. */
  const frame = (seq, header) => {
    s.handlers['item.add']({ lastEventId: String(seq), data: JSON.stringify({ threadId: 'th', item: { id: `it${seq}` } }) });
    s.handlers[STREAM.header]({ data: JSON.stringify({ threadId: 'th', header }) });
  };
  // Objects made in the vm context have its own prototypes: compared as JSON.
  const plain = (/** @type {any} */ x) => JSON.parse(JSON.stringify(x));
  /** A rejected event's place (a cursor with its seq), then the resync the server sends after it. */
  const rejected = async (seq) => {
    s.handlers[STREAM.cursor]({ lastEventId: String(seq), data: '{}' });
    await s.handlers[STREAM.resync]?.();
  };
  return { client, headerOf: (/** @type {string} */ id) => plain(headerOf(id)), heard: () => plain(heard), frame, rejected, loads, s };
}

test('#1264: header frames that follow events the page’s state already has don’t put back an old header', async () => {
  const { headerOf, heard, frame } = await loadedPage();
  frame(1, OLD);
  frame(2, { ...OLD, count: 2 });
  frame(3, NOW);
  assert.deepEqual(headerOf('th'), NOW, 'the header the state came with stays');
  assert.deepEqual(heard(), [], 'and nothing on the page repaints for them');
});

test('#1264: a header frame after an event the page applies still applies', async () => {
  const { headerOf, heard, frame } = await loadedPage();
  frame(2, OLD); // old: dropped
  const next = { ...NOW, count: 4, lastAt: 4 };
  frame(4, next);
  assert.deepEqual(headerOf('th'), next);
  assert.deepEqual(heard(), [next]);
});

test('#1264’s class: a resync after a rejected event the page’s state already has loads nothing', async () => {
  const { rejected, loads } = await loadedPage();
  await rejected(2);
  assert.equal(loads.n, 1, 'only the first load');
});

test('#1264’s class: a resync after a rejected event the page hasn’t had, or after an epoch change, loads the state again', async () => {
  const { rejected, loads, frame, s } = await loadedPage();
  await rejected(4);
  assert.equal(loads.n, 2, 'a new rejection reloads');
  frame(1, OLD); // an old frame, then the server’s epoch change: epoch, then resync, with no numbered frame between
  s.handlers[STREAM.epoch]({ data: JSON.stringify('e') });
  await s.handlers[STREAM.resync]();
  assert.equal(loads.n, 3, 'the old frame doesn’t swallow it');
});
