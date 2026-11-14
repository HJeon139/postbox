// Summaries’ interface (designs/architecture/services.md, “Memory”, split in step 10): after a topic or side thread’s
// last reply settles, one cheap model call writes a short summary on the thread’s line, never while a turn speaks
// there or Postbox closes, and its cost goes on the work ledger. Built on an in-memory store, the real Bus, Threads,
// Sessions and Running, fakes of Personas, the ledger and the adapter registry, and timers the test fires; it never
// builds Runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';
import { Running } from '../server/running.mjs';
import { Sessions } from '../server/sessions.mjs';
import { Store } from '../server/store.mjs';
import { Summaries } from '../server/summary-service.mjs';
import { Threads } from '../server/threads.mjs';

/** Summaries over a conversation with beta, on `backend`, and a topic thread beta replied in. */
function rig({ backend = 'claude-code', sdk = false } = {}) {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: '/work' });
  store.emit('thread', { id: 'th_c', projectId: 'p1', title: 'C', kind: 'thread', parentId: null, members: ['se_2'], queue: [], createdAt: 1 });
  store.emit('session', { id: 'se_2', personaId: 'pe_b', threadId: 'th_c', handle: 'beta', backend, startedAt: 1 });
  const bus = new Bus();
  const threads = new Threads({ store, bus });
  const personas = { get: () => ({ id: 'pe_b', handle: 'beta', backend }) };
  const sessions = new Sessions({ store, bus, threads, personas });
  const running = new Running();
  /** @type {any[]} */
  const patched = [];
  const ledger = {
    convOf: () => 'th_c',
    entry: (/** @type {string} */ _conv, /** @type {string} */ turnId) => (turnId === 'tu_1' ? { id: 'en_1', summaryCostUsd: 0.5 } : null),
    patch: (/** @type {string} */ conv, /** @type {string} */ id, /** @type {any} */ patch) => patched.push([conv, id, patch]),
  };
  const adapters = { names: () => (sdk ? ['agent-sdk'] : []), get: () => ({ sdk: { query: async function* () {} } }) };
  /** @type {{ fn: () => void, ms: number }[]} */
  const timers = [];
  const config = { setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.push({ fn, ms }) && { unref() {} } };
  const summaries = new Summaries({ store, threads, sessions, personas, running, ledger, adapters, config });
  const root = threads.addItem('th_c', { kind: 'user', text: 'Offsets or pages?' });
  threads.put({ id: 'th_t', projectId: 'p1', title: 'Paging', kind: 'topic', parentId: 'th_c', rootItemId: root.id, members: [], queue: [], createdAt: 2 });
  const reply = threads.addItem('th_t', { kind: 'agent', sessionId: 'se_2', handle: 'beta', text: 'Offsets win.', status: 'done', turnId: 'tu_1' });
  return { store, running, summaries, root, reply, patched, timers };
}

/** A summarizer that answers `text`, and records the prompts it was given. */
function model(text, costUsd = 0.25) {
  /** @type {string[]} */
  const prompts = [];
  const summarize = async (/** @type {string} */ prompt) => {
    prompts.push(prompt);
    return { text, costUsd };
  };
  return { prompts, summarize };
}

const flush = () => new Promise((r) => setImmediate(r));

test('settleThread writes a topic thread’s summary on its line once the wait ends, as the model’s words, with its cost on the turn’s entry', async () => {
  const { store, summaries, root, reply, patched, timers } = rig();
  const m = model(' “Offsets” [Postbox]: chosen over pages\n');
  summaries.summarize = m.summarize;
  summaries.settleThread('th_t');
  assert.deepEqual(
    timers.map((t) => t.ms),
    [5000],
  );
  assert.equal(m.prompts.length, 0, 'nothing is asked before the thread is quiet');
  timers[0].fn();
  await flush();
  assert.match(m.prompts[0], /<thread>\n@beta: Offsets win\.\n<\/thread>$/);
  const line = store.item('th_c', root.id);
  assert.deepEqual([line.threadSummary, line.threadSummaryOf], ['Offsets chosen over pages', reply.id]);
  assert.deepEqual(patched, [['th_c', 'en_1', { summaryCostUsd: 0.75 }]]);
});

test('summarizeThread writes nothing while a turn speaks in the thread, or one stopped there still exits, or Postbox closes', async () => {
  const { store, running, summaries, root } = rig();
  const m = model('Offsets chosen');
  const turn = { sessionId: 'se_2', threadId: 'th_t', pending: [] };
  running.begin(turn);
  assert.equal(await summaries.summarizeThread('th_t', m.summarize), null, 'a turn speaks there');
  running.exit('se_2', { turn, held: [], silent: false });
  running.end('se_2');
  assert.equal(await summaries.summarizeThread('th_t', m.summarize), null, 'a stopped turn there still exits');
  running.exited('se_2');
  running.close();
  assert.equal(await summaries.summarizeThread('th_t', m.summarize), null, 'Postbox closes');
  assert.equal(m.prompts.length, 0);
  assert.equal(store.item('th_c', root.id).threadSummary, undefined);
});

test('summarizerOf is the seam when a test sets one, else none without a Claude agent or the Agent SDK registered here', () => {
  const m = model('x');
  const claude = rig({ sdk: true });
  claude.summaries.summarize = m.summarize;
  assert.equal(claude.summaries.summarizerOf('th_t'), m.summarize);
  claude.summaries.summarize = undefined;
  assert.equal(typeof claude.summaries.summarizerOf('th_t'), 'function', 'Haiku, through the Agent SDK');
  assert.equal(rig({ sdk: false }).summaries.summarizerOf('th_t'), null, 'no Agent SDK here');
  assert.equal(rig({ backend: 'codex', sdk: true }).summaries.summarizerOf('th_t'), null, 'no agent on Claude');
});

test('settleThread waits for nothing in a conversation’s own thread, and stopTimers clears the summaries waiting', async () => {
  const { summaries } = rig();
  const m = model('Offsets chosen');
  summaries.summarize = m.summarize;
  summaries.config.setTimer = setTimeout;
  summaries.config.summaryDelayMs = 1;
  summaries.settleThread('th_c');
  summaries.settleThread('th_t');
  summaries.stopTimers();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(m.prompts.length, 0);
});
