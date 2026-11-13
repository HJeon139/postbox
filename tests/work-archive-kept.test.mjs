// The entries that stay hot when their turn is archived (#305; designs/305-archive-turns.md, “Which entries stay hot”):
// branch, commit and push, which the version-control readers patch after their turn, and the `gh pr create` and
// `gh issue create` entries the write judge’s madeBy reads, so a conversation’s older PRs keep needing no card (T-24).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveTurns, kept } from '../server/work-archive.mjs';
import * as arrange from './arrange.mjs';
import { allow, asks, bash, setup } from './requested-setup.mjs';
import { addTurn, archived, C, pass, room, summaries, who } from './work-archive-fixture.mjs';

const PR = 'https://github.com/HJeon139/postbox/pull/537';
/** t1’s kept entries, as the ledger records them: a branch, a commit, a push and two creates on GitHub. */
const KEPT = [
  { id: 'wb1', kind: 'branch', name: 'feat/x' },
  { id: 'wk1', kind: 'commit', sha: 'abc123' },
  { id: 'wp1', kind: 'push', branch: 'feat/x' },
  { id: 'wx1', kind: 'external', via: 'gh', what: 'gh pr create', state: 'done', urls: [PR] },
  { id: 'wx2', kind: 'external', via: 'gh', what: 'gh issue create', state: 'done', urls: ['https://github.com/HJeon139/postbox/issues/9'] },
];
const OTHER = { id: 'wx3', kind: 'external', via: 'gh', what: 'gh pr comment', state: 'done', urls: [] };

test('T-24: an archived turn’s branch, commit, push and create entries stay in the state, unlisted', async () => {
  const s = room();
  for (const [k, e] of [...KEPT, OTHER].entries()) s.emit('work.add', { convId: C, entry: { ...e, turnId: 't1', ...who('alpha'), at: 13 + k } });
  await pass(s);
  const [sum] = summaries(s);
  assert.deepEqual(sum.entryIds, ['t1', 'w_t1_1', 'w_t1_2', 'wx3'], 'a comment goes; the kept ones aren’t listed');
  assert.deepEqual(
    s.state.work[C].filter((e) => e.turnId === 't1' && e.kind !== 'turn-archive').map((e) => e.id),
    KEPT.map((e) => e.id),
  );
  assert.deepEqual(
    [...KEPT, OTHER].map((e) => kept(e)),
    [true, true, true, true, true, false],
  );
});

test('T-24: a turn with only kept entries left to move has no file and blocks nothing after it', async () => {
  const s = room([]);
  for (const [k, e] of KEPT.entries()) s.emit('work.add', { convId: C, entry: { ...e, turnId: 't0', ...who('alpha'), at: 1 + k } });
  for (const [k, t] of ['t1', 't2', 't3'].entries()) addTurn(s, t, 'alpha', { at: 10 * (k + 1) });
  assert.equal(await pass(s), 1);
  assert.deepEqual(archived(s), ['t1'], 't0 has nothing to move; t1 is archived past it');
});

/**
 * Whether the agent’s comment on PR 537 runs without a card, in a conversation of three ended turns, the oldest holding
 * `create` (the PR made by `gh pr create`, or nothing) and archived or not. The person doesn’t name the PR, so only
 * madeBy (server/write-intent.mjs) can let the comment through.
 */
async function commentRuns({ create, archive }) {
  const s = await setup({ judged: () => allow('comment on the PR you opened') });
  const se = arrange.agentIn(s.rt, s.t.id);
  const by = { sessionId: se.id, handle: se.handle, threadId: s.t.id };
  for (const [k, turnId] of ['t_old', 't_mid', 't_new'].entries()) {
    s.store.emit('work.add', { convId: s.t.id, entry: { id: turnId, kind: 'turn', turnId, ...by, startedAt: k, status: 'done' } });
    s.store.emit('work.add', { convId: s.t.id, entry: { id: `c_${turnId}`, kind: 'command', turnId, ...by, command: 'ls', state: 'done', at: k } });
  }
  if (create) s.store.emit('work.add', { convId: s.t.id, entry: { ...create, turnId: 't_old', ...by, at: 0 } });
  if (archive) await archiveTurns({ store: s.store, blobs: arrange.ledger(s.rt).blobs, convId: s.t.id, running: new Set() });
  const turnsArchived = s.store.state.work[s.t.id].filter((e) => e.kind === 'turn-archive').map((e) => e.turnId);
  const [allowed] = await asks(s, 'Please comment on the PR you opened that CI is green.', [bash('gh pr comment 537 --body "CI is green."')]);
  return { allowed, turnsArchived };
}

test('T-24: madeBy still finds a PR the conversation created in an archived turn, so commenting on it needs no card', async () => {
  assert.deepEqual(await commentRuns({ create: KEPT[3], archive: false }), { allowed: true, turnsArchived: [] }, 'hot: the PR is its own');
  assert.deepEqual(await commentRuns({ create: KEPT[3], archive: true }), { allowed: true, turnsArchived: ['t_old'] }, 'archived: still its own');
  assert.deepEqual(await commentRuns({ create: null, archive: true }), { allowed: false, turnsArchived: ['t_old'] }, 'no PR made: a card');
});
