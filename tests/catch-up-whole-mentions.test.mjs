// #499: every item in a turn's summary was cut at READING.item (2,000 characters) with a pointer to the rest, a message
// addressed to the agent too, and agents asked its sender to send it again rather than read the rest. A message that
// @-mentions the agent now comes whole up to READING.mention; other items keep the cut.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READING } from '../shared/limits.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** A message from beta in the conversation, posted as a reply is, with no wake: this tests the summary alone. */
const say = (f, text) => f.rt.addItem(f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text, status: 'done' });
/** The fixture, with alpha's marker at the end of the conversation, so the next summary covers only what follows. */
function fresh() {
  const f = setup();
  f.rt.catchUp(f.store.state.sessions[f.alpha.id]);
  return f;
}
const summary = (f) => f.rt.catchUp(f.store.state.sessions[f.alpha.id]) ?? '';
// About 5,000 characters, as the review drafts and finding lists the regression pass saw resent were 2,129 and longer.
const long = (start) => `${start} ${'Each finding has its file, line and a failing case. '.repeat(96)}The end.`;

test('#499 a 5,000-character message that mentions the agent reaches it whole in the summary', () => {
  const f = fresh();
  const text = long('@alpha the review has seven findings.');
  assert.ok(text.length > 4900 && text.length < 5100, `${text.length} characters`);
  say(f, text);
  const s = summary(f);
  assert.ok(s.includes(text), 'whole');
  assert.doesNotMatch(s, /read_message \{ id/);
});

test('#499 a 5,000-character message that doesn’t mention the agent is still cut at 2,000, with the pointer', () => {
  const f = fresh();
  const text = long('The review has seven findings.');
  say(f, text);
  const s = summary(f);
  assert.ok(!s.includes(text));
  assert.ok(s.includes(text.slice(0, READING.item)));
  assert.match(s, new RegExp(`2,000 of ${text.length.toLocaleString('en-US')} characters; read_message \\{ id: "`));
});

test('#499 a mention past READING.mention is cut there, with the pointer', () => {
  const f = fresh();
  const text = `@alpha ${'x'.repeat(READING.mention + 500)}`;
  say(f, text);
  const s = summary(f);
  assert.ok(s.includes(text.slice(0, READING.mention)));
  assert.match(s, new RegExp(`${READING.mention.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters; read_message`));
});

test('#499 a 5,000-character mention delivered as its own queued wake comes whole', async () => {
  const f = setup();
  const text = long('@alpha please recount the totals.');
  const it = say(f, text);
  f.rt.deliver(f.alpha.id, { kind: 'agent', from: '@beta', text, itemId: it.id });
  await settle(f.rt);
  const call = f.adapter.calls.filter((c) => c.handle === 'alpha').at(-1);
  assert.ok([call.message.text, ...(call.message.context ?? [])].some((s) => String(s).includes(text)));
});

test('#499 two mentions at the bound both come whole: the mentions’ cap holds two', () => {
  const f = fresh();
  const one = `@alpha first: ${'a'.repeat(READING.mention)}`;
  const two = `@alpha second: ${'b'.repeat(READING.mention)}`;
  say(f, one);
  say(f, two);
  const s = summary(f);
  assert.ok(s.includes(one.slice(0, READING.mention)) && s.includes(two.slice(0, READING.mention)), 'both, each cut at the bound');
  assert.doesNotMatch(s, /left out/);
});
