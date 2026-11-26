// In a UAT the person is whoever drives the page: the runner’s tester, never an agent in the room
// (tests/uat/e2e/README.md, “The person is whoever drives the page”). A run was once made with the customer as an agent
// in the room, which uses none of the page and records a conversation no person had. The runner seeded any handle a
// scenario named (tools/uat/seed.mjs), so nothing stopped a scenario from naming one that plays the person. The runner now
// refuses one, and this holds it:
// a scenario’s agents are the agents under test, from personas.json.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { scenarioAgents } from '../tools/uat/seed.mjs';

const E2E = join(import.meta.dirname, 'uat', 'e2e');
const personas = JSON.parse(readFileSync(join(E2E, 'personas.json'), 'utf8'));
const handles = new Set(personas.map((/** @type {{ handle: string }} */ p) => p.handle));
// Names for whoever uses Postbox. An agent with one would be standing in for the person. A tripwire, not the guard: a
// persona under another name can still be told to play the person, which review of a change to personas.json holds.
const PERSON = /^(?:person|customer|user|end-?user|human|client|stakeholder|requester|owner|tester|you|me)\d*$/i;

test('no persona the UAT seeds is named for the person', () => {
  assert.ok(handles.size > 0, 'personas.json lists the agents');
  for (const h of handles) assert.doesNotMatch(h, PERSON, `@${h} in personas.json reads as the person, who is the tester, not an agent`);
});

test('every scenario’s agents are agents under test from personas.json, never a stand-in for the person', () => {
  const files = readdirSync(join(E2E, 'scenarios')).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'there are scenarios to read');
  for (const file of files) {
    const scenario = parseScenario(readFileSync(join(E2E, 'scenarios', file), 'utf8'));
    for (const h of scenario.agents)
      assert.ok(
        handles.has(h),
        `${file} names the agent @${h}, which personas.json doesn’t have. If it’s there to play the person, take it out: the person is the tester, described on the scenario’s “- persona:” line. If it’s an agent under test, add it to personas.json first.`,
      );
  }
});

test('the runner refuses a scenario whose room has an agent personas.json doesn’t have', () => {
  assert.deepEqual(
    scenarioAgents({ agents: ['critic'] }, personas).map((p) => p.handle),
    ['critic'],
  );
  assert.throws(() => scenarioAgents({ agents: ['critic', 'customer'] }, personas), /@customer.*the person is the tester/s);
});
