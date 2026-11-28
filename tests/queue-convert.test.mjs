// A store written before the person’s message became an entry (#1404) can hold messages in a thread’s `queue`. On
// start they’re turned into entries once (#1423): the person’s message is posted as its item with a `person` entry per
// agent, and an agent’s queued wake becomes a `mention` entry for its item. Each reaches its agent once, with nothing
// lost and nothing posted twice, across a second restart too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { convertQueues } from '../server/queue-convert.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { held, ScriptedAdapter, settle, setup, sleep } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A room on a store in a folder, with what waited for @beta in the thread’s queue as Postbox wrote it before #1404. */
async function storeWithQueue() {
  const dir = tempDir('pb-queue-');
  const f = setup(await new Store(dir).load());
  const said = arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.alpha.id, handle: 'alpha', text: '@beta which editions?', status: 'done' });
  const at = Date.now();
  arrange.setThread(f.rt, f.t.id, {
    queue: [
      { id: 'q_person', text: '@beta from before', attachments: [], sessionIds: [f.beta.id], at, seq: 1 },
      { id: 'q_wake', kind: 'wake', from: 'alpha', fromSessionId: f.alpha.id, text: said.text, itemId: said.id, sessionIds: [f.beta.id], at: at + 1, seq: 2 },
    ],
  });
  await f.store.close();
  return { ...f, dir, said };
}

/** Postbox starting on the store in `dir`, as index.mjs does, with an adapter of its own; settled. */
async function restart(dir, config) {
  const store = await new Store(dir).load();
  const adapter = new ScriptedAdapter();
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(adapter), config });
  adapter.rt = rt;
  rt.drainAll();
  await settle(rt);
  return { store, rt, adapter };
}

const texts = (adapter, se) => adapter.calls.filter((c) => c.sessionId === se.id).flatMap((c) => c.parts.map((m) => m.text));

test('#1423 a queue stored before the change becomes entries on start: each message reaches its agent once', async () => {
  const f = await storeWithQueue();
  const first = await restart(f.dir, f.rt.config);
  assert.deepEqual(first.store.state.threads[f.t.id].queue ?? [], [], 'the queue is empty');
  const mine = first.store.items(f.t.id).filter((i) => i.kind === 'user' && i.text === '@beta from before');
  assert.equal(mine.length, 1, 'the person’s message is posted once');
  assert.deepEqual(mine[0].to, ['beta']);
  assert.deepEqual(texts(first.adapter, f.beta), ['@beta from before', '@beta which editions?'], 'both reach @beta, in the order they waited');
  await first.store.close();
  const second = await restart(f.dir, f.rt.config);
  assert.equal(second.store.items(f.t.id).filter((i) => i.text === '@beta from before').length, 1, 'a second start posts nothing');
  assert.deepEqual(texts(second.adapter, f.beta), [], 'and gives @beta nothing again');
  await second.store.close();
});

test('#1423 a conversion cut short by a crash posts nothing twice when it runs again', async () => {
  const f = await storeWithQueue();
  const store = await new Store(f.dir).load();
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(new ScriptedAdapter()), config: f.rt.config });
  // The person’s message was converted, and Postbox stopped before the queue was written back.
  const queue = store.state.threads[f.t.id].queue;
  convertQueues(rt);
  arrange.setThread(rt, f.t.id, { queue });
  await store.close();
  const again = await restart(f.dir, f.rt.config);
  assert.equal(again.store.items(f.t.id).filter((i) => i.text === '@beta from before').length, 1);
  assert.deepEqual(texts(again.adapter, f.beta), ['@beta from before', '@beta which editions?']);
  await again.store.close();
});

/** A store whose thread’s queue holds `rows`, as Postbox wrote it before #1404. @param {(f: any) => any[]} rows */
async function storeWith(rows) {
  const dir = tempDir('pb-queue-');
  const f = setup(await new Store(dir).load());
  arrange.setThread(f.rt, f.t.id, { queue: rows(f) });
  await f.store.close();
  return { ...f, dir };
}

for (const crashAfter of [0, 1])
  test(`#1423 a conversion torn after ${crashAfter} of a message’s entries posts it once, and every agent gets it`, async () => {
    // The reviewer’s repro (#1424): the item posted, then Postbox stopped before every entry was written.
    const f = await storeWith((f) => [
      { id: 'q_both', text: '@alpha @beta both', attachments: [], sessionIds: [f.alpha.id, f.beta.id], at: Date.now(), seq: 1 },
    ]);
    const store = await new Store(f.dir).load();
    const rt = new Runtime({ store, adapters: new AdapterRegistry().register(new ScriptedAdapter()), config: f.rt.config });
    const send = rt.delivery.send.bind(rt.delivery);
    let n = 0;
    rt.delivery.send = (...a) => {
      if (n++ >= crashAfter) throw new Error('Postbox stopped here');
      return send(...a);
    };
    assert.throws(() => convertQueues(rt), /Postbox stopped here/);
    await store.close();
    const again = await restart(f.dir, f.rt.config);
    assert.equal(again.store.items(f.t.id).filter((i) => i.text === '@alpha @beta both').length, 1, 'posted once');
    assert.deepEqual(texts(again.adapter, f.alpha), ['@alpha @beta both']);
    assert.deepEqual(texts(again.adapter, f.beta), ['@alpha @beta both']);
    await again.store.close();
  });

test('#1423 converted entries keep the time each message waited from', async () => {
  const before = Date.now() - 60_000;
  const f = await storeWith((f) => [{ id: 'q_old', text: '@beta an old one', attachments: [], sessionIds: [f.beta.id], at: before, seq: 1 }]);
  const store = await new Store(f.dir).load();
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(new ScriptedAdapter()), config: f.rt.config });
  convertQueues(rt);
  assert.equal(rt.delivery.inbox(f.beta.id).find((e) => e.retryId === 'q_old')?.at, before);
  await store.close();
});

test('#1423 a wake for an agent that has left tells its sender it wasn’t delivered', async () => {
  const f = await storeWith((f) => [
    { id: 'q_gone', kind: 'wake', from: 'alpha', fromSessionId: f.alpha.id, text: 'Which editions?', sessionIds: ['se_gone'], at: Date.now(), seq: 1 },
  ]);
  const again = await restart(f.dir, f.rt.config);
  const notes = again.rt.delivery.waiting(f.alpha.id).filter((e) => e.source === 'notice');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^Your message \(“Which editions\?”\) wasn’t delivered: the agent it was for was removed\./);
  await again.store.close();
});

test('#1423 a held message of the person’s with no item, at shutdown, reaches its agent after the restart', async () => {
  const dir = tempDir('pb-queue-');
  const f = setup(await new Store(dir).load());
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  f.rt.stop(f.beta.id, { by: 'you' });
  f.rt.turnService.run(f.beta.id, { kind: 'user', text: 'a message with no item', attachments: [] });
  const closing = f.rt.stopTurns({ graceMs: 200 });
  busy.release();
  await closing;
  await f.store.close();
  const again = await restart(dir, f.rt.config);
  assert.deepEqual(texts(again.adapter, f.beta), ['a message with no item']);
  await again.store.close();
});
