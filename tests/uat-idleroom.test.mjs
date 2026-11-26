// The idleroom scenario (tests/uat/e2e/scenarios/idleroom.md, #1746) against the runner that plays it: its triggers
// exist, its phases ask for the waits that leave the room alone, and its request is the one the idle check reads as
// the work being asked for.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ASKED, nightlyWork } from '../tools/uat/nightly-log.mjs';
import { compatBackends, isTargeted, parseScenario, stepCap } from '../tools/uat/scenario.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';
import { namedWait } from '../tools/uat/turns.mjs';

const { runs } = JSON.parse(readFileSync(new URL('./fixtures/uat/quiet-rooms.json', import.meta.url), 'utf8'));
const scenario = parseScenario(readFileSync(new URL('./uat/e2e/scenarios/idleroom.md', import.meta.url), 'utf8'));

test('the idleroom scenario names triggers that exist, on every phase, runs on all four backends, and waits the room out in its second', () => {
  assert.deepEqual(unknownTriggers(scenario), []);
  assert.deepEqual(
    scenario.phases.map((/** @type {any} */ p) => p.triggers),
    [['work-handed-between-agents', 'timed-step-queued'], ['room-quiet-while-work-waited'], ['ask-shown-mid-turn']],
  );
  assert.deepEqual(scenario.agents, ['alpha', 'developer', 'critic', 'researcher']);
  // Claude Code for @researcher, and Kiro, Codex and Antigravity for the rest: a compatibility run.
  assert.deepEqual(compatBackends(scenario).sort(), ['antigravity-cli', 'codex', 'kiro-cli']);
  assert.equal(scenario.backends.researcher, undefined);
  assert.equal(isTargeted(scenario), true);
  assert.equal(stepCap(scenario), 20);
  // Phase 1’s waits end when the agents stop; phase 2’s run in full, 5 minutes each, and phase 3’s for a minute.
  assert.deepEqual(
    scenario.phases.map((/** @type {any} */ p) => namedWait(p.text)),
    [0, 300, 60],
  );
  assert.equal(scenario.files, 'nightly');
});

test('the scenario’s request names the script that proves the work is done, and that message is when the work was asked for', () => {
  const request = /Send this, exactly: “(@alpha [^”]+)”/.exec(scenario.phases[0].text)?.[1] ?? '';
  assert.match(request, ASKED);
  // No recorded run has that request, so none has a definition of done to be idle against.
  for (const [name, run] of Object.entries(runs)) assert.equal(nightlyWork({ events: /** @type {any} */ (run).events }).asked, null, name);
  // The recorded room with its first message’s words swapped for the scenario’s: the one edit to a record in this file.
  const sent = runs.addressed.events.find((/** @type {any} */ e) => e.type === 'item.add' && e.data.item.kind === 'user');
  const asked = runs.addressed.events.map((/** @type {any} */ e) => (e === sent ? { ...e, data: { ...e.data, item: { ...e.data.item, text: request } } } : e));
  assert.deepEqual(nightlyWork({ events: asked }), { asked: sent.data.item.at, queued: null, passed: null });
});
