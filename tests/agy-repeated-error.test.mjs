// #335: after one Antigravity quota error, every later turn of that agent ended with the same old error as a failed
// step. The streams are recorded (tests/fixtures/antigravity-cli, agy 1.4.5, gemini-3.8-flash):
// - error-after-refusal: a turn that went on and ended with ERROR, with no failed call in its stream: the path that
//   adds the failed step “Antigravity reported an error as the turn ended”;
// - error-after-reply: the same, after model calls that failed and that agy retried.
// No recording has agy repeating an old error, so each turn’s result.error is swapped for the quota error the #335 UAT
// recorded word for word (“v0.32.x UAT”, 25 October 2026, as the issue quotes it, its “…” included). Which status agy
// gives the repeat isn’t recorded: the stream decides, as it does for every ERROR.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';

const QUOTA = 'Individual quota reached. … Resets in 119h36m54s.';

/** A recorded stream, with its result’s error replaced by `error` when it didn’t succeed. */
const stream = (/** @type {string} */ name, /** @type {string} */ error) =>
  readFileSync(new URL(`fixtures/antigravity-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .map((e) => (e.event === 'result' && e.result.status !== 'SUCCESS' ? { ...e, result: { ...e.result, error } } : e));

/** The conversation error-after-refusal was recorded in: each turn resumes it, as the adapter asks agy to. */
const CONVERSATION = '15743f10-1ffb-4dfa-8cc1-df2c3986a05c';

/**
 * One agent’s turns, one after another: the state an adapter saves carries from each turn to the next.
 * @param {Record<string, any>} [state]
 */
function agent(state = {}) {
  return (/** @type {string} */ name, /** @type {string} */ error, resumed = CONVERSATION) => {
    const activity = [];
    const ctx = {
      persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'ask' },
      state,
      saveState: (/** @type {any} */ p) => Object.assign(state, p),
      text: () => {},
      activity: (/** @type {any} */ a) => activity.push(a),
      status: () => {},
      reported: () => {},
    };
    const m = createAgyMapper(ctx, { now: () => 1000, resumed });
    // Each recorded stream, as if agy had run it in the conversation the turn resumed.
    const recorded = stream(name, error);
    const own = recorded.find((e) => e.event === 'init')?.conversation_id;
    const events = own ? recorded.map((e) => JSON.parse(JSON.stringify(e).replaceAll(own, resumed))) : recorded;
    for (const e of events) m.push(e);
    return { m, ended: activity.filter((a) => a.id === 'agy-error' || a.id === 'agy-retried') };
  };
}

test('#335: a turn whose result repeats the error an earlier turn reported has no failed step', () => {
  const turn = agent();
  const first = turn('error-after-refusal', QUOTA);
  assert.deepEqual(
    first.ended.map((a) => [a.label, a.state, a.detail]),
    [['Antigravity reported an error as the turn ended', 'failed', QUOTA]],
    'the first report stays a failed step',
  );
  for (let i = 0; i < 3; i++) {
    const later = turn('error-after-refusal', QUOTA);
    assert.equal(later.m.error, null, 'the turn stands');
    assert.deepEqual(later.ended, [], `turn ${i + 2}: not this turn’s error`);
  }
});

test('#335: after a turn the quota error failed, a turn that went on and repeats it has no failed step', () => {
  // The #335 room: turns that failed on quota, then turns that worked and ended with that same error.
  const turn = agent();
  const failed = turn('bad-model', QUOTA);
  assert.match(failed.m.error ?? '', /Individual quota reached/);
  assert.deepEqual(turn('error-after-refusal', QUOTA).ended, []);
  // A turn that got nowhere still fails on it, with its reset, however often it repeats.
  const again = turn('bad-model', QUOTA);
  assert.match(again.m.error ?? '', /Individual quota reached/);
});

test('#335: a new error, or one after a failed call in the turn’s own stream, still shows', () => {
  const turn = agent();
  turn('error-after-refusal', QUOTA);
  // The turn’s own stream has failed calls: it reports them, whatever the text.
  const retried = turn('error-after-reply', QUOTA);
  assert.deepEqual(
    retried.ended.map((a) => [a.label, a.detail]),
    [['Antigravity retried after a model error', QUOTA]],
  );
  // A fresh quota error counts down, so its text differs: it’s this turn’s.
  const fresh = turn('error-after-refusal', 'Individual quota reached. … Resets in 119h35m10s.');
  assert.deepEqual(
    fresh.ended.map((a) => a.state),
    ['failed'],
  );
});

test('#335: after a turn that succeeds, the same error text is reported again', () => {
  const turn = agent();
  turn('error-after-refusal', QUOTA);
  turn('first', '');
  assert.deepEqual(
    turn('error-after-refusal', QUOTA).ended.map((a) => a.state),
    ['failed'],
  );
});

test('#335: two errors that differ only past what the step shows are both reported', () => {
  const turn = agent();
  const head = `Individual quota reached. ${'x'.repeat(400)}`;
  turn('error-after-refusal', `${head} Resets in 119h36m54s.`);
  const second = turn('error-after-refusal', `${head} Resets in 119h35m10s.`);
  assert.deepEqual(
    second.ended.map((a) => a.state),
    ['failed'],
    'a different error, though its first 400 characters match',
  );
});

test('#335: the same error in another conversation is reported', () => {
  const turn = agent();
  turn('error-after-refusal', QUOTA);
  // agy lost the conversation, and the agent’s next turn runs in a new one.
  const fresh = turn('error-after-refusal', QUOTA, 'another-conversation');
  assert.equal(fresh.m.missingSession, false);
  assert.equal(fresh.m.sessionId, 'another-conversation');
  assert.deepEqual(
    fresh.ended.map((a) => a.state),
    ['failed'],
  );
});

test('#335: the saved state holds a fingerprint, never the error’s text', () => {
  const state = {};
  agent(state)('error-after-refusal', QUOTA);
  assert.equal(state.agyLastError.conversation, CONVERSATION);
  assert.match(state.agyLastError.hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(state).includes('quota'), JSON.stringify(state));
});

test('#335: turns that end with no error text are each reported', () => {
  const turn = agent();
  turn('error-after-refusal', '');
  assert.deepEqual(
    turn('error-after-refusal', '').ended.map((a) => [a.state, a.detail]),
    [['failed', 'ERROR']],
    'a bare status isn’t an error that could repeat',
  );
});

test('#1905 agy’s words reach the step cleaned, as Codex’s and Kiro’s do: no bidi or zero-width characters, no line breaks, no controls', () => {
  const { ended } = agent()('error-after-refusal', 'Quota ‮reached‬​\nretry\u0007 later');
  assert.equal(ended[0].detail, 'Quota reached retry later');
});
