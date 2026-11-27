// A per-scenario chain limit for the UAT runner (#508, designs/508/testing-strategy.md, delivery.md’s phase 1): since
// #541 there is no pair limit, so a chain stops only past the chain backstop (HOP_LIMIT, 1,000 since #1035), which no
// 8-step phase reaches. A scenario says `- chain-limit: 3` in its header, the runner starts its Postbox with POSTBOX_CHAIN_LIMIT=3,
// and shared/limits.mjs reads it as HOP_LIMIT when it’s set: since #1623 the fourth wake in a chain doesn’t go, the room
// says so in one line, and the chain-stopped trigger reads that line. tests/process/chain-limit.test.mjs starts a Postbox under the variable.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as limits from '../shared/limits.mjs';
import { chainLimit, DEFAULT_HOP_LIMIT, HOP_LIMIT } from '../shared/limits.mjs';
import { selectPhases } from '../tools/uat/phases.mjs';
import { chainLimitEnv, parseScenario, stepCap } from '../tools/uat/scenario.mjs';
import { TRIGGERS } from '../tools/uat/triggers.mjs';
import { room, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;

test('shared/limits.mjs: the default chain limit is 1,000, and POSTBOX_CHAIN_LIMIT sets it to a whole number from 1 to 10,000', () => {
  assert.equal(DEFAULT_HOP_LIMIT, 1000);
  assert.equal(limits.MAX_HOP_LIMIT, 10000);
  assert.equal(HOP_LIMIT, DEFAULT_HOP_LIMIT, 'the tests run without the variable');
  for (const unset of [undefined, '', '  ']) assert.equal(chainLimit(unset), 1000, JSON.stringify(unset));
  assert.equal(chainLimit('3'), 3);
  assert.equal(chainLimit(' 12 '), 12);
  assert.equal(chainLimit('50'), 50);
  assert.equal(chainLimit('51'), 51, 'past the old backstop of 50');
  assert.equal(chainLimit('1000'), 1000);
  assert.equal(chainLimit('10000'), 10000, 'it can raise the default (#1035)');
  // Never past the maximum, so a shell can’t turn principle 6’s backstop off by raising it.
  for (const high of ['10001', '100000'])
    assert.throws(
      () => chainLimit(high),
      (e) => e.message === `POSTBOX_CHAIN_LIMIT takes a whole number from 1 to 10,000, not “${high}”.`,
      high,
    );
  for (const bad of ['0', '-1', '2.5', '3x', 'abc', 'Infinity', '1e2', '10,000'])
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
  assert.equal(parseScenario(md('- chain-limit: 51')).chainLimit, 51, 'past the old backstop of 50 (#1035)');
  assert.equal(parseScenario(md('- chain-limit: 10000')).chainLimit, 10000);
  for (const bad of ['0', 'three', '2.5', '10001', '100000'])
    assert.throws(() => parseScenario(md(`- chain-limit: ${bad}`)), /chain-limit takes a whole number from 1 to 10,000, not/, bad);
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
 * A room run with a chain limit of 3: @critic and @developer trade three wakes since the person’s message, and the
 * fourth doesn’t go: the room says so in one line (#1623). With `card`, a wake-limit card from before #1623 is there too.
 */
function chainRoom(limit = 3, { line = true, card = false } = {}) {
  const r = room();
  for (const h of ['researcher', 'critic', 'developer']) r.agent(h);
  r.add({ id: 'it_you', at: s(0), kind: 'user', text: '@critic and @developer, settle the version number between you.' });
  for (let i = 1; i <= limit; i++) {
    const [from, to] = i % 2 ? ['critic', 'developer'] : ['developer', 'critic'];
    r.add({ id: `it_w${i}`, at: s(i), kind: 'agent', handle: from, text: `@${to} wake ${i}: 2.0.${i}?`, hop: i, wakes: [i] });
  }
  if (line) r.add({ id: 'it_stop', at: s(limit + 1), kind: 'system', variant: 'chain-stopped', wakes: limit });
  if (card) r.add({ id: 'it_card', at: s(limit + 1), kind: 'hop', from: 'developer', to: 'critic', text: 'Agreed?', status: 'open', n: limit + 1 });
  return r.f;
}

test('#1623 chain-stopped fires on the one line the room shows at a chain limit of 3, and names the cap', () => {
  const out = TRIGGERS['chain-stopped'].run(chainRoom(3));
  assert.equal(out.length, 1);
  assert.equal(out[0].at, s(4));
  assert.match(out[0].evidence, /stopped waking each other after 3 wakes, with no card/);
});

test('#1623 chain-stopped stays silent with no line, and when a wake card asked the person', () => {
  assert.deepEqual(TRIGGERS['chain-stopped'].run(chainRoom(3, { line: false })), []);
  assert.deepEqual(TRIGGERS['chain-stopped'].run(chainRoom(3, { card: true })), []);
});
