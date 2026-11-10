// The Work view’s totals keep what archived turns did (#305, T-14; designs/305-archive-turns.md, “Records”): a turn
// summary’s counts and effort are added once, never against a hot turn of the same id, and the entries an archived
// turn keeps in the state (branch, commit, push and its `external` creates) are still counted from the live list.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, emptyState } from '../shared/state.mjs';
import { summarize } from '../shared/work.mjs';
import { archiveEvent } from './work-archive-fixture.mjs';

const C = 'th_c';
const TURN = { status: 'done', ms: 1000, toolCalls: 3, costUsd: 0.5, tokens: { input: 100, output: 20 } };

/** One turn of `handle`: its turn entry, a command (failed for t2) and a change of +4 −1 to wf_1. */
function turnOf(i, handle) {
  const t = `t${i}`;
  return [
    { id: t, kind: 'turn', turnId: t, handle, at: i * 10, ...TURN },
    { id: `c_${t}`, kind: 'command', turnId: t, handle, state: i === 2 ? 'failed' : 'done', command: 'ls', at: i * 10 + 1 },
    { id: `d_${t}`, kind: 'change', turnId: t, handle, fileId: 'wf_1', added: 4, deleted: 1, at: i * 10 + 2 },
  ];
}

/** A conversation of `n` turns, @alpha’s and @beta’s by turns, and the one file they changed. */
function room(n) {
  const s = emptyState();
  s.threads[C] = { id: C, members: [] };
  const turns = Array.from({ length: n }, (_, i) => turnOf(i + 1, i % 2 ? 'beta' : 'alpha'));
  const file = {
    id: 'wf_1',
    kind: 'file',
    path: '/p/a.txt',
    rel: 'a.txt',
    handles: ['alpha', 'beta'],
    lastHandle: n % 2 ? 'alpha' : 'beta',
    turns: turns.map((t) => t[0].id),
    added: 4,
    deleted: 1,
    before: { exists: true, sha256: 'x' },
    after: { exists: true, sha256: 'y' },
  };
  for (const entry of [...turns.flat(), file]) apply(s, 'work.add', { convId: C, entry });
  return { s, turns };
}

/** Archives turns in the state as the pass does: their summary in place of the entries, which leave the state. */
function archive(s, turns) {
  for (const work of turns) apply(s, 'turn.archive', archiveEvent(C, work[0].id, 'a'.repeat(64), work));
}

/** What the Work view shows of the totals: effort, and the commands with the archived turns’ among them. */
const figures = (/** @type {any} */ t) => ({
  ...t.effort,
  commands: t.commands.length + (t.archived?.commands ?? 0),
  failed: t.commands.filter((c) => c.state === 'failed').length + (t.archived?.failed ?? 0),
});
const perAgent = (/** @type {any} */ t) =>
  Object.fromEntries(
    t.byAgent.map((a) => [
      a.handle,
      { turns: a.turns, ms: a.ms, costUsd: a.costUsd, tokens: a.tokens, commands: a.commands, failed: a.failed, written: a.written, writtenDel: a.writtenDel },
    ]),
  );

test('500 turns at $0.50 read the same totals before their archive and after it (the integrator’s repro)', () => {
  const { s, turns } = room(500);
  const before = summarize(s.work[C]);
  assert.equal(before.effort.costUsd, 250);
  archive(s, turns.slice(0, 496));
  const after = summarize(s.work[C]);
  assert.equal(after.turns.length, 4, 'four turns are hot');
  assert.deepEqual(figures(after), figures(before));
  assert.deepEqual(perAgent(after), perAgent(before));
  assert.equal(after.archived.turns, 496);
});

test('a summary whose turn is hot is never added against it: one turn, counted once', () => {
  const { s, turns } = room(2);
  archive(s, [turns[0]]);
  // The Work view draws an opened archived turn from the hot list and the turn’s entries together.
  const opened = [...s.work[C], ...turns[0]];
  const t = summarize(opened);
  assert.equal(t.effort.turns, 2);
  assert.equal(t.effort.costUsd, 1);
  assert.equal(t.archived, undefined, 'nothing archived is left to add');
  assert.equal(summarize(opened, { turnId: 't1' }).effort.turns, 1);
});

test('with nothing archived, the totals carry no archived figures', () => {
  const t = summarize(room(2).s.work[C]);
  assert.equal(t.archived, undefined);
  assert.equal(t.effort.turns, 2);
});

test('one archived turn’s own scope reads its summary’s effort and counts', () => {
  const { s, turns } = room(3);
  archive(s, [turns[1]]);
  const t = summarize(s.work[C], { turnId: 't2' });
  assert.equal(t.effort.turns, 1);
  assert.equal(t.effort.costUsd, 0.5);
  assert.equal(t.effort.tokens, 120);
  assert.deepEqual(
    { commands: t.archived.commands, failed: t.archived.failed, lines: t.archived.lines },
    { commands: 1, failed: 1, lines: { added: 4, removed: 1 } },
  );
});

test('one agent’s totals add only that agent’s archived turns, and keep the file its archived turns changed', () => {
  const { s, turns } = room(4);
  archive(s, turns.slice(0, 2));
  const alpha = summarize(s.work[C], { handle: 'alpha' });
  assert.equal(alpha.effort.turns, 2, 't1 archived and t3 hot');
  assert.equal(alpha.archived.turns, 1);
  assert.deepEqual(
    alpha.byAgent.map((a) => a.handle),
    ['alpha'],
  );
  assert.deepEqual(
    alpha.files.map((f) => f.id),
    ['wf_1'],
  );
  const beta = summarize(s.work[C], { handle: 'beta' });
  assert.equal(beta.archived.failed, 1, 't2’s failed command');
});

test('an agent whose every turn is archived still has its row of effort', () => {
  const { s, turns } = room(3);
  archive(s, [turns[1]]);
  const beta = summarize(s.work[C]).byAgent.find((a) => a.handle === 'beta');
  assert.deepEqual({ turns: beta?.turns, commands: beta?.commands, written: beta?.written }, { turns: 1, commands: 1, written: 4 });
});

test('the entries an archived turn keeps are counted once: in all, in its own scope and in its agent’s', () => {
  const s = emptyState();
  s.threads[C] = { id: C, members: [] };
  const t1 = turnOf(1, 'alpha');
  const kept = [
    { id: 'wc1', kind: 'commit', turnId: 't1', handle: 'alpha', sha: 'abc', at: 13 },
    { id: 'wp1', kind: 'push', turnId: 't1', handle: 'alpha', at: 14 },
    { id: 'wb1', kind: 'branch', turnId: 't1', handle: 'alpha', name: 'feat/x', at: 15 },
    { id: 'wx1', kind: 'external', turnId: 't1', handle: 'alpha', what: 'Created a pull request', state: 'done', at: 16 },
  ];
  for (const entry of [...t1, ...kept, ...turnOf(2, 'beta')]) apply(s, 'work.add', { convId: C, entry });
  // The pass lists only the entries it moves: the kept kinds stay (“Which entries stay hot”).
  apply(s, 'turn.archive', archiveEvent(C, 't1', 'a'.repeat(64), t1));
  for (const [scope, opts] of [
    ['all', {}],
    ['its own', { turnId: 't1' }],
    ['its agent’s', { handle: 'alpha' }],
  ]) {
    const t = summarize(s.work[C], opts);
    assert.deepEqual([t.commits.length, t.pushes.length, t.branches.length, t.external.length], [1, 1, 1, 1], scope);
  }
  assert.equal(summarize(s.work[C]).effort.turns, 2);
});
