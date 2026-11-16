// A store written before the person’s message became an entry (#1404) can hold messages in a thread’s `queue`. On
// start they’re turned into entries once (#1423): the person’s message is posted as its item with a `person` entry per
// agent, and an agent’s queued wake becomes a `mention` entry for its item. Each reaches its agent once, with nothing
// lost and nothing posted twice, across a second restart too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { ScriptedAdapter, settle, setup } from './side-threads-fixture.mjs';
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
  rt.drainAll();
  await settle(rt);
  return { store, rt, adapter };
}

const texts = (adapter, se) => adapter.calls.filter((c) => c.sessionId === se.id).flatMap((c) => (c.message.messages ?? [c.message]).map((m) => m.text));

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
  rt.convertQueues();
  arrange.setThread(rt, f.t.id, { queue });
  await store.close();
  const again = await restart(f.dir, f.rt.config);
  assert.equal(again.store.items(f.t.id).filter((i) => i.text === '@beta from before').length, 1);
  assert.deepEqual(texts(again.adapter, f.beta), ['@beta from before', '@beta which editions?']);
  await again.store.close();
});
