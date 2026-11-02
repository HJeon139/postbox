import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { buildRecordBatch } from '../shared/record-batch.mjs';
import { askHeaders } from '../shared/record-selectors.mjs';
import { ask, change, close } from './records-fixture.mjs';
import { disk, handleWith } from './store-jsonl-fixture.mjs';
import { gate, holding } from './store-kill-fixture.mjs';

// Dormant reducer fixtures submit directly; production commitRecords remains disabled.
async function fixtureCommand(store, events) {
  let outcome;
  await store.commit((state) => {
    const batch = buildRecordBatch(state, events);
    outcome = batch.outcome;
    return batch.events;
  });
  return { outcome };
}

async function folder(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pb-records-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('record headers publish as one group after the sync, and stale outcome survives an empty commit', async (t) => {
  const dir = await folder(t),
    g = gate();
  let hold = false;
  const io = disk({
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      return /events-\d+\.jsonl$/.test(String(path))
        ? handleWith(handle, {
            sync: async () => {
              if (hold) await g.wait();
              await handle.sync();
            },
          })
        : handle;
    },
  });
  const store = await new Store(dir, { io }).load();
  t.after(() => store.close());
  hold = true;
  const pending = fixtureCommand(store, [change('open', ask()), change('open', ask('second'))]);
  await holding(g.hit, 'the record group to reach sync');
  assert.deepEqual(askHeaders(store.state), []);
  g.go();
  assert.deepEqual(await pending, { outcome: 'applied' });
  assert.equal(askHeaders(store.state).length, 2);
  const seq = store.state.seq;
  assert.deepEqual(await fixtureCommand(store, [close(ask(), 'answered', { previousVersion: 0 })]), { outcome: 'stale' });
  assert.equal(store.state.seq, seq);
});

test('a command queued before close resolves and replays, while one submitted after the boundary is refused', async (t) => {
  const dir = await folder(t);
  const a = await new Store(dir).load();
  const accepted = fixtureCommand(a, [change('open', ask())]);
  const closing = a.close();
  await assert.rejects(fixtureCommand(a, [change('open', ask('late'))]), /closed/i);
  assert.deepEqual(await accepted, { outcome: 'applied' });
  await closing;
  const b = await new Store(dir).load();
  t.after(() => b.close());
  assert.deepEqual(Object.keys(b.state.records), [ask().id]);
});

test('seeded valid live operations recover the same records and headers from log and snapshot', async (t) => {
  const dir = await folder(t),
    seed = 508;
  let rng = seed,
    nextId = 0;
  const a = await new Store(dir).load();
  for (let n = 0; n < 120; n++) {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    const entries = Object.values(a.state.records);
    const r = entries[rng % Math.max(1, entries.length)];
    const event =
      !r || rng % 3 === 0
        ? change('open', ask(`ask_${nextId++}`))
        : rng % 3 === 1
          ? change('revise', { ...r, version: r.version + 1, rev: r.rev + 1, title: `edit ${n}` })
          : close(r);
    await fixtureCommand(a, [event]);
  }
  const expected = JSON.stringify({ records: a.state.records, headers: askHeaders(a.state) });
  await a.close();
  const b = await new Store(dir).load();
  assert.equal(JSON.stringify({ records: b.state.records, headers: askHeaders(b.state) }), expected, `log recovery seed ${seed}`);
  await b.snapshot();
  await b.close();
  const c = await new Store(dir).load();
  t.after(() => c.close());
  assert.equal(JSON.stringify({ records: c.state.records, headers: askHeaders(c.state) }), expected, `snapshot recovery seed ${seed}`);
});

test('tightening only new-command admission does not reinterpret accepted schema-1 history', async (t) => {
  const dir = await folder(t),
    old = ask('legacy', { title: 'An accepted older presentation' });
  const a = await new Store(dir).load();
  await fixtureCommand(a, [change('open', old)]);
  await a.close();
  const stricterAdmission = (record) => {
    if (record.title.length > 8) throw new Error('New-command title policy');
  };
  assert.throws(() => stricterAdmission(old), /New-command title policy/);
  const b = await new Store(dir).load();
  t.after(() => b.close());
  assert.equal(b.state.records[old.id].title, old.title);
});

test('a snapshot preserves an edited source and its separate immutable dispatch revision', async (t) => {
  const { delivery, reserved } = await import('./records-fixture.mjs');
  const { dispatchManifest } = await import('../shared/record-selectors.mjs');
  const dir = await folder(t),
    d = delivery('pinned'),
    sent = reserved(d);
  const a = await new Store(dir).load();
  await fixtureCommand(a, [change('open', d), change('reserve', sent)]);
  await fixtureCommand(a, [change('revise', { ...sent, version: 3, rev: 2, parts: [{ text: 'Latest source' }] })]);
  const pinned = dispatchManifest(a.state, sent.dispatchId);
  await a.snapshot();
  await a.close();
  const b = await new Store(dir).load();
  t.after(() => b.close());
  assert.equal(b.state.records[d.id].parts[0].text, 'Latest source');
  assert.deepEqual(dispatchManifest(b.state, sent.dispatchId), pinned);
  assert.equal(pinned.entries[0].parts[0].text, 'Original message');
});

test('partially settled manifests recover the original replay bytes through a snapshot', async (t) => {
  const { delivery, reserved } = await import('./records-fixture.mjs');
  const { attemptIdentity } = await import('../shared/record-events.mjs');
  const { dispatchManifest } = await import('../shared/record-selectors.mjs');
  const dir = await folder(t),
    a = delivery('first'),
    b = delivery('second');
  const sa = reserved(a),
    sb = reserved(b, { dispatchId: sa.dispatchId });
  const store = await new Store(dir).load();
  await fixtureCommand(store, [change('open', a), change('open', b), change('reserve', sa), change('reserve', sb)]);
  const before = dispatchManifest(store.state, sa.dispatchId);
  await fixtureCommand(store, [close(sa, 'delivered', { attemptIdentity: attemptIdentity(sa) })]);
  await store.snapshot();
  await store.close();
  const recovered = await new Store(dir).load();
  t.after(() => recovered.close());
  assert.deepEqual(dispatchManifest(recovered.state, sa.dispatchId), before);
  await fixtureCommand(recovered, [change('open', ask('unrelated'))]);
  await fixtureCommand(recovered, [close(sb, 'delivered', { attemptIdentity: attemptIdentity(sb) })]);
  assert.equal(dispatchManifest(recovered.state, sa.dispatchId), null);
});
