// #1328's UAT check: an agent the person didn’t write to answered their request to another agent, which it read in its
// catch-up. The addressed scenario’s requests each carry a code word; another agent’s reply with it is the finding.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHECKS } from '../tools/uat/room-checks.mjs';
import { ADDRESSED_CHECKS } from '../tools/uat/room-checks-addressed.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const check = ADDRESSED_CHECKS[0];
const factsOf = (f) => ({ threads: [f.t.id], state: f.store.state });

/** The person writes `text`, and each agent it wakes says what the next scripted reply says. */
async function send(f, text, ...replies) {
  for (const r of replies) f.adapter.next.push(async (c) => c.text(r));
  f.rt.sendMessage(f.t.id, { text });
  await settle(f.rt);
}

/** @beta’s turn for a reason of its own, which says `said`. */
async function betaWakes(f, said) {
  f.adapter.next.push(async (c) => c.text(said));
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@alpha', text: 'Can you look at the build?' });
  await settle(f.rt);
}

/** A request to @alpha by @mention, then one without, which goes to @alpha as the last speaker. */
async function twoRequests() {
  const f = setup();
  await send(f, '@alpha list three checks. End your reply with the code word ORIOLE.', 'Three checks. ORIOLE');
  await send(f, 'Add a fourth on duplicate rows. End your reply with the code word KESTREL.', 'Four checks. KESTREL');
  return f;
}

test('unaddressed-request-answered is registered, and finds another agent’s answer to a request without an @', async () => {
  assert.ok(
    CHECKS.some((c) => c.id === check.id),
    'it is registered',
  );
  const f = await twoRequests();
  await betaWakes(f, 'The build is fine. Also a duplicate-rows check: KESTREL');
  const [hit, ...rest] = check.run(factsOf(f));
  assert.match(hit.evidence, /@beta wrote the code word KESTREL from the person’s request to @alpha/);
  assert.deepEqual(rest, []);
  // Items without `to`, as main posts them, so a run on main finds it too: the last speaker was the recipient.
  const facts = factsOf(f);
  facts.state = { ...facts.state, items: { [f.t.id]: facts.state.items[f.t.id].map(({ to, ...it }) => it) } };
  assert.match(check.run(facts)[0].evidence, /@beta wrote the code word KESTREL from the person’s request to @alpha/);
});

test('unaddressed-request-answered finds an answer to a request by @mention too', async () => {
  const f = await twoRequests();
  await betaWakes(f, 'The build is fine. ORIOLE');
  assert.match(check.run(factsOf(f))[0].evidence, /@beta wrote the code word ORIOLE from the person’s request to @alpha/);
});

test('unaddressed-request-answered leaves a code word quoted mid-reply, as from a list another agent handed over', async () => {
  const f = await twoRequests();
  await betaWakes(f, '@alpha’s list ends “Four checks. KESTREL”, and nothing is missing from it.');
  assert.deepEqual(check.run(factsOf(f)), []);
});

test('unaddressed-request-answered leaves an answer to a hand-off: the addressed agent passed the request on by @mention', async () => {
  const f = setup();
  await send(f, '@alpha draft the script.', 'Drafted.');
  // @alpha hands the review on, and the reply @beta gives there answers @alpha, not the person’s line in its catch-up.
  await send(f, 'Review it for bugs. End your reply with the code word KESTREL.', 'Reviewing is @beta’s part. @beta, please review it.', 'Two bugs. KESTREL');
  assert.deepEqual(check.run(factsOf(f)), []);
});

test('unaddressed-request-answered finds nothing when only the addressed agent answers', async () => {
  const f = await twoRequests();
  await betaWakes(f, 'The build is fine.');
  assert.deepEqual(check.run(factsOf(f)), []);
});

test('unaddressed-request-answered reads the recipients a message kept, and infers them for one from before', async () => {
  const f = await twoRequests();
  // A request to both: each may write its code word.
  await send(f, '@alpha and @beta, end your replies with the code word PLOVER.', 'PLOVER', 'PLOVER');
  assert.deepEqual(check.run(factsOf(f)), []);
  // An item without `to`, as main posts it: the last speaker before it is its recipient.
  const facts = factsOf(f);
  const items = facts.state.items[f.t.id].map(({ to, ...it }) => it);
  facts.state = { ...facts.state, items: { [f.t.id]: items } };
  assert.deepEqual(check.run(facts), []);
});

test('the addressed scenario asks @researcher for reviews with code words, then waits for @critic’s own scheduled wake', () => {
  const s = parseScenario(readFileSync(new URL('./uat/e2e/scenarios/addressed.md', import.meta.url), 'utf8'));
  assert.match(s.phases[0].text, /@critic use schedule_wake/);
  for (const word of ['KESTREL', 'ORIOLE']) assert.match(s.phases[1].text, new RegExp(`code word ${word}`));
  assert.doesNotMatch(s.phases[1].text.match(/“[^”]*”/g).join(' '), /@/, 'phase 2’s requests carry no handle');
  assert.match(s.phases[2].text, /Wait 240 seconds/);
});
