// Old turns' work and activity leave the in-memory state (#305; the design, "Old turns' work and activity leave the
// in-memory state"): a conversation keeps its last two turns' work entries and reply activity, and each older turn
// becomes a turn summary entry naming the archive file that holds the rest.

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';

const C = 'th_c';
const entry = (/** @type {string} */ turnId, /** @type {number} */ i, extra = {}) => ({
  id: `w_${turnId}_${i}`,
  turnId,
  kind: 'command',
  command: `npm test ${turnId}-${i}`,
  at: i,
  ...extra,
});
/** A state with three turns' work in one conversation, and a reply with activity for each turn. */
function threeTurns() {
  const s = emptyState();
  for (const [t, n] of [
    ['t1', 3],
    ['t2', 2],
    ['t3', 2],
  ])
    for (let i = 1; i <= n; i++) apply(s, 'work.add', { convId: C, entry: entry(t, i) });
  s.items[C] = ['t1', 't2', 't3'].map((t) => ({
    id: `r_${t}`,
    kind: 'agent',
    turnId: t,
    activity: { steps: [{ id: 's1', label: 'Read', detail: `${t} detail` }] },
  }));
  return s;
}
const summary = { kind: 'turn-archive', id: 'wa_t1', turnId: 't1', at: 1, sha256: 'a'.repeat(64), counts: { commands: 3, steps: 1 }, sessions: ['researcher'] };

test('T-10: a build that doesn’t know an event refuses to load a log holding it, and writes nothing', async () => {
  // Pinned on main before #305 relies on it for a downgrade: an older Postbox meeting turn.archive stops at start rather
  // than misreading the log. A type no build knows stands in for it here, so the test keeps holding after #305.
  const dir = await mkdtemp(join(tmpdir(), 'pb-305-'));
  try {
    const lines = [
      { seq: 1, type: 'thread', data: { id: C, members: [] } },
      { seq: 2, type: 'future.event', data: { convId: C } },
      { seq: 3, type: 'thread', data: { id: 'th_later', members: [] } },
    ];
    await writeFile(join(dir, 'events-1.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const before = await readFile(join(dir, 'events-1.jsonl'), 'utf8');
    await assert.rejects(new Store(dir).load(), /Unknown store event “future\.event”/);
    assert.equal(await readFile(join(dir, 'events-1.jsonl'), 'utf8'), before, 'the log is left as it was');
    assert.deepEqual((await readdir(dir)).sort(), ['events-1.jsonl'], 'no snapshot or other file is written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('turn.archive removes the turn’s entries and leaves its summary where they were, in turn order', () => {
  const s = threeTurns();
  apply(s, 'turn.archive', { convId: C, turnId: 't1', sha256: summary.sha256, summary, items: [{ threadId: C, id: 'r_t1' }] });
  assert.deepEqual(
    s.work[C].map((e) => e.id),
    ['wa_t1', 'w_t2_1', 'w_t2_2', 'w_t3_1', 'w_t3_2'],
  );
  assert.deepEqual(s.work[C][0], summary);
});

test('turn.archive replaces the activity of the turn’s replies with how many steps they had and where they are', () => {
  const s = threeTurns();
  apply(s, 'turn.archive', { convId: C, turnId: 't1', sha256: summary.sha256, summary, items: [{ threadId: C, id: 'r_t1' }] });
  assert.deepEqual(s.items[C][0].activity, { archived: summary.sha256, count: 1 }, 'count, not steps: an older page reads steps as a list');
  assert.equal(s.items[C][1].activity.steps.length, 1, 'other turns’ replies keep their steps');
});

test('turn.archive is idempotent: a turn already archived changes nothing', () => {
  const s = threeTurns();
  const data = { convId: C, turnId: 't1', sha256: summary.sha256, summary, items: [{ threadId: C, id: 'r_t1' }] };
  apply(s, 'turn.archive', data);
  const once = JSON.stringify(s);
  apply(s, 'turn.archive', data);
  assert.equal(JSON.stringify(s), once);
});
