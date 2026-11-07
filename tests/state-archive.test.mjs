// The turn.archive reducer (#305; designs/305-archive-turns.md, “What the reducer does”): an archived turn’s listed work
// entries give way to its summary entry, in a new array, and its replies keep only how many steps they had. Nothing
// emits the event yet; these pin its shape before the pass is built on it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, emptyState } from '../shared/state.mjs';
import { applyTurnArchive } from '../shared/state-archive.mjs';
import { ledgerIndex } from '../shared/work-index.mjs';

const C = 'th_c';
const TOPIC = 'th_topic';
const SHA = 'a'.repeat(64);

const command = (turnId, n, extra = {}) => ({ id: `w_${turnId}_${n}`, turnId, kind: 'command', command: `npm test ${turnId}-${n}`, at: n, ...extra });
const steps = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: 'Read', detail: `step ${i}` }));

/**
 * A conversation with two turns: t1 ran two commands and pushed (a hot kind the pass doesn’t list), t2 ran one. Each turn
 * has a reply with activity; t1 has a second reply in a topic thread, as a turn in one writes there.
 */
function twoTurns() {
  const s = emptyState();
  s.threads[C] = { id: C, members: [] };
  s.threads[TOPIC] = { id: TOPIC, parentId: C, members: [] };
  for (const entry of [command('t1', 1), { id: 'w_t1_push', turnId: 't1', kind: 'push', at: 2 }, command('t1', 3), command('t2', 4)]) {
    apply(s, 'work.add', { convId: C, entry });
  }
  apply(s, 'item.add', { threadId: C, item: { id: 'r_t1', kind: 'agent', turnId: 't1', activity: { steps: steps(3) } } });
  apply(s, 'item.add', { threadId: C, item: { id: 'r_t2', kind: 'agent', turnId: 't2', activity: { steps: steps(1) } } });
  apply(s, 'item.add', { threadId: TOPIC, item: { id: 'r_t1_topic', kind: 'agent', turnId: 't1', activity: { steps: steps(2) } } });
  return s;
}

const summaryOf = (turnId, entryIds, at = 1) => ({
  id: `wa_${turnId}`,
  kind: 'turn-archive',
  turnId,
  at,
  sha256: SHA,
  entryIds,
  counts: { commands: entryIds.length, steps: 3 },
  effort: { turns: 1, costUsd: 0.02 },
  handles: ['dev'],
});

/** t1’s event: its two commands move, its push stays hot, and both its replies are archived. */
const archiveT1 = () => ({
  convId: C,
  turnId: 't1',
  sha256: SHA,
  summary: summaryOf('t1', ['w_t1_1', 'w_t1_3']),
  items: [
    { threadId: C, id: 'r_t1' },
    { threadId: TOPIC, id: 'r_t1_topic' },
  ],
});

test('the listed entries leave the work list and the summary takes the first one’s place', () => {
  const s = twoTurns();
  const d = archiveT1();
  applyTurnArchive(s, d);
  assert.deepEqual(
    s.work[C].map((e) => e.id),
    ['wa_t1', 'w_t1_push', 'w_t2_4'],
  );
  assert.deepEqual(s.work[C][0], d.summary, 'the summary entry is the one the event describes');
  assert.notEqual(s.work[C][0], d.summary, 'built from its fields, not the object the event carries');
});

test('an entry of the turn the summary doesn’t list stays where it was, as the hot kinds do', () => {
  const s = twoTurns();
  applyTurnArchive(s, archiveT1());
  assert.deepEqual(s.work[C][1], { id: 'w_t1_push', turnId: 't1', kind: 'push', at: 2 });
});

test('a second turn.archive for the same turn changes nothing in the work list', () => {
  const s = twoTurns();
  applyTurnArchive(s, archiveT1());
  const once = s.work[C];
  const copy = structuredClone(once);
  // A repeat after a snapshot, carrying the same turn with its entries listed again.
  applyTurnArchive(s, { ...archiveT1(), summary: summaryOf('t1', ['w_t1_push', 'w_t2_4']) });
  assert.equal(s.work[C], once, 'the array isn’t replaced');
  assert.deepEqual(s.work[C], copy);
});

test('the work list is a new array, not the old one changed', () => {
  const s = twoTurns();
  const before = s.work[C];
  applyTurnArchive(s, archiveT1());
  assert.notEqual(s.work[C], before);
});

test('each named reply, in the conversation and in a topic thread, keeps only its archive and step count', () => {
  const s = twoTurns();
  applyTurnArchive(s, archiveT1());
  assert.deepEqual(s.items[C][0].activity, { archived: SHA, count: 3 });
  assert.deepEqual(s.items[TOPIC][0].activity, { archived: SHA, count: 2 });
  assert.deepEqual(s.items[C][1].activity, { steps: steps(1) }, 'the hot turn’s reply keeps its steps');
});

test('a reply already archived keeps the archive it names', () => {
  const s = twoTurns();
  applyTurnArchive(s, archiveT1());
  const again = archiveT1();
  applyTurnArchive(s, { ...again, sha256: 'b'.repeat(64), summary: { ...again.summary, sha256: 'b'.repeat(64) } });
  assert.deepEqual(s.items[C][0].activity, { archived: SHA, count: 3 });
});

test('a malformed payload throws a plain Error and leaves the state as it was', () => {
  const good = archiveT1();
  const malformed = [
    undefined,
    null,
    { ...good, convId: 7 },
    { ...good, turnId: undefined },
    { ...good, sha256: null },
    { ...good, summary: undefined },
    { ...good, summary: { ...good.summary, kind: 'command' } },
    { ...good, summary: { ...good.summary, entryIds: 'w_t1_1' } },
    { ...good, summary: { ...good.summary, turnId: 't_other' } },
    { ...good, summary: { ...good.summary, id: undefined } },
    { ...good, summary: { ...good.summary, at: 'soon' } },
    { ...good, summary: { ...good.summary, entryIds: ['w_t1_1', 7, null] } },
    { ...good, sha256: '../etc/passwd' },
    { ...good, sha256: 'A'.repeat(64), summary: { ...good.summary, sha256: 'A'.repeat(64) } },
    { ...good, summary: { ...good.summary, sha256: 'b'.repeat(64) } },
    { ...good, items: undefined },
    { ...good, items: [{ threadId: C }] },
    { ...good, items: [{ threadId: C, id: 'r_t1' }, null] },
  ];
  for (const d of malformed) {
    const s = twoTurns();
    const before = JSON.stringify(s);
    assert.throws(
      () => applyTurnArchive(s, d),
      (e) => e instanceof Error && e.constructor === Error && /turn\.archive/.test(e.message),
      JSON.stringify(d),
    );
    assert.equal(JSON.stringify(s), before, JSON.stringify(d));
  }
});

test('the reducer applies turn.archive through the event table', () => {
  const s = twoTurns();
  apply(s, 'turn.archive', archiveT1());
  assert.equal(s.work[C][0].id, 'wa_t1');
});

test('missing pieces are skipped: an entry id, a thread or a reply that isn’t there', () => {
  const s = twoTurns();
  const d = archiveT1();
  d.summary.entryIds = ['w_t1_1', 'w_gone', 'w_t1_3'];
  d.items.push({ threadId: 'th_gone', id: 'r_x' }, { threadId: C, id: 'r_gone' });
  assert.doesNotThrow(() => applyTurnArchive(s, d));
  assert.deepEqual(
    s.work[C].map((e) => e.id),
    ['wa_t1', 'w_t1_push', 'w_t2_4'],
  );
  assert.deepEqual(s.items[C][0].activity, { archived: SHA, count: 3 });
});

test('a fresh work index finds the summary by id and by turn, and no moved entry', () => {
  const s = twoTurns();
  ledgerIndex(s.work[C]); // the old array’s index, as a reader built it before the event
  applyTurnArchive(s, archiveT1());
  const ix = ledgerIndex(s.work[C]);
  assert.equal(ix.byId.get('wa_t1')?.kind, 'turn-archive');
  assert.deepEqual(
    ix.byTurn.get('t1')?.map((e) => e.id),
    ['wa_t1', 'w_t1_push'],
  );
  assert.equal(ix.byId.has('w_t1_1'), false);
  assert.equal(ix.byId.has('w_t1_3'), false);
});

test('the work index finds a one-entry turn’s summary, where the list’s length doesn’t change', () => {
  // An in-place change of the same length is the one the index can’t see: it rebuilds only when the list shrinks.
  const s = twoTurns();
  ledgerIndex(s.work[C]);
  applyTurnArchive(s, { convId: C, turnId: 't2', sha256: SHA, summary: summaryOf('t2', ['w_t2_4'], 4), items: [] });
  const ix = ledgerIndex(s.work[C]);
  assert.equal(ix.byId.get('wa_t2')?.kind, 'turn-archive');
  assert.equal(ix.byId.has('w_t2_4'), false);
  assert.deepEqual(
    ix.byTurn.get('t2')?.map((e) => e.id),
    ['wa_t2'],
  );
});

test('a reply-only turn’s summary goes into the work list in time order by at, not at the end', () => {
  const s = twoTurns();
  const d = { convId: C, turnId: 't_reply', sha256: SHA, summary: summaryOf('t_reply', [], 3.5), items: [{ threadId: C, id: 'r_t2' }] };
  applyTurnArchive(s, d);
  assert.deepEqual(
    s.work[C].map((e) => e.id),
    ['w_t1_1', 'w_t1_push', 'w_t1_3', 'wa_t_reply', 'w_t2_4'],
  );
  assert.deepEqual(s.items[C][1].activity, { archived: SHA, count: 1 });
});

test('a reply-only turn newer than every entry goes last', () => {
  const s = twoTurns();
  applyTurnArchive(s, { convId: C, turnId: 't_new', sha256: SHA, summary: summaryOf('t_new', [], 9), items: [] });
  assert.equal(s.work[C].at(-1).id, 'wa_t_new');
});

test('applying to a state without the conversation throws nothing and changes nothing', () => {
  const s = emptyState();
  const before = JSON.stringify(s);
  assert.doesNotThrow(() => applyTurnArchive(s, archiveT1()));
  assert.equal(JSON.stringify(s), before);
});

test('the array from before the event is unchanged after it', () => {
  const s = twoTurns();
  const before = s.work[C];
  const copy = structuredClone(before);
  applyTurnArchive(s, archiveT1());
  assert.deepEqual(before, copy);
  assert.notEqual(s.work[C], before);
});

test('the summary entry keeps only the design’s fields: anything else the event carries is dropped', () => {
  const s = twoTurns();
  const d = archiveT1();
  const extra = { command: 'npm test', output: 'all passed', text: 'a reply', path: 'src/secret.txt' };
  d.summary = { ...d.summary, ...extra, counts: { ...d.summary.counts, command: 'rm -rf x' }, effort: { costUsd: 0.1, prompt: 'hi' } };
  applyTurnArchive(s, d);
  const summary = s.work[C][0];
  assert.deepEqual(Object.keys(summary).sort(), ['at', 'counts', 'effort', 'entryIds', 'handles', 'id', 'kind', 'sha256', 'turnId']);
  for (const k of Object.keys(extra)) assert.equal(k in summary, false, k);
  assert.equal('command' in summary.counts, false, 'counts keeps only its own fields');
  assert.deepEqual(summary.effort, { costUsd: 0.1 }, 'effort keeps only its own fields');
});
