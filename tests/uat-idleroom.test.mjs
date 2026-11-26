// The idleroom scenarios (tests/uat/e2e/scenarios/idleroom.md and its four-backend twin, #1746) against the runner
// that plays them: their triggers exist, their phases ask for the waits that leave the room alone past the timed
// step’s end, the two say the same thing to the same agents, and their request is the one the idle check reads as the
// work being asked for.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ASKED, nightlyWork } from '../tools/uat/nightly-log.mjs';
import { IDLE_MIN_MS } from '../tools/uat/room-checks-idle.mjs';
import { compatBackends, isTargeted, parseScenario, stepCap } from '../tools/uat/scenario.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';
import { namedWait } from '../tools/uat/turns.mjs';

const { runs } = JSON.parse(readFileSync(new URL('./fixtures/uat/quiet-rooms.json', import.meta.url), 'utf8'));
const read = (/** @type {string} */ name) => parseScenario(readFileSync(new URL(`./uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8'));
const solo = read('idleroom');
const compat = read('idleroom-compat');

test('each idleroom scenario names triggers that exist on every phase, for the same four agents', () => {
  for (const scenario of [solo, compat]) {
    assert.deepEqual(unknownTriggers(scenario), []);
    assert.deepEqual(
      scenario.phases.map((/** @type {any} */ p) => p.triggers),
      [['work-handed-between-agents', 'timed-step-queued'], ['room-quiet-while-work-waited'], ['ask-shown-mid-turn']],
    );
    assert.deepEqual(scenario.agents, ['alpha', 'developer', 'critic', 'researcher']);
    assert.equal(scenario.files, 'nightly');
    assert.equal(isTargeted(scenario), true);
    assert.equal(stepCap(scenario), 22);
  }
});

test('idleroom runs on Claude Code alone, and its twin on all four backends with the same phases, word for word', () => {
  assert.deepEqual(compatBackends(solo), []);
  assert.deepEqual(solo.backends, {});
  // Claude Code for @researcher, and Kiro, Codex and Antigravity for the rest: a compatibility run.
  assert.deepEqual(compatBackends(compat).sort(), ['antigravity-cli', 'codex', 'kiro-cli']);
  assert.equal(compat.backends.researcher, undefined);
  assert.deepEqual(compat.phases, solo.phases);
  assert.equal(compat.persona, solo.persona);
});

test('the person stays away past the nightly check’s end by more than the idle bar, so a stall has room to show', () => {
  // Phase 1’s waits end when the agents stop; phase 2’s run in full, 5 minutes each, and phase 3’s for a minute.
  assert.deepEqual(
    solo.phases.map((/** @type {any} */ p) => namedWait(p.text)),
    [0, 300, 60],
  );
  const waits = /wait 300 seconds, (\w+) times/.exec(solo.phases[1].text)?.[1];
  assert.equal(waits, 'four');
  const away = 4 * 300_000;
  const takes = Number(
    /const TAKES_MS = ([\d_]+);/.exec(readFileSync(new URL('./uat/e2e/fixtures/nightly/nightly.mjs', import.meta.url), 'utf8'))?.[1].replaceAll('_', ''),
  );
  assert.equal(takes, 720_000);
  // Longer than one shell command may run in a turn (Claude Code’s 10 minutes), so the wait can’t be one command.
  assert.ok(takes > 600_000);
  // Queued as the person leaves at the earliest: they’re back 8 minutes after it’s due, 3 past the bar.
  assert.ok(away - takes >= IDLE_MIN_MS + 120_000, `back ${(away - takes) / 60_000} min after the check is due`);
});

test('the scenario’s request names the script that proves the work is done, and that message is when the work was asked for', () => {
  const request = /Send this, exactly: “(@alpha [^”]+)”/.exec(solo.phases[0].text)?.[1] ?? '';
  assert.match(request, ASKED);
  // No recorded run has that request, so none has a definition of done to be idle against.
  for (const [name, run] of Object.entries(runs)) assert.equal(nightlyWork({ events: /** @type {any} */ (run).events }).asked, null, name);
  // The recorded room with its first message’s words swapped for the scenario’s: the one edit to a record in this file.
  const sent = runs.addressed.events.find((/** @type {any} */ e) => e.type === 'item.add' && e.data.item.kind === 'user');
  const asked = runs.addressed.events.map((/** @type {any} */ e) => (e === sent ? { ...e, data: { ...e.data, item: { ...e.data.item, text: request } } } : e));
  assert.deepEqual(nightlyWork({ events: asked }), { asked: sent.data.item.at, queued: null, passed: null });
});
