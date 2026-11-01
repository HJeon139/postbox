// The Work view's totals don't shrink when old turns are archived (#305, T-14; the integrator's review of #603): a
// conversation of many turns reads the same effort and counts before a pass and after it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryBlobs } from '../server/ledger-io.mjs';
import { Store } from '../server/store.mjs';
import { archiveTurns } from '../server/work-archive.mjs';
import { summarize } from '../shared/work.mjs';

const C = 'th_c';

/** A store with `n` turns, each by @alpha or @beta, with one command, one change and a priced turn entry. */
function room(n) {
  const s = new Store(null);
  s.emit('thread', { id: C, members: [] });
  for (let i = 1; i <= n; i++) {
    const handle = i % 2 ? 'alpha' : 'beta';
    const t = `t${i}`;
    s.emit('work.add', {
      convId: C,
      entry: { id: t, kind: 'turn', turnId: t, handle, status: 'done', at: i * 10, ms: 1000, toolCalls: 3, costUsd: 0.5, tokens: { input: 100, output: 20 } },
    });
    s.emit('work.add', {
      convId: C,
      entry: { id: `c_${t}`, kind: 'command', turnId: t, handle, state: i === 2 ? 'failed' : 'done', command: 'ls', at: i * 10 + 1 },
    });
    s.emit('work.add', { convId: C, entry: { id: `d_${t}`, kind: 'change', turnId: t, handle, fileId: 'wf_1', added: 4, deleted: 1, at: i * 10 + 2 } });
  }
  s.emit('work.add', {
    convId: C,
    entry: {
      id: 'wf_1',
      kind: 'file',
      path: '/p/a.txt',
      rel: 'a.txt',
      handles: ['alpha', 'beta'],
      lastHandle: 'beta',
      added: 4,
      deleted: 1,
      before: { exists: true, sha256: 'x' },
      after: { exists: true, sha256: 'y' },
    },
  });
  return s;
}

const figures = (/** @type {any} */ s) => ({
  turns: s.effort.turns,
  ms: s.effort.ms,
  toolCalls: s.effort.toolCalls,
  costUsd: s.effort.costUsd,
  tokens: s.effort.tokens,
  written: s.effort.written,
  commands: s.commands.length + (s.archived?.commands ?? 0),
  failed: s.commands.filter((/** @type {any} */ c) => c.state === 'failed').length + (s.archived?.failed ?? 0),
});

test('T-14: 500 turns at $0.50 read the same before a pass and after it (the integrator’s repro)', async () => {
  const s = room(500);
  const before = figures(summarize(s.state.work[C]));
  assert.equal(before.costUsd, 250);
  await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() });
  assert.equal(s.state.work[C].filter((e) => e.kind === 'turn').length, 2, 'the pass left two turns');
  assert.deepEqual(figures(summarize(s.state.work[C])), before);
});

test('T-14: each agent’s effort is kept too, and one archived turn’s own scope reads its own figures', async () => {
  const s = room(6);
  const whole = summarize(s.state.work[C]);
  const perAgent = (/** @type {any} */ sm) =>
    Object.fromEntries(
      sm.byAgent.map((/** @type {any} */ a) => [a.handle, { turns: a.turns, ms: a.ms, toolCalls: a.toolCalls, costUsd: a.costUsd, tokens: a.tokens }]),
    );
  const before = perAgent(whole);
  await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() });
  const after = summarize(s.state.work[C]);
  assert.deepEqual(perAgent(after), before);
  assert.equal(summarize(s.state.work[C], { handle: 'alpha' }).effort.turns, before.alpha.turns);
  const archivedTurn = s.state.work[C].find((e) => e.kind === 'turn-archive');
  assert.equal(summarize(s.state.work[C], { turnId: archivedTurn.turnId }).effort.costUsd, 0.5);
});

test('T-14: a hot turn is never counted twice, and a store with nothing archived reads as it always did', async () => {
  const s = room(2);
  const plain = summarize(s.state.work[C]);
  assert.equal(plain.archived, undefined, 'no archived figures when nothing is archived');
  assert.equal(plain.effort.turns, 2);
  await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() });
  assert.equal(summarize(s.state.work[C]).effort.turns, 2, 'two turns, none archived');
});

test('T-14: the commits, pushes and branches of an archived turn are still counted once, from the live list (design-305-live-kinds-1)', () => {
  // A summary stands for turn t1, whose turn entry is gone; its kept entries stay live (branch, commit, push).
  const list = [
    {
      id: 'wa_t1',
      kind: 'turn-archive',
      turnId: 't1',
      handles: ['alpha'],
      counts: { files: 0, lines: { added: 0, removed: 0 }, commands: 1, failed: 0, reads: 0, publishes: 0, steps: 0 },
      effort: {
        turns: 1,
        ms: 1,
        toolCalls: 1,
        costUsd: 0.5,
        tokens: 5,
        priced: true,
        byHandle: { alpha: { turns: 1, ms: 1, toolCalls: 1, costUsd: 0.5, tokens: 5, priced: true } },
      },
    },
    { id: 'wc1', kind: 'commit', turnId: 't1', sha: 'abc', handle: 'alpha' },
    { id: 'wp1', kind: 'push', turnId: 't1', handle: 'alpha' },
    { id: 'wb1', kind: 'branch', turnId: 't1', name: 'feat/x', handle: 'alpha' },
    { id: 't2', kind: 'turn', turnId: 't2', handle: 'beta', ms: 1, toolCalls: 1, costUsd: 0.5 },
    { id: 'wc2', kind: 'commit', turnId: 't2', sha: 'def', handle: 'beta' },
  ];
  const s = summarize(list);
  assert.equal(s.commits.length, 2, 'the archived turn’s commit and the live turn’s');
  assert.equal(s.pushes.length, 1);
  assert.equal(s.branches.length, 1);
  assert.equal(s.effort.turns, 2, 'one archived and one live turn, none counted twice');
  assert.equal(summarize(list, { turnId: 't1' }).commits.length, 1, 'one archived turn’s own scope reads its kept entries');
  assert.equal(summarize(list, { handle: 'alpha' }).commits.length, 1, 'and so does one agent’s');
});
