// Readers the first sweep missed (the integrator's review of #611 at b22dd351), each failing on that head: a reader
// that follows a pending read in the same operation, an app the turn just showed, a side thread's line counted right
// after its own add, and a store listener's pending read during a release. The same scripted agent and held store as
// tests/store-held-readers.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from '../server/store.mjs';
import { heldStore, setup, until } from './stop-reply-fixture.mjs';

/** A room whose turn runs `step` once a commit is held in its fsync; resolves with the step's results and a release. */
async function turnWhileHeld(step) {
  const h = await heldStore();
  const results = {};
  let go = () => {};
  const proceed = new Promise((r) => {
    go = () => r(undefined);
  });
  const env = await setup(async (c) => {
    await proceed;
    await step(c, results);
    results.done = true;
  }, h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => env.rt.turns.size === 1, 'the turn to start');
  go();
  await until(() => results.done === true, 'the turn’s calls');
  const release = async () => {
    env.rt.stop(env.se.id);
    h.release();
    await commit;
    await h.store.flush();
  };
  return { ...env, store: h.store, results, release, close: () => h.store.close() };
}

test('update_block on an asking block the turn showed while a commit is held: the update lands, not only its receipt (blocker 1)', async () => {
  const env = await turnWhileHeld(async (c, r) => {
    const block = { id: 'pick', type: 'choice', version: 1, fallback: 'Pick one', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] };
    r.shown = await c.tools.show_block({ block });
    c.text('Between the block and its update.'); // the block is no longer the newest item, so the update moves it
    r.updated = await c.tools.update_block({ block: { ...block, prompt: 'Which now?' } });
  });
  assert.equal(env.results.updated?.ok, true);
  await env.release();
  const item = env.store.items(env.t.id).find((i) => i.kind === 'block' && i.block?.id === 'pick');
  assert.equal(item?.block.prompt, 'Which now?', 'the update reached the block');
  await env.close();
});

test('show_app, update_app, show_app again and retire_app in one turn while a commit is held: no throw, one app, its versions (blocker 2)', async () => {
  const code = (n) => `<!doctype html><html><body><p>v${n}</p></body></html>`;
  const env = await turnWhileHeld(async (c, r) => {
    const call = async (name, args) => {
      try {
        return await c.tools[name](args);
      } catch (e) {
        return { threw: e instanceof Error ? e.message : String(e) };
      }
    };
    r.shown = await call('show_app', { id: 'lab', title: 'Lab', code: code(1) });
    r.update = await call('update_app', { id: 'lab', code: code(2) });
    r.again = await call('show_app', { id: 'lab', title: 'Lab', code: code(3) });
    r.retire = await call('retire_app', { id: 'lab', reason: 'Replaced by the next one.' });
  });
  const { shown, update, again, retire } = env.results;
  assert.deepEqual(
    [shown, update, again, retire].map((x) => x?.threw ?? null),
    [null, null, null, null],
    JSON.stringify(env.results),
  );
  assert.deepEqual([update?.ok, again?.ok, retire?.ok], [true, true, true], JSON.stringify(env.results));
  await env.release();
  const items = env.store.items(env.t.id).filter((i) => i.kind === 'block' && i.block?.type === 'app');
  assert.equal(items.length, 1, 'one app item, not a duplicate from the second show_app');
  const app = env.store.state.apps.lab;
  assert.equal(app?.versions.length, 3);
  assert.ok(app?.retired, 'retired');
  await env.close();
});

test('a side thread’s line counts a message added there while a commit is held (should-fix 3, bumpSideLink)', async () => {
  const h = await heldStore();
  const env = await setup(async () => {}, h.store);
  const side = env.rt.putThread({
    id: newId('th'),
    projectId: env.t.projectId,
    title: 'Side',
    kind: 'side',
    parentId: env.t.id,
    members: [],
    lastSpeaker: null,
    hops: 0,
    queue: [],
    createdAt: Date.now(),
    archived: false,
  });
  env.rt.addItem(env.t.id, { kind: 'sidelink', sideThreadId: side.id, from: 'you', to: 'researcher', count: 0 });
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  env.rt.addItem(side.id, { kind: 'user', text: 'A question in the side thread' });
  h.release();
  await commit;
  await h.store.flush();
  const link = h.store.items(env.t.id).find((i) => i.kind === 'sidelink');
  assert.equal(link?.count, 1);
  await h.store.close();
});

test('a store listener’s pending read during a release sees the released item once (should-fix 4)', async () => {
  const h = await heldStore();
  const { store } = h;
  await store.flush();
  h.hold();
  const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  store.emit('item.add', { threadId: 't1', item: { id: 'r', kind: 'agent', text: 'Held' } });
  store.emit('item.add', { threadId: 't1', item: { id: 's', kind: 'agent', text: 'Held too' } }); // keeps something held
  const seen = [];
  const off = store.subscribe((ev) => {
    if (ev.type === 'item.add' && ev.data.item.id === 'r') seen.push(store.pending.items('t1').filter((i) => i.id === 'r').length);
  });
  h.release();
  await commit;
  await store.flush();
  off();
  assert.deepEqual(seen, [1]);
  await store.close();
});
