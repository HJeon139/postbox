// #484: a turn's summary of what happened since the agent's last turn keeps only the newest items within its caps, so a
// message addressed to the agent could be left out, and a mention a summary already gave reached the agent again in full
// when its queued wake was delivered. A mention of the agent is never left out now, the summary names what it left out
// and how to read it, and a mention the agent has seen comes as a pointer.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

const MENTION = '@alpha the review of the totals is done: two fixes needed in the tally.';
/** A message from beta in the conversation, as a reply of its posts it (no wake: this tests the summary alone). */
const say = (f, text) => f.rt.addItem(f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text, status: 'done' });

/** The fixture, with alpha's marker at the end of the conversation, so the next summary covers only what follows. */
function fresh() {
  const f = setup();
  f.rt.catchUp(f.store.state.sessions[f.alpha.id]);
  return f;
}
const summary = (f) => f.rt.catchUp(f.store.state.sessions[f.alpha.id]) ?? '';

test('#484 a mention of the agent is in its summary, though 44 newer items pass the item cap', () => {
  const f = fresh();
  say(f, MENTION);
  for (let i = 0; i < 44; i++) say(f, `Note ${i + 1} between other agents.`);
  const s = summary(f);
  assert.ok(s.includes(MENTION), 'the mention is kept');
  assert.match(s, /left out/, 'and the cap still left the oldest of the rest out');
});

test('#484 a mention of the agent is in its summary, though newer long items pass the character cap', () => {
  const f = fresh();
  say(f, MENTION);
  for (let i = 0; i < 30; i++) say(f, `Report ${i + 1}: ${'the run went on as planned. '.repeat(25)}`);
  assert.ok(summary(f).includes(MENTION));
});

test('#484 a summary that leaves items out says what kinds, and how to read them', () => {
  const f = fresh();
  for (let i = 0; i < 50; i++) say(f, `Note ${i + 1}.`);
  const s = summary(f);
  assert.match(s, /10 earlier items are left out: 10 messages from other agents/);
  assert.match(s, /read_conversation with skip: 40 has them/);
});

test('#484 a mention a summary gave the agent reaches it in full once: its queued wake comes as a pointer', async () => {
  const f = setup();
  const it = say(f, MENTION);
  // A turn of alpha's for something else starts first, and its summary gives the mention.
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  // Then the mention's own wake, queued while it was busy, is delivered.
  f.rt.deliver(f.alpha.id, { kind: 'agent', from: '@beta', text: MENTION, itemId: it.id });
  await settle(f.rt);
  const seen = f.adapter.calls
    .filter((c) => c.handle === 'alpha')
    .flatMap((c) => [c.message?.text ?? '', ...(c.message?.context ?? [])])
    .filter((s) => String(s).includes(MENTION));
  assert.equal(seen.length, 1, 'the full text reached alpha once');
  const second = f.adapter.calls.filter((c) => c.handle === 'alpha').at(-1).message;
  assert.match(second.text, /@beta’s message above/);
});

test('#484 a wake_agent message that names no one comes in full: a summary may have left it out', async () => {
  const f = setup();
  const text = 'Please recount the totals.';
  const it = say(f, text);
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'agent', from: '@beta', text, itemId: it.id });
  await settle(f.rt);
  assert.equal(f.adapter.calls.filter((c) => c.handle === 'alpha').at(-1).message.text, text);
});
