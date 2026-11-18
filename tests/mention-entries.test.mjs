// An agent’s @-mention reaches the other agent as an entry made from its final reply (server/mention-entries.mjs): up to
// SENDING.message whole, and past it cut with the reply’s id, never refused (designs/rooms-at-scale.md, “What an entry is”).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

const LIMIT = 50_000;
/** A reply that @-mentions beta, with characters a careless check would mangle, padded to n characters. */
const reply = (n) => {
  const head = '@beta check “this” <b>&amp; "quoted" \u0000 \uD800 ';
  return head + 'x'.repeat(n - head.length);
};
/** What beta was sent by alpha’s turn that says text, and what alpha is told at its next turn. */
async function mention(text) {
  const { store, rt, adapter, t, alpha, beta } = setup();
  adapter.next.push(async (c) => c.text(text));
  rt.sendMessage(t.id, { text: '@alpha go' });
  await settle(rt);
  const woke = adapter.calls.filter((c) => c.sessionId === beta.id);
  return { woke, told: store.state.sessions[alpha.id].context ?? [], store, t };
}

test('#362: a reply exactly at the limit wakes the agent it mentions; its turn gives it as written, cut at one entry’s ceiling with its id', async () => {
  const text = reply(LIMIT);
  assert.equal(text.length, LIMIT);
  const { woke, told, store, t } = await mention(text);
  assert.equal(woke.length, 1, 'beta was woken');
  // A turn gives each entry whole up to READING.mention, then its id (designs/rooms-at-scale.md, “The budget”; #1427).
  const posted = store.items(t.id).find((x) => x.kind === 'agent' && x.text === text);
  assert.ok(woke[0].message.text.includes(text.slice(0, 1000)), 'every character as written, up to the cut');
  assert.match(woke[0].message.text, new RegExp(`… \\(15,000 of 50,000 characters; read_message \\{ id: "${posted.id}" \\} has the rest\\)`));
  assert.deepEqual(
    told.filter((x) => /woke no one/.test(x)),
    [],
  );
});

test('a reply past what one message carries still reaches the agent it mentions, cut with its id; nothing is refused', async () => {
  // designs/rooms-at-scale.md, “What an entry is”: no mention is refused for its reply’s length. #362 refused it and
  // gave the agent a notice turn to hand off with wake_agent, which is going.
  const text = `@beta check this ${'x'.repeat(LIMIT + 1)}`.slice(0, LIMIT + 1);
  const { store, rt, adapter, t, alpha, beta } = setup();
  adapter.next.push(async (c) => c.text(text));
  rt.sendMessage(t.id, { text: '@alpha go' });
  await settle(rt);
  const woke = adapter.calls.filter((c) => c.sessionId === beta.id);
  assert.equal(woke.length, 1, 'beta was woken');
  const posted = store.items(t.id).find((x) => x.kind === 'agent' && x.text === text);
  assert.match(woke[0].parts[0].text, new RegExp(`… \\(50,000 of 50,001 characters; read_message \\{ id: "${posted.id}" \\} has the rest\\)$`));
  // Alpha’s one turn after its own is beta’s reply going back to it (#1518), not a notice.
  const later = adapter.calls.filter((c) => c.sessionId === alpha.id).slice(1);
  assert.deepEqual(
    later.map((c) => c.message.from),
    ['@beta'],
    'alpha got no notice turn',
  );
  assert.ok(!store.items(t.id).some((x) => /woke no one/.test(x.text ?? '')), 'no refusal line');
});

/** Waits until a condition holds, or fails naming what it waited for. */
async function until(ok, what) {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `waited for ${what}`);
}

test('#834: a mention waiting for a busy agent reaches it whole, not cut to the sender’s next reply still streaming', async () => {
  // In #834, @critic was given @developer’s message as “I”: the queue swapped a waiting wake for its sender’s newest
  // post, which was still streaming. An entry points at its own final item, so it reaches the agent whole.
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start the survey' });
  await sleep(5);
  adapter.next.push(async (c) => c.text('@beta the editions differ in chapter 3; compare them.'));
  rt.sendMessage(t.id, { text: '@alpha hand off to beta' });
  await until(() => !arrange.running(rt, alpha.id), 'alpha’s hand-off to end');
  const streaming = held();
  adapter.next.push(async (c) => {
    c.text('I');
    await streaming.step(c);
  });
  rt.sendMessage(t.id, { text: '@alpha keep going' });
  await until(() => arrange.running(rt, alpha.id), 'alpha’s next reply to stream');
  busy.release();
  await until(() => adapter.calls.filter((c) => c.sessionId === beta.id).length === 2, 'beta’s next turn');
  const { parts } = adapter.calls.filter((c) => c.sessionId === beta.id)[1];
  const fromAlpha = parts.filter((m) => m.from === '@alpha').map((m) => m.text);
  assert.deepEqual(fromAlpha, ['@beta the editions differ in chapter 3; compare them.'], 'the whole hand-off, not the reply streaming');
  streaming.release();
  await settle(rt);
});

test('a mention in a reply still streaming hands nothing over; once its part closes mid-turn, the agent it names is woken then', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const gate = held();
  /** @type {number[]} */
  const seen = [];
  adapter.next.push(async (c) => {
    c.text('@beta please check the totals.');
    seen.push(adapter.calls.filter((x) => x.sessionId === beta.id).length);
    c.activity({ id: 'st_1', label: 'Read', state: 'done' });
    // Something posted below the part, then more words: the first part closes while the turn runs.
    arrange.post(rt, t.id, { kind: 'user', text: 'Meanwhile' });
    c.text('Still working.');
    await gate.step(c);
  });
  rt.sendMessage(t.id, { text: '@alpha total it up' });
  await until(() => adapter.calls.some((x) => x.sessionId === beta.id), 'beta to be woken');
  assert.deepEqual(seen, [0], 'nothing reached beta while the mention streamed');
  assert.ok(arrange.running(rt, alpha.id), 'beta was woken while alpha’s turn still ran');
  assert.match(JSON.stringify(adapter.calls.find((x) => x.sessionId === beta.id).message), /please check the totals/);
  gate.release();
  await settle(rt);
});

test('a reply mirrored from a terminal and a shell command’s output name an agent without waking it', async () => {
  // Both are final when added and keep growing after (#1368’s review): only a reply of a turn Postbox runs makes entries.
  const { rt, adapter, t, alpha, beta } = setup();
  arrange.post(rt, t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: '@beta from the terminal', status: 'done', via: 'terminal' });
  arrange.post(rt, t.id, { kind: 'command', sessionId: alpha.id, handle: 'alpha', turnId: 'tu_x', text: 'echo @beta', status: 'running' });
  await settle(rt);
  assert.deepEqual(arrange.waitingEntries(rt, beta.id), []);
  assert.equal(adapter.calls.filter((c) => c.sessionId === beta.id).length, 0);
});

test('a reply settled behind a held commit writes its mention’s entry in the same held run, published with it', async () => {
  // #1368’s review: an item.final held behind a commit could be lost in a second outage, so the entry is written as
  // part of the same held writes as its item, never later.
  const h = await heldStore();
  const { rt, adapter, t, alpha, beta, store } = setup(h.store);
  await store.flush();
  const gate = held();
  adapter.next.push(async (c) => {
    c.text('@beta the numbers are in.');
    await gate.step(c);
  });
  rt.sendMessage(t.id, { text: '@alpha report' });
  await until(() => arrange.running(rt, alpha.id), 'alpha’s turn');
  h.hold();
  const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  gate.release();
  await until(() => !arrange.running(rt, alpha.id), 'alpha’s turn to end behind the held commit');
  assert.equal(store.pending.inbox(beta.id).length, 1, 'held: the entry is pending with its item');
  assert.equal(store.state.inbox[beta.id], undefined, 'and not published before the item');
  h.release();
  await commit;
  await store.flush();
  const reply = store.items(t.id).find((x) => x.kind === 'agent' && x.text.startsWith('@beta the numbers are in.'));
  assert.equal(reply.status, 'done');
  assert.deepEqual(
    store.state.inbox[beta.id].map((e) => e.itemId),
    [reply.id],
  );
  await settle(rt);
  await store.close();
});

test('a mention quoted in a blockquote or copied as a line of the conversation makes no entry; a hand-off in the same reply does', async () => {
  // designs/rooms-at-scale.md, “Which mention wakes”; the copied line is #1370’s, as read_conversation gives it.
  const { store, rt, adapter, t, beta, c } = setup();
  const gamma = rt.ensureSession(t.id, c.id);
  const said = arrange.post(rt, t.id, {
    kind: 'agent',
    sessionId: beta.id,
    personaId: beta.personaId,
    handle: 'beta',
    text: 'I reran the guide.',
    status: 'done',
  });
  adapter.next.push(async (x) => x.text(`[${said.id}] @beta: I reran the guide.\n\n> @beta said so earlier.\n\n@gamma please check it.`));
  rt.sendMessage(t.id, { text: '@alpha what did beta do?' });
  await settle(rt);
  assert.deepEqual(arrange.waitingEntries(rt, beta.id), []);
  assert.equal(adapter.calls.filter((x) => x.sessionId === beta.id).length, 0, 'beta wasn’t woken');
  assert.equal(adapter.calls.filter((x) => x.sessionId === gamma.id).length, 1, 'gamma was');
  assert.equal(
    Object.values(store.state.inbox)
      .flat()
      .filter((e) => e.from === 'alpha').length,
    1,
  );
});
