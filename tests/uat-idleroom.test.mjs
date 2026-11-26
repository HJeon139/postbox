// The idleroom scenarios (tests/uat/e2e/scenarios/idleroom.md and its four-backend twin, #1746) against the runner
// that plays them: a scrum team’s two sprints, with a trigger for every ceremony, the two twins alike word for word,
// waits that leave the room alone, and nothing about asks to the person.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BOARD } from '../tools/uat/board-log.mjs';
import { IDLE_MIN_MS } from '../tools/uat/room-checks-idle.mjs';
import { compatBackends, isTargeted, parseScenario, stepCap } from '../tools/uat/scenario.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';
import { namedWait } from '../tools/uat/turns.mjs';

const read = (/** @type {string} */ name) => parseScenario(readFileSync(new URL(`./uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8'));
const solo = read('idleroom');
const compat = read('idleroom-compat');

test('each ceremony of the sprint has a trigger, in the phase it happens in, and none is about an ask to the person', () => {
  for (const scenario of [solo, compat]) {
    assert.deepEqual(unknownTriggers(scenario), []);
    assert.deepEqual(
      scenario.phases.map((/** @type {any} */ p) => p.triggers),
      [
        ['backlog-groomed', 'stories-estimated', 'sprint-planned', 'tasks-elected', 'standup-round-held', 'demo-shown'],
        ['demo-answered', 'story-sent-back', 'retro-held', 'next-sprint-took-actions'],
      ],
    );
    assert.deepEqual(scenario.agents, ['alpha', 'developer', 'critic', 'researcher']);
    assert.equal(scenario.files, 'sprint');
    assert.equal(isTargeted(scenario), true);
    assert.equal(stepCap(scenario), 20);
  }
});

test('idleroom runs on Claude Code alone, and its twin on all four backends with the same phases, word for word', () => {
  assert.deepEqual(compatBackends(solo), []);
  assert.deepEqual(solo.backends, {});
  assert.deepEqual(compatBackends(compat).sort(), ['antigravity-cli', 'codex', 'kiro-cli']);
  assert.equal(compat.backends.researcher, undefined);
  assert.deepEqual(compat.phases, solo.phases);
  assert.equal(compat.persona, solo.persona);
});

test('the request names the board and each ceremony the person expects, and tells nobody what to write', () => {
  const request = /Send this, exactly: “(@alpha [^”]+)”/.exec(solo.phases[0].text)?.[1] ?? '';
  // The board’s name is how the idle check knows this run’s definition of done.
  assert.match(request, BOARD);
  for (const ceremony of [
    /groom the backlog/,
    /estimate the stories/,
    /plan a sprint with a goal/,
    /take their own story/,
    /standup/,
    /demo/,
    /retrospective with action items/,
    /next sprint with them in it/,
  ])
    assert.match(request, ceremony);
  // More than one sprint holds: six stories, about three a sprint.
  assert.match(request, /about three stories, so there are two sprints at least/);
});

test('the person waits a minute at a time until the demo, then stays away twice the idle bar', () => {
  assert.deepEqual(
    solo.phases.map((/** @type {any} */ p) => namedWait(p.text)),
    [60, 300],
  );
  assert.match(solo.phases[1].text, /wait 300 seconds, twice/);
  assert.ok(2 * 300_000 >= 2 * IDLE_MIN_MS);
  // Before the demo a stalled room is watched for its phase’s 12 steps of a minute each: past the bar too.
  assert.ok((solo.phases[0].steps ?? 0) * 60_000 >= 2 * IDLE_MIN_MS);
});
