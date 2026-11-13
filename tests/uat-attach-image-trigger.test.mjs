// The attach-image scenario’s trigger (tools/uat/attach-image-triggers.mjs): the person attaches the test picture and
// an agent’s reply after it names what it shows. Read from a room’s items as a run records them, made by a real Runtime.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const fired = (r) => TRIGGERS['attached-image-read'].run({ threads: [r.t.id], state: { items: { [r.t.id]: r.store.items(r.t.id) } } });

/** A room where the person sends the picture to @alpha, which answers `reply`. @param {string} reply */
async function sent(reply) {
  const r = setup();
  r.store.emit('file', { id: 'fi_pic', name: 'picture.png', type: 'image/png', size: 3700, sha256: 'a'.repeat(64), at: 1 });
  r.adapter.next.push(async (c) => c.text(reply));
  r.rt.sendMessage(r.t.id, { text: '@alpha what does this show?', attachments: [{ kind: 'file', fileId: 'fi_pic' }] });
  await settle(r.rt);
  return r;
}

test('attached-image-read fires when a reply after the picture names its triangle and its word', async () => {
  const [hit, ...rest] = fired(await sent('An orange triangle with the word KIWI in it.'));
  assert.deepEqual(rest, []);
  assert.match(hit.evidence, /^@alpha said: “An orange triangle with the word KIWI in it\.”$/);
});

test('attached-image-read doesn’t fire when the agent says it can’t see the picture', async () => {
  assert.deepEqual(fired(await sent('I can’t open picture.png: it reads as binary, not an image.')), []);
});

const byEach = (r) =>
  TRIGGERS['attached-image-read-by-each'].run({ threads: [r.t.id], state: { sessions: r.store.state.sessions, items: { [r.t.id]: r.store.items(r.t.id) } } });

test('attached-image-read-by-each waits for every agent in the conversation to name the picture', async () => {
  const r = await sent('An orange triangle with the word KIWI in it.');
  assert.deepEqual(byEach(r), [], 'only @alpha has answered, and @beta is in the room too');
  r.adapter.next.push(async (c) => c.text('A triangle, orange, with KIWI written on it.'));
  r.rt.sendMessage(r.t.id, { text: '@beta and you?' });
  await settle(r.rt);
  const [hit, ...rest] = byEach(r);
  assert.deepEqual(rest, []);
  assert.equal(hit.evidence, '@alpha, @beta each named the triangle and KIWI.');
});

test('attached-image-read-again fires only once a second picture gets its own reply naming it', async () => {
  const r = await sent('An orange triangle with the word KIWI in it.');
  const again = () => TRIGGERS['attached-image-read-again'].run({ threads: [r.t.id], state: { items: { [r.t.id]: r.store.items(r.t.id) } } });
  r.adapter.next.push(async (c) => c.text('I can’t open this one.'));
  r.rt.sendMessage(r.t.id, { text: '@alpha and this one?', attachments: [{ kind: 'file', fileId: 'fi_pic' }] });
  await settle(r.rt);
  assert.deepEqual(again(), [], 'the first reply named the first picture, not the second');
  r.adapter.next.push(async (c) => c.text('Same picture: a triangle with KIWI.'));
  r.rt.sendMessage(r.t.id, { text: '@alpha try again' });
  await settle(r.rt);
  const [hit, ...rest] = again();
  assert.deepEqual(rest, []);
  assert.equal(hit.evidence, 'Picture 2: @alpha said: “Same picture: a triangle with KIWI.”');
});

for (const [name, triggers] of [
  ['attachimage', ['attached-image-read', 'attached-image-read-again']],
  ['attachimage-compat', ['attached-image-read-by-each', 'attached-image-read-again']],
]) {
  test(`the ${name} scenario names only triggers that exist, one phase each`, () => {
    const scenario = parseScenario(readFileSync(new URL(`uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8'));
    assert.deepEqual(unknownTriggers(scenario), []);
    assert.deepEqual(
      scenario.phases.map((p) => p.triggers),
      triggers.map((t) => [t]),
    );
  });
}
