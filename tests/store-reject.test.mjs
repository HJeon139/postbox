// Retry on a batch Redis refused for good (server/store-reject.mjs): what it writes for each event it saves is the state
// after that event and the ones before it, never a later one’s, so the documents and the stream agree at every point
// Redis commits (gpt’s r4 review of #553). The salvage is one write, after probes that commit nothing, so a connection
// lost anywhere in it leaves Redis either untouched or holding every saved event.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retry } from '../server/store-recover.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { admin, consistent, open, poison, raw, tmp, until } from './store-fixture.mjs';

/**
 * A store with a refused batch queued: 2 adds item x with text one, 3 is the poison (a project Redis won’t hold), 4
 * patches x to text two. Returns the store and its connection, poisoned, with the log quiet until `done()`.
 */
async function queued() {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const { error } = console;
  console.error = () => {};
  const client = poison(s, 'project:bad');
  s.emit('item.add', { threadId: 't', item: { id: 'x', kind: 'user', text: 'one', at: 1 } }); // 2
  s.emit('project', { id: 'bad', name: 'poison' }); // 3
  s.emit('item.patch', { threadId: 't', id: 'x', patch: { text: 'two' } }); // 4
  await s.flush();
  assert.equal(s.writable, false);
  assert.equal(s.lines.length, 3);
  return { s, client, done: () => (console.error = error) };
}

/**
 * Watches every EVAL the store’s connection runs: for each that moved `seq`, the item documents it set are compared
 * with the state its events, after the ones committed before, replay to. Returns the committing EVALs’ event seqs and
 * the documents that didn’t match.
 * @param {any} client @param {any} base  the state Redis holds now
 */
function audited(client, base) {
  const call = client.call;
  const replay = base;
  /** @type {number[][]} */ const commits = [];
  /** @type {string[]} */ const mismatches = [];
  client.call = async (...a) => {
    const r = await call(...a);
    if (a[0] !== 'EVAL') return r;
    const seq = Number(await call('GET', 'seq'));
    if (seq === replay.seq) return r; // nothing committed: a probe, or a refusal
    const n = Number(a[5]);
    const events = [];
    for (let k = 0; k < n; k++) events.push(JSON.parse(a[8 + 2 * k]));
    for (const ev of events) {
      apply(replay, ev.type, ev.data);
      replay.seq = ev.seq;
    }
    assert.equal(replay.seq, seq, 'seq is the last event the write carried');
    for (let i = 7 + 2 * n; i < a.length; i++) {
      if (a[i] !== 'S' || !String(a[i + 1]).startsWith('item:')) continue;
      const { d, t } = JSON.parse(a[i + 2]);
      const inReplay = replay.items[t]?.find((it) => it.id === d.id);
      if (JSON.stringify(d) !== JSON.stringify(inReplay))
        mismatches.push(
          `${a[i + 1]} written with events ${events.map((e) => e.seq)} as ${JSON.stringify(d)}, which those events leave as ${JSON.stringify(inReplay)}`,
        );
    }
    commits.push(events.map((e) => e.seq));
    return r;
  };
  return { commits, mismatches };
}

test('Retry writes each saved event with the documents as that event leaves them, not as later queued events do', async () => {
  const { s, client, done } = await queued();
  const base = emptyState();
  apply(base, 'thread', { id: 't', members: [] });
  base.seq = 1;
  const { commits, mismatches } = audited(client, base);
  try {
    await retry(s);
  } finally {
    done();
  }
  assert.deepEqual(mismatches, [], 'every document a write set is the item as that write’s events leave it, not as a later queued event does');
  assert.equal(s.writable, true);
  assert.deepEqual(commits.flat(), [2, 4], 'the events Redis took were committed, in order');
  assert.deepEqual(/** @type {any} */ (s.status).dropped.changes, ['3: project bad']);
  const c = await raw(s);
  assert.deepEqual(
    (await c.call('XRANGE', 'events', '-', '+')).map(([id]) => id),
    ['1-0', '2-0', '4-0'],
  );
  assert.equal(JSON.parse(await c.call('JSON.GET', 'item:x', '$'))[0].d.text, 'two');
  c.close();
  const { fresh } = await consistent(s);
  assert.deepEqual(s.state, fresh.state, 'memory is what Redis holds');
});

test('a connection lost during Retry leaves Redis holding what the committed stream replays to', async () => {
  const { s, client, done } = await queued();
  // The connection closes before the EVAL after the first one that committed anything: a crash between salvage writes, if
  // the salvage has more than one.
  const call = client.call;
  let committed = false;
  let evals = 0;
  client.call = async (...a) => {
    if (a[0] === 'EVAL' && committed) throw Object.assign(new Error('The connection to the store’s Redis closed before it answered.'), { code: 'ESTOREDOWN' });
    const r = await call(...a);
    if (a[0] === 'EVAL') {
      evals++;
      if (Number(await call('GET', 'seq')) > 1) committed = true;
    }
    return r;
  };
  try {
    await retry(s);
  } finally {
    done();
  }
  assert.ok(evals >= 1 && committed, 'Retry committed something before the connection closed');
  const c = await raw(s);
  const seq = Number(await c.call('GET', 'seq'));
  const stream = (await c.call('XRANGE', 'events', '-', '+')).map(([, f]) => JSON.parse(f[1]));
  assert.equal(stream.at(-1)?.seq, seq, 'seq is the stream’s last entry');
  const replay = emptyState();
  for (const ev of stream) {
    apply(replay, ev.type, ev.data);
    replay.seq = ev.seq;
  }
  const x = JSON.parse(await c.call('JSON.GET', 'item:x', '$'))?.[0]?.d;
  assert.deepEqual(
    x,
    replay.items.t?.find((it) => it.id === 'x'),
    'the document is what the stream replays to, whatever was committed before the loss',
  );
  assert.equal(await c.call('JSON.GET', 'project:bad', '$'), null, 'the refused document is nowhere');
  c.close();
  await consistent(s);
});

test('Retry’s probes commit nothing: the connection lost before its write leaves Redis as it was and the batch queued', async () => {
  const { s, client, done } = await queued();
  const call = client.call;
  client.call = async (...a) => {
    // The write that commits carries the events; a probe doesn’t.
    if (a[0] === 'EVAL' && Number(a[5]) > 0)
      throw Object.assign(new Error('The connection to the store’s Redis closed before it answered.'), { code: 'ESTOREDOWN' });
    return call(...a);
  };
  try {
    await retry(s);
  } finally {
    done();
  }
  assert.equal(s.writable, false, 'the store stays closed: the batch wasn’t saved');
  assert.equal(s.lines.length, 3, 'the whole batch is queued again, in order');
  assert.deepEqual(
    s.lines.map((l) => l.seq),
    [2, 3, 4],
  );
  const c = await admin(s);
  assert.equal(await c.call('GET', 'seq'), '1', 'nothing committed');
  assert.deepEqual(await c.call('KEYS', 'stage:*'), [], 'no staging key is left behind');
  c.close();
});

/**
 * Loses the reply to Retry’s one committing EVAL (the one that carries events) on a store’s connection: with `landed`,
 * after Redis ran it, so Redis holds what it wrote and only the reply is gone; without, before it reached Redis.
 * Returns a flag that says whether the loss happened, and counts the committing EVALs after it.
 * @param {any} client @param {boolean} landed
 */
function loseCommit(client, landed) {
  const call = client.call;
  const lost = { happened: false, writesAfter: 0 };
  client.call = async (...a) => {
    const committing = a[0] === 'EVAL' && Number(a[5]) > 0;
    if (lost.happened && committing) lost.writesAfter++;
    if (lost.happened || !committing) return call(...a);
    lost.happened = true;
    if (landed) await call(...a);
    throw Object.assign(new Error('The connection to the store’s Redis closed before it answered.'), { code: 'ESTOREDOWN' });
  };
  return lost;
}

test('Retry recovers a repair whose single commit succeeded but its reply was lost (gpt’s r4 review)', async () => {
  const { s, client, done } = await queued();
  const lost = loseCommit(client, true);
  try {
    await retry(s);
    assert.equal(lost.happened, true, 'the committing write’s reply was lost');
    // The connection that lost the reply drops, as it does for real; the store reconnects and reads Redis back.
    client.ondrop();
    await until(() => !s.reconciling, 'the store to finish reading Redis back', s);
  } finally {
    done();
  }
  const c = await raw(s);
  try {
    assert.equal(await c.call('GET', 'seq'), '4', 'Redis holds the accepted events');
    assert.deepEqual(
      (await c.call('XRANGE', 'events', '-', '+')).map(([id]) => id),
      ['1-0', '2-0', '4-0'],
    );
  } finally {
    c.close();
  }
  assert.equal(s.writable, true, `recovery stayed closed: ${s.failed?.code}: ${s.failed?.message}`);
  assert.equal(s.failed, null);
  assert.equal(s.rejected, null, 'nothing is refused any more');
  assert.equal(s.lines.length, 0, 'nothing is queued: the stream holds what Redis took, and what it refused is gone');
  assert.equal(s.state.projects.bad, undefined, 'the refused project is removed from memory');
  assert.equal(s.state.items.t[0].text, 'two');
  assert.deepEqual(/** @type {any} */ (s.status).dropped.changes, ['3: project bad'], 'the status reports what was dropped');
  const { fresh } = await consistent(s);
  assert.deepEqual(s.state, fresh.state, 'memory is what Redis holds');
});

test('a repair whose commit never reached Redis, its reply lost, leaves the batch queued and refused; Retry runs again', async () => {
  const { s, client, done } = await queued();
  const lost = loseCommit(client, false);
  try {
    await retry(s);
    assert.equal(lost.happened, true, 'the committing write was lost before Redis ran it');
    client.ondrop();
    await until(() => !s.reconciling, 'the store to finish reading Redis back', s);
    const c = await raw(s);
    try {
      assert.equal(await c.call('GET', 'seq'), '1', 'nothing committed');
      assert.equal(await c.call('HLEN', 'ops').catch(() => '0'), '0', 'no repair is recorded');
    } finally {
      c.close();
    }
    assert.equal(s.writable, false, 'the store stays closed: the batch wasn’t saved');
    assert.equal(s.failed?.code, 'EREJECTED', `the store is still refused, not ${s.failed?.code}: ${s.failed?.message}`);
    assert.deepEqual(
      s.lines.map((l) => l.seq),
      [2, 3, 4],
      'the whole batch is queued again, in order',
    );
    assert.equal(s.state.projects.bad?.name, 'poison', 'memory still shows the change, as before Retry');
    assert.equal(lost.writesAfter, 0, 'reading Redis back wrote nothing: a refused batch waits for Retry');
    // Retry again, with the connection whole: the repair runs as it would have.
    await retry(s);
    assert.equal(lost.writesAfter, 1, 'Retry wrote the batch once');
  } finally {
    done();
  }
  assert.equal(s.writable, true, `Retry didn’t repair the store: ${s.failed?.code}: ${s.failed?.message}`);
  assert.deepEqual(/** @type {any} */ (s.status).dropped.changes, ['3: project bad']);
  assert.equal(s.state.projects.bad, undefined);
  assert.equal(s.state.items.t[0].text, 'two');
  const { fresh } = await consistent(s);
  assert.deepEqual(s.state, fresh.state, 'memory is what Redis holds');
});
