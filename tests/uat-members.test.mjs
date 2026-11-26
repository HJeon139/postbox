// #1735's UAT pieces: the runner's members action against a stand-in page, the triggers that read what it recorded,
// and the scenario that is there to cause them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { changeMembers } from '../tools/uat/driver-members.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';

/** A page with the room’s form: a Members list the + and − change, as the page does once each change is heard. */
function standIn(members) {
  const did = [];
  let picked = '';
  const kit = {
    ev: async (/** @type {string} */ expr) => {
      if (expr.includes("getElementById('rm-add')")) return true;
      const named = expr.match(/textContent === "(@[\w-]+)"/)?.[1];
      if (named) return expr.startsWith('!!(!(') ? !members.includes(named) : members.includes(named);
      if (expr.endsWith(".map((li) => li.querySelector('b')?.textContent ?? '')")) return [...members];
      throw new Error(`The stand-in page doesn’t answer ${expr}`);
    },
    clickAt: async (/** @type {string} */ _expr, /** @type {string} */ what) => {
      did.push(what);
      const offered = what.match(/^(@[\w-]+) in what \+ offers$/)?.[1];
      if (offered) members.push(offered);
      picked = what.match(/^(@[\w-]+)’s row$/)?.[1] ?? picked;
      if (what === 'the confirm’s Delete session') members.splice(members.indexOf(picked), 1);
    },
    press: async (/** @type {string} */ key) => void did.push(key),
  };
  return { kit, did };
}

test('the members action adds an agent with the list’s +, removes one with its − and the confirm, and reads the list after', async () => {
  const added = standIn(['@developer']);
  assert.deepEqual(await changeMembers(added.kit, { add: '@critic' }), { members: ['@developer', '@critic'] });
  assert.deepEqual(added.did, ['Manage this conversation’s members', 'the Members list’s +', '@critic in what + offers', 'Escape']);
  const removed = standIn(['@developer', '@critic']);
  assert.deepEqual(await changeMembers(removed.kit, { remove: 'critic' }), { members: ['@developer'] });
  assert.deepEqual(removed.did, ['Manage this conversation’s members', '@critic’s row', 'the Members list’s −', 'the confirm’s Delete session', 'Escape']);
});

test('the triggers fire only for a change the Members list shows took', () => {
  const f = {
    probes: {
      members: [
        { add: 'critic', members: ['@developer', '@critic'], at: 1 },
        { add: 'tester', members: ['@developer', '@critic'], at: 2 },
        { remove: 'critic', members: ['@developer'], at: 3 },
        { remove: 'developer', members: ['@developer'], at: 4 },
      ],
    },
  };
  assert.deepEqual(TRIGGERS['member-added-in-menu'].run(f), [{ at: 1, evidence: '@critic was added, and the Members list then read: @developer, @critic.' }]);
  assert.deepEqual(TRIGGERS['member-removed-in-menu'].run(f), [{ at: 3, evidence: '@critic was removed, and the Members list then read: @developer.' }]);
  // A run whose runner never recorded the action can’t say either way; one that recorded none fired nothing.
  assert.equal(TRIGGERS['member-added-in-menu'].recorded({ probes: {} }), false);
  assert.deepEqual(TRIGGERS['member-added-in-menu'].run({ probes: { members: [] } }), []);
});

test('the members scenario is there to cause both triggers', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/members.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.deepEqual(
    s.phases.map((p) => p.triggers ?? []),
    [['member-added-in-menu'], ['member-removed-in-menu']],
  );
});
