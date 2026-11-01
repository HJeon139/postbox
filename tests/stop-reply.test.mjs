// Stop always leaves the turn’s reply saying it was stopped (#120 pipeline spec, remote-pipeline.test.mjs:216, which
// failed one run in three on main). The cause: stop() marked only a reply segment still streaming, and added a stopped
// reply only when the turn had none at all. A card that closes the segment mid-turn (a permission card, a refusal
// card) marks it done first, so a Stop while the card waits marked nothing, and the reply read as done. The rule now:
// if Stop marked no segment of the turn, it adds the stopped reply below whatever closed the last one.

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { disk, handleWith } from './store-jsonl-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folders = [];
after(() => Promise.all(folders.map((f) => rm(f, { recursive: true, force: true }))));

/** A Claude Code agent whose turn the test scripts; each step waits for Stop once it has done its part. */
class Scripted {
  name = 'claude-code';
  constructor(folder) {
    this.folder = folder;
    this.next = null;
  }
  async folderFor() {
    return this.folder;
  }
  async deliver(_session, _message, ctx) {
    await this.next(ctx);
    if (!ctx.signal.aborted) await new Promise((r) => ctx.signal.addEventListener('abort', r, { once: true }));
  }
}

async function setup(step, store = new Store(null)) {
  const folder = await mkdtemp(join(tmpdir(), 'pb-stop-reply-'));
  folders.push(folder);
  const adapter = new Scripted(folder);
  adapter.next = step;
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: folder },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'researcher', backend: 'claude-code', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  return { store, rt, t, se };
}
/** Waits for a condition, never a fixed time. @param {() => boolean} pred @param {string} what */
const until = async (pred, what) => {
  for (let i = 0; i < 400 && !pred(); i++) await sleep(5);
  assert.ok(pred(), `waited for ${what}`);
};
const replies = (store, t, se) => store.items(t.id).filter((i) => i.kind === 'agent' && i.sessionId === se.id);

/** Runs `step` as the turn, waits for `ready`, presses Stop, and returns the turn’s reply items. */
async function stopAfter(step, ready, what) {
  const env = await setup(step);
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => ready(env), what);
  assert.equal(env.rt.stop(env.se.id), true);
  await until(() => !env.rt.turns.size, 'the turn to end');
  return replies(env.store, env.t, env.se);
}
const cardOpen = (kind) => (env) => env.store.items(env.t.id).some((i) => i.kind === kind);

test('Stop while a permission card waits, after the reply has said something: the reply says it was stopped', async () => {
  const items = await stopAfter(
    async (c) => {
      c.text('Running the tests.');
      await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'npm test' } });
    },
    cardOpen('permission'),
    'the permission card',
  );
  assert.ok(
    items.some((i) => i.status === 'stopped'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
  assert.equal(items.find((i) => i.text === 'Running the tests.')?.status, 'done', 'what it said above the card stays as it was');
});

test('Stop while a permission card waits, before the reply has any text (the integration case): the reply says it was stopped', async () => {
  const items = await stopAfter(
    async (c) => {
      c.activity({ tool: 'Bash', input: { command: 'npm test' } }); // the tool’s step opens an empty segment
      await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'npm test' } });
    },
    cardOpen('permission'),
    'the permission card',
  );
  assert.ok(
    items.some((i) => i.status === 'stopped'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
});

test('Stop after a refusal card closed the segment: the reply says it was stopped', async () => {
  const items = await stopAfter(
    async (c) => {
      c.text('Trying the tests.');
      c.denied({ toolUseId: 'tu-1', tool: 'Bash', input: { command: 'npm test' }, label: 'Run the tests', reason: '[x]', reasonType: 'classifier' });
    },
    cardOpen('denial'),
    'the refusal card',
  );
  assert.ok(
    items.some((i) => i.status === 'stopped'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
});

test('neighbors: Stop with a segment still streaming marks that one, once; Stop before any reply adds one, once', async () => {
  const streaming = await stopAfter(
    async (c) => c.text('Halfway'),
    (env) => replies(env.store, env.t, env.se).some((i) => i.text === 'Halfway'),
    'the streaming text',
  );
  assert.deepEqual(
    streaming.map((i) => [i.status, i.text]),
    [['stopped', 'Halfway']],
    'the streaming segment is the stopped reply; nothing is added',
  );
  const silent = await stopAfter(
    async () => {},
    (env) => env.rt.turns.size === 1,
    'the turn to start',
  );
  assert.deepEqual(
    silent.map((i) => i.status),
    ['stopped'],
    'a turn that said nothing gets one stopped reply',
  );
});

test('the other callers of stop(): a shutdown while a permission card waits leaves the reply saying it was stopped', async () => {
  const env = await setup(async (c) => {
    c.text('Running the tests.');
    await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'npm test' } });
  });
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => cardOpen('permission')(env), 'the permission card');
  await env.rt.stopTurns({ graceMs: 200 }); // what Postbox’s own shutdown calls, with by: 'shutdown'
  const items = replies(env.store, env.t, env.se);
  assert.ok(
    items.some((i) => i.status === 'stopped'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
});

/** A Store on disk whose log sync can be held, so an emit made meanwhile is held behind the commit, unseen by items(). */
async function heldStore() {
  const dir = await mkdtemp(join(tmpdir(), 'pb-stop-held-'));
  folders.push(dir);
  let hold = false;
  let release = () => {};
  let reached = () => {};
  const atSync = new Promise((r) => {
    reached = () => r(undefined);
  });
  const io = disk({
    open: async (path, ...args) => {
      const fh = await fs.open(path, ...args);
      if (!/events-\d+\.jsonl$/.test(String(path))) return fh;
      return handleWith(fh, {
        sync: async () => {
          if (hold) {
            hold = false;
            reached();
            await new Promise((r) => {
              release = () => r(undefined);
            });
          }
          return fh.sync();
        },
      });
    },
  });
  const store = await new Store(dir, { io }).load();
  return { store, hold: () => (hold = true), atSync, release: () => release() };
}

/** gpt’s peer read: the reply segment is emitted while a commit is held, so store.items() can’t see it when Stop scans. */
test('Stop while the reply segment is held behind a commit marks that segment stopped: nothing is left streaming', async () => {
  const h = await heldStore();
  let go = () => {};
  const proceed = new Promise((r) => {
    go = () => r(undefined);
  });
  const env = await setup(async (c) => {
    await proceed;
    c.text('Held reply');
  }, h.store);
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => env.rt.turns.size === 1, 'the turn to start');
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync; // the commit is in flight: emits from now on are held behind it
  go();
  await until(() => !!env.rt.turns.get(env.se.id)?.segment, 'the held reply segment');
  assert.equal(env.rt.stop(env.se.id), true);
  h.release();
  await commit;
  await h.store.flush();
  const items = replies(h.store, env.t, env.se);
  assert.deepEqual(
    items.map((i) => [i.status, i.text]),
    [['stopped', 'Held reply']],
    'the held segment is the stopped reply',
  );
  await h.store.close();
});

test('a turn that ends while its reply segment is held behind a commit marks it done: nothing is left streaming', async () => {
  const h = await heldStore();
  let go = () => {};
  const proceed = new Promise((r) => {
    go = () => r(undefined);
  });
  let finish = () => {};
  const done = new Promise((r) => {
    finish = () => r(undefined);
  });
  const env = await setup(async (c) => {
    await proceed;
    c.text('Held reply');
    await done;
  }, h.store);
  // This step ends on its own: deliver’s wait for Stop is skipped once the turn is finished.
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => env.rt.turns.size === 1, 'the turn to start');
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  go();
  await until(() => !!env.rt.turns.get(env.se.id)?.segment, 'the held reply segment');
  finish();
  env.rt.turns.get(env.se.id).abort.abort(); // ends deliver’s wait without Stop’s own marking
  await until(() => !env.rt.turns.size, 'the turn to end');
  h.release();
  await commit;
  await h.store.flush();
  const items = replies(h.store, env.t, env.se);
  assert.ok(
    items.every((i) => i.status !== 'streaming'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
  await h.store.close();
});
