// #484: a turn's summary of what happened since the agent's last turn keeps only the newest items within its caps, so a
// message addressed to the agent could be left out, and a mention a summary already gave reached the agent again in full
// when its queued wake was delivered. A mention of the agent is never left out now, and the summary names what it left
// out and how to read it; a mention waiting as an entry is left out of a summary, so it comes once
// (catch-up-entries.test.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const MENTION = `@alpha the review of the totals is done: two fixes needed in the tally. ${'Details follow on each fix. '.repeat(8)}`;
/** A message from beta in the conversation, as a reply of its posts it (no wake: this tests the summary alone). */
const say = (f, text) => arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text, status: 'done' });

/** The fixture, with alpha's marker at the end of the conversation, so the next summary covers only what follows. */
function fresh() {
  const f = setup();
  arrange.catchUp(f.rt, f.store.state.sessions[f.alpha.id]);
  return f;
}
const summary = (f) => arrange.catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '';

test('#484 a mention of the agent is in its summary, though 44 newer items pass the item cap', () => {
  const f = fresh();
  say(f, MENTION);
  for (let i = 0; i < 44; i++) say(f, `Note ${i + 1} between other agents.`);
  const s = summary(f);
  assert.ok(s.includes(MENTION), 'the mention is kept');
  assert.match(s, /left out/, 'and the cap still left the oldest of the rest out');
  // The mention is older than what was left out, so the summary doesn’t call what it kept the last N.
  assert.match(s, /\(40 kept, mentions of you first; 5 items are left out: 5 messages from other agents/);
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

test('#484 a wake’s message that names no one comes in full: a summary may have left it out', async () => {
  const f = setup();
  const text = 'Please recount the totals.';
  const it = say(f, text);
  f.rt.turnService.run(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.turnService.run(f.alpha.id, { kind: 'agent', from: '@beta', text, itemId: it.id });
  await settle(f.rt);
  assert.equal(f.adapter.calls.filter((c) => c.handle === 'alpha').at(-1).message.text, text);
});

test('#484 mentions have a cap of their own: past it, the oldest are left out and counted as mentions of you', () => {
  const f = fresh();
  // Each line is one mention of about 1,000 characters: 50 of them are over the mentions’ cap.
  for (let i = 0; i < 50; i++) say(f, `@alpha note ${i + 1}: ${'the tally needs another look. '.repeat(33)}`);
  const s = summary(f);
  assert.ok(s.length < 40_000, `the summary is bounded: ${s.length} characters`);
  assert.ok(s.includes('@alpha note 50:'), 'the newest mention is kept');
  assert.match(s, /left out: \d+ mentions of you/);
});

test('#484 a mention past the mentions’ cap, left out of the summary, comes in full when its wake is delivered', async () => {
  const f = setup();
  const first = say(f, `@alpha the oldest: ${'check this first. '.repeat(55)}`);
  for (let i = 0; i < 40; i++) say(f, `@alpha note ${i + 1}: ${'the tally needs another look. '.repeat(33)}`);
  f.rt.turnService.run(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.turnService.run(f.alpha.id, { kind: 'agent', from: '@beta', text: first.text, itemId: first.id });
  await settle(f.rt);
  assert.equal(f.adapter.calls.filter((c) => c.handle === 'alpha').at(-1).message.text, first.text);
});

test('#484 the skip a summary names reaches its newest left-out mention, though system lines read_conversation drops come after', () => {
  const f = fresh();
  for (let i = 0; i < 50; i++) say(f, `@alpha note ${i + 1}: ${'the tally needs another look. '.repeat(33)}`);
  // Lines read_conversation doesn’t list, after the cut: a lint line and a schedule line, as the runtime adds them.
  for (let i = 0; i < 5; i++) arrange.post(f.rt, f.t.id, { kind: 'system', variant: i % 2 ? 'schedule' : 'lint', text: `line ${i}` });
  const s = summary(f);
  const skip = Number(/read_conversation with skip: (\d+)/.exec(s)?.[1]);
  const kept = [...s.matchAll(/@alpha note (\d+):/g)].map((m) => Number(m[1]));
  const newestLeft = Math.min(...kept) - 1;
  assert.ok(newestLeft > 0, `some were left out: ${s.slice(0, 300)}`);
  const read = arrange.readConversation(f.rt, f.store.state.sessions[f.alpha.id], { skip, limit: 200 });
  assert.match(read, new RegExp(`@alpha note ${newestLeft}:`), `skip: ${skip} reads note ${newestLeft}`);
});
