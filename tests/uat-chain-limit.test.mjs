// A per-scenario chain limit for the UAT runner (#508, designs/508/testing-strategy.md, delivery.md’s phase 1): since
// #541 there is no pair limit, so a wake card comes only past the chain backstop (HOP_LIMIT, 50), which no 8-step phase
// reaches. A scenario says `- chain-limit: 3` in its header, the runner starts its Postbox with POSTBOX_CHAIN_LIMIT=3,
// and shared/limits.mjs reads it as HOP_LIMIT when it’s set: the fourth wake in a chain raises the card, and the
// triggers read which wake it came at. tests/process/chain-limit.test.mjs starts a Postbox under the variable.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chainLimit, DEFAULT_HOP_LIMIT, HOP_LIMIT } from '../shared/limits.mjs';
import { selectPhases } from '../tools/uat/phases.mjs';
import { chainLimitEnv, parseScenario, stepCap } from '../tools/uat/scenario.mjs';
import { TRIGGERS } from '../tools/uat/triggers.mjs';
import { ROUND_TWO, room, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;

test('shared/limits.mjs: the chain limit is 50 unless POSTBOX_CHAIN_LIMIT is set to a whole number from 1 up', () => {
  assert.equal(DEFAULT_HOP_LIMIT, 50);
  assert.equal(HOP_LIMIT, DEFAULT_HOP_LIMIT, 'the tests run without the variable');
  for (const unset of [undefined, '', '  ']) assert.equal(chainLimit(unset), 50, JSON.stringify(unset));
  assert.equal(chainLimit('3'), 3);
  assert.equal(chainLimit(' 12 '), 12);
  for (const bad of ['0', '-1', '2.5', '3x', 'abc', 'Infinity', '1e2'])
    assert.throws(
      () => chainLimit(bad),
      (e) => e.message.includes('POSTBOX_CHAIN_LIMIT') && e.message.includes(`“${bad}”`),
      bad,
    );
});

test('a scenario’s `- chain-limit: 3` is read, and a bad value is refused rather than ignored', () => {
  const md = (line) => `# T\n- agents: researcher, critic\n${line ? `${line}\n` : ''}\nA summary.\n\n## Phase 1: A\n- triggers: held-behind-card\n\nText.`;
  assert.equal(parseScenario(md('')).chainLimit, null);
  assert.equal(parseScenario(md('- chain-limit: 3')).chainLimit, 3);
  // The header’s other settings still parse beside it, and it isn’t taken for summary text.
  const s3 = parseScenario(md('- chain-limit: 3'));
  assert.deepEqual(s3.agents, ['researcher', 'critic']);
  assert.equal(s3.summary, 'A summary.');
  for (const bad of ['0', 'three', '2.5', '501'])
    assert.throws(() => parseScenario(md(`- chain-limit: ${bad}`)), /chain-limit takes a whole number from 1 to 500/, bad);
});

test('the runner passes the scenario’s chain limit to its Postbox as POSTBOX_CHAIN_LIMIT, and nothing without one', () => {
  assert.deepEqual(chainLimitEnv({ chainLimit: 3 }), { POSTBOX_CHAIN_LIMIT: '3' });
  assert.deepEqual(chainLimitEnv({ chainLimit: null }), {});
  assert.deepEqual(chainLimitEnv({}), {});
});

test('delivery.md runs with a chain limit of 3, so its phase 1 fits in 6 steps, and --phases keeps the limit', () => {
  const scenario = parseScenario(readFileSync(new URL('uat/e2e/scenarios/delivery.md', import.meta.url), 'utf8'));
  assert.equal(scenario.chainLimit, 3);
  assert.equal(scenario.phases[0].steps, 6);
  assert.match(scenario.phases[0].text, /fourth/);
  const chosen = selectPhases(scenario, [1, 2]);
  assert.equal(chosen.chainLimit, 3);
  assert.equal(stepCap(chosen, undefined), 12);
});

/**
 * A room run with a chain limit of 3: @critic and @developer trade three wakes since the person’s message, the fourth,
 * @critic’s, raises the card (its n), and @researcher’s wake of @critic, from the other pair, is held on it.
 */
function chainRoom(limit = 3) {
  const r = room();
  for (const h of ['researcher', 'critic', 'developer']) r.agent(h);
  r.add({ id: 'it_you', at: s(0), kind: 'user', text: '@critic and @developer, settle the version number between you.' });
  for (let i = 1; i <= limit; i++) {
    const [from, to] = i % 2 ? ['critic', 'developer'] : ['developer', 'critic'];
    r.add({ id: `it_w${i}`, at: s(i), kind: 'agent', handle: from, text: `@${to} wake ${i}: 2.0.${i}?`, hop: i, wakes: [i] });
  }
  r.add({
    id: 'it_card',
    at: s(limit + 1),
    kind: 'hop',
    from: limit % 2 ? 'developer' : 'critic',
    fromSessionId: limit % 2 ? 'se_developer' : 'se_critic',
    to: limit % 2 ? 'critic' : 'developer',
    text: '@critic 2.0.0, then. Agreed?',
    status: 'open',
    n: limit + 1,
  });
  r.patch('it_card', { held: [{ fromSessionId: 'se_researcher', from: 'researcher', to: 'critic', text: ROUND_TWO, at: s(limit + 2) }] });
  return r.f;
}

test('held-behind-card fires on the card the fourth wake raised under a chain limit of 3, and says which wake it was', () => {
  const out = TRIGGERS['held-behind-card'].run(chainRoom(3));
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /raised by wake 4 of the chain/);
  assert.match(out[0].evidence, /held @researcher’s wake of @critic too/);
  // A card from a run before n was recorded says nothing about the wake.
  const f = chainRoom(3);
  delete f.state.items.th_room.find((i) => i.kind === 'hop').n;
  delete f.events.find((e) => e.type === 'item.add' && e.data.item.kind === 'hop').data.item.n;
  assert.doesNotMatch(TRIGGERS['held-behind-card'].run(f)[0].evidence, /wake \d+ of the chain/);
});
