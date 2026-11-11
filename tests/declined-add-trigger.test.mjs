// #693's UAT trigger: after the person declines adding an agent, another agent mentions it in prose, and no new card asks
// again. Read from a room's items, as a run records them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NEEDS_TRIGGERS } from '../tools/uat/room-checks-needs.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const trigger = NEEDS_TRIGGERS['declined-add-no-card'];
const factsOf = (f) => ({ threads: [f.t.id], state: { items: { [f.t.id]: f.store.items(f.t.id) } } });

async function says(f, se, said) {
  f.adapter.next.push(async (c) => c.text(said));
  f.rt.sendMessage(f.t.id, { text: `@${se.handle} go on` });
  await settle(f.rt);
}

async function declinedThenMentioned() {
  const f = setup();
  await says(f, f.alpha, 'Let’s ask @gamma to check the numbers.');
  const card = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.join);
  f.rt.resolveHop(f.t.id, card.id, false);
  await settle(f.rt);
  await says(f, f.beta, 'Then @gamma can take a look later.');
  return f;
}

test('declined-add-no-card fires when a prose mention after a decline raises no card, and is registered', async () => {
  assert.ok(TRIGGERS['declined-add-no-card'], 'it is registered');
  const f = await declinedThenMentioned();
  const [hit, ...rest] = trigger.run(factsOf(f));
  assert.match(hit.evidence, /to add @gamma was declined; @beta then mentioned @gamma .* and no card asked again/);
  assert.deepEqual(rest, []);
});

test('declined-add-no-card doesn’t fire when a new card asked again, as main does after a decline', async () => {
  const f = await declinedThenMentioned();
  f.rt.toolsFor(f.beta.id).wake_agent({ handle: 'gamma', message: 'I need gamma.' });
  assert.deepEqual(trigger.run(factsOf(f)), []);
});

test('declined-add-no-card needs the mention to name that agent, not one whose handle starts the same', async () => {
  const f = setup();
  await says(f, f.alpha, 'Let’s ask @gamma to check the numbers.');
  const card = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.join);
  f.rt.resolveHop(f.t.id, card.id, false);
  await settle(f.rt);
  await says(f, f.beta, 'Maybe @gamma-two, or an email to x@gamma.example.');
  assert.deepEqual(trigger.run(factsOf(f)), []);
});

test('declined-add-no-card doesn’t fire for a mention after the person added that agent themselves (#789)', async () => {
  const f = setup();
  await says(f, f.alpha, 'Let’s ask @gamma to check the numbers.');
  const card = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.join);
  f.rt.resolveHop(f.t.id, card.id, false);
  await settle(f.rt);
  // The person adds gamma by mentioning it, which lifts the decline; a later mention by another agent then reaches
  // gamma with no card, as it should, since the decline no longer stands.
  f.adapter.next.push(async (c) => c.text('Here.'));
  f.rt.sendMessage(f.t.id, { text: '@gamma please join' });
  await settle(f.rt);
  await says(f, f.beta, 'Then @gamma can take a look later.');
  assert.deepEqual(trigger.run(factsOf(f)), []);
});

test('the declinedadd scenario’s second phase is there to cause declined-add-no-card', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/declinedadd.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.deepEqual(
    s.phases.map((p) => p.triggers ?? []),
    [[], ['declined-add-no-card']],
  );
});
