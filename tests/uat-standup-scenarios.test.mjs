// The standup scenarios (tests/uat/e2e/scenarios/standup.md and its four-backend twin, #1746) against the runner that
// plays them: their triggers exist, the two say the same thing to the same agents, the request asks for a standup in
// the word the trigger reads, and the person stays away past the idle bar.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IDLE_MIN_MS } from '../tools/uat/room-checks-idle.mjs';
import { compatBackends, isTargeted, parseScenario } from '../tools/uat/scenario.mjs';
import { STANDUP } from '../tools/uat/standup.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';
import { namedWait } from '../tools/uat/turns.mjs';

test('the standup scenario and its four-backend twin ask the same thing, for a standup by that word, and stay away past the idle bar', () => {
  const read = (/** @type {string} */ name) => parseScenario(readFileSync(new URL(`./uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8'));
  const solo = read('standup');
  const compat = read('standup-compat');
  assert.deepEqual(compatBackends(solo), []);
  assert.deepEqual(compatBackends(compat).sort(), ['antigravity-cli', 'codex', 'kiro-cli']);
  assert.deepEqual(compat.phases, solo.phases);
  assert.equal(compat.persona, solo.persona);
  assert.deepEqual(unknownTriggers(solo), []);
  assert.equal(isTargeted(solo), true);
  assert.deepEqual(
    solo.phases.map((/** @type {any} */ p) => p.triggers),
    [['work-handed-between-agents', 'standup-round-held'], ['room-quiet-while-work-waited']],
  );
  const request = /Send this, exactly: “(@alpha [^”]+)”/.exec(solo.phases[0].text)?.[1] ?? '';
  // The request asks for a standup in the word the trigger reads, and names the script the idle check reads.
  assert.match(request, STANDUP);
  assert.match(request, /nightly\.mjs/);
  // No phase is about an ask to the person: “needs you” isn’t what stalls a room.
  assert.ok(!solo.phases.some((/** @type {any} */ p) => p.triggers.includes('ask-shown-mid-turn')));
  // Away twice 300 s: twice the bar, so a room that stops after the standup has been idle past it when the person returns.
  assert.deepEqual(
    solo.phases.map((/** @type {any} */ p) => namedWait(p.text)),
    [0, 300],
  );
  assert.match(solo.phases[1].text, /wait 300 seconds, twice/);
  assert.ok(2 * 300_000 >= 2 * IDLE_MIN_MS);
});
