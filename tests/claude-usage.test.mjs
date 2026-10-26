// #295: Claude Code’s total_cost_usd and modelUsage run for the session, across --resume, so Postbox counted a
// resumed session’s earlier turns again in every later one. A turn’s spend is its totals less the session’s before
// it. tests/fixtures/claude-code/resume-costs.json is three recorded results of one session.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { sessionTotals, turnSpend } from '../server/adapters/claude-usage.mjs';
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
    const s = turnSpend(t, before);
    before = t;
    return Math.round(s.costUsd * 1e6) / 1e6;
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
  assert.equal(turnSpend(t, null).costUsd, results[2].total_cost_usd);
  assert.equal(turnSpend(t, { ...sessionTotals(results[1]), sessionId: 'another-session' }).costUsd, results[2].total_cost_usd);
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
