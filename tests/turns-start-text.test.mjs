// What a turn started from a mention entry is given: its entry’s line in turn-input.mjs’s text since #1427 (entryLine,
// #1386). A newer post from the sender is named without the sender’s handle, a cut falls on a whole character (#675),
// and a copy of the line as the agent was given it wakes no one (#1370).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copiedLine } from '../server/copied-line.mjs';
import { READING } from '../shared/limits.mjs';
import { parseMentions } from '../shared/text.mjs';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** What beta’s second turn was given from alpha, after alpha’s reply `text` reached it while busy, and alpha’s later posts. */
async function givenToBeta(text, later = []) {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  f.adapter.next.push(async (c) => c.text(text));
  f.rt.sendMessage(f.t.id, { text: '@alpha go' });
  for (let i = 0; i < 200 && arrange.running(f.rt, f.alpha.id); i++) await sleep(5);
  const posts = later.map((t) => arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.alpha.id, handle: 'alpha', text: t, status: 'done' }));
  busy.release();
  await settle(f.rt);
  const { message } = f.adapter.calls.filter((c) => c.sessionId === f.beta.id)[1];
  const said = f.store.items(f.t.id).find((x) => x.kind === 'agent' && x.handle === 'alpha' && x.text === text);
  // Its entry’s line, from its id to the next part of the input.
  const given = message.text.slice(message.text.indexOf(`[${said.id}]`)).split('\n\n[')[0];
  return { ...f, given, posts };
}

test('a newer post from the sender is named without the sender’s handle, so a copy of the entry wakes no one', async () => {
  const { given, posts } = await givenToBeta('@beta check the totals.', ['Actually, the totals are fine.']);
  assert.ok(given.endsWith(`(The same sender posted since: [${posts[0].id}])`), given);
  assert.doesNotMatch(given.slice(given.indexOf('(The same sender')), /@alpha/, 'the note doesn’t name the sender');
});

test('a mention past what one message carries is cut on a whole character, never between the halves of a pair (#675)', async () => {
  const text = `@beta ${'x'.repeat(READING.mention - 7)}😀 and more`;
  const { given } = await givenToBeta(text);
  const kept = given.slice(0, given.indexOf('…'));
  assert.doesNotMatch(kept, /[\uD800-\uDBFF]$/, 'no lone high half at the cut');
  assert.ok(given.includes(`characters; read_message { id: "`), given);
});

test('a copy of a cut entry, as the agent was given it, is read as a copy and wakes no one (#1370)', async () => {
  const text = `@beta ${'y'.repeat(READING.mention)} the end`;
  const { rt, beta, given } = await givenToBeta(text);
  assert.deepEqual(parseMentions(given, ['alpha', 'beta'], copiedLine(rt, beta)), []);
});
