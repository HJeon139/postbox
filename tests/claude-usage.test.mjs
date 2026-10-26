// #295: Claude Code’s total_cost_usd and modelUsage run for the session, across --resume, so Postbox counted a
// resumed session’s earlier turns again in every later one. A turn’s spend is its totals less the session’s before
// it. tests/fixtures/claude-code/resume-costs.json is three recorded results of one session.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { forkOf, sessionTotals, turnCost } from '../server/adapters/claude-usage.mjs';
import { turnStats } from '../server/telemetry-streams.mjs';

const { results } = JSON.parse(readFileSync(new URL('./fixtures/claude-code/resume-costs.json', import.meta.url), 'utf8'));
const OWN = [0.003123, 0.002828, 0.002838]; // each turn’s own cost: its total less the one before, to the micro-dollar

/** One turn through the stream mapper, starting from the state the last turn saved; its usage, and what it saves. */
function turn(result, state) {
  const used = [];
  const ctx = { state, usage: (u) => used.push(u), text() {}, activity() {}, status() {}, saveState() {}, checkpoint() {} };
  const mapper = createStreamMapper(ctx);
  mapper.push(result);
  return { usage: used.at(-1), saved: mapper.endState };
}

test('#295 the recorded totals run for the session, and a turn’s spend is its total less the one before', () => {
  assert.deepEqual(
    results.map((r) => r.total_cost_usd),
    [0.003123215, 0.005950745, 0.008788775],
  );
  assert.deepEqual(
    results.map((r) => sessionTotals(r).tokens.input),
    [2, 4, 6],
    'modelUsage’s tokens run on too',
  );
  let before = null;
  const own = results.map((r) => {
    const t = sessionTotals(r);
    const c = turnCost(t, before);
    before = t;
    return Math.round(/** @type {number} */ (c) * 1e6) / 1e6;
  });
  assert.deepEqual(own, OWN);
});

test('#295 the stream mapper reports each resumed turn’s own spend, from the totals the last turn saved', () => {
  let state = {};
  const costs = [];
  for (const r of results) {
    const { usage, saved } = turn(r, state);
    costs.push(Math.round(usage.costUsd * 1e6) / 1e6);
    assert.equal(usage.tokens.input, 2, 'each turn’s own input tokens');
    state = { ...state, ...saved };
  }
  assert.deepEqual(costs, OWN);
});

test('#295 a turn replayed after a restart still subtracts the turn before it, not itself', () => {
  const first = turn(results[0], {});
  const state = { spent: first.saved.spent };
  // The turn’s totals aren’t saved until it ends, so replaying its stream starts from the same state.
  assert.equal(Math.round(turn(results[1], state).usage.costUsd * 1e6) / 1e6, OWN[1]);
  assert.equal(Math.round(turn(results[1], state).usage.costUsd * 1e6) / 1e6, OWN[1]);
});

test('#295 a new session subtracts nothing: a first turn, or a fork with a session id of its own', () => {
  const t = sessionTotals(results[2]);
  assert.equal(turnCost(t, null), results[2].total_cost_usd);
  assert.equal(turnCost(t, { ...sessionTotals(results[1]), sessionId: 'another-session' }), results[2].total_cost_usd);
});

test('#295 telemetry counts each turn’s own cost across a conversation’s turns, and within one with two results', () => {
  const spent = new Map();
  const costs = results.map((r) => turnStats([r], 0, spent).costUsd);
  assert.deepEqual(
    costs.map((c) => Math.round(c * 1e6) / 1e6),
    OWN,
  );
  // A turn whose CLI reported twice (a background job’s second result) counts its own cost once.
  assert.equal(Math.round(turnStats([results[1], results[2]], 0, new Map([[results[0].session_id, results[0].total_cost_usd]])).costUsd * 1e6) / 1e6, 0.005666);
});

// #435's review: two sessions resumed in turn in one folder, and a fork (resume-costs-two-sessions.json, recorded).
const two = JSON.parse(readFileSync(new URL('./fixtures/claude-code/resume-costs-two-sessions.json', import.meta.url), 'utf8')).results;
const byTurn = Object.fromEntries(two.map((r) => [r.turn, r]));
const round = (n) => Math.round(n * 1e6) / 1e6;

test('#435 two sessions resumed in turn in one folder each run on their own totals', () => {
  const before = { A: null, B: null };
  const costs = two
    .filter((r) => r.turn !== 'F1')
    .map((r) => {
      const who = r.turn[0];
      const t = sessionTotals(r);
      const c = turnCost(t, before[who]);
      before[who] = t;
      return [r.turn, round(/** @type {number} */ (c))];
    });
  assert.deepEqual(costs, [
    ['A1', 0.003123],
    ['B1', 0.002816],
    ['A2', 0.002826],
    ['B2', 0.002827],
    ['A3', 0.002837],
    ['B3', 0.002837],
  ]);
});

test('#435 a fork’s total includes its parent’s: a fork from the latest point subtracts it, any other is unknown', () => {
  const parent = sessionTotals(byTurn.A3);
  const fork = sessionTotals(byTurn.F1);
  assert.notEqual(fork.sessionId, parent.sessionId, 'a fork has a session id of its own');
  assert.ok(/** @type {number} */ (fork.costUsd) > /** @type {number} */ (parent.costUsd), 'and its total includes its parent’s');
  // The #61 retry forks the same Postbox session from its latest point: its saved totals are the parent’s.
  assert.equal(round(/** @type {number} */ (turnCost(fork, parent, { id: parent.sessionId, uuid: null }))), 0.002848);
  // A fork at a message, or from a session whose totals this one never saw, can’t be told apart from its parent’s.
  assert.equal(turnCost(fork, parent, { id: parent.sessionId, uuid: 'msg-1' }), null);
  assert.equal(turnCost(fork, null, { id: parent.sessionId, uuid: null }), null);
  assert.deepEqual(forkOf({ fork: { claudeSessionId: 's1', uuid: 'u' } }), { id: 's1', uuid: 'u' });
  assert.equal(forkOf({ claudeSessionId: 's1' }), null);
});

test('#435 a turn’s tokens are its results’ own usage, whatever the session’s totals do', () => {
  for (const r of [...two, ...results]) {
    const { usage } = turn(r, {});
    assert.equal(usage.tokens.input, r.usage.input_tokens, `${r.turn ?? 'turn'}: input tokens from the result’s usage`);
    assert.equal(usage.tokens.cacheRead, r.usage.cache_read_input_tokens);
  }
  // A forked turn whose cost is unknown still has its tokens.
  const { usage } = turn(byTurn.F1, { fork: { claudeSessionId: byTurn.A3.session_id, uuid: 'msg-1' } });
  assert.equal(usage.costUsd, null);
  assert.equal(usage.tokens.input, byTurn.F1.usage.input_tokens);
});
