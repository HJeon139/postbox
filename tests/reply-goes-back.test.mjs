// #1518: an agent @-mentioned with a question that answers without @-mentioning back left its asker asleep, and the
// room’s work stopped. A turn only agents’ mentions started, whose replies @-mention no one, goes back to the agents
// that woke it. #1523: every time, however many bounces came before; an agent ends the exchange with a reaction, or
// with its second reply in a row that only writes (#1591), and the room’s chain limit is the backstop
// (designs/intent.md, the agents-waking row).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** Each turn the adapter ran, as “handle: what it was given”, in order. @param {any} f */
const turns = (f) => f.adapter.calls.map((c) => `${c.handle}: ${c.message.text}`);
/** The turns one agent ran. @param {any} f @param {string} handle */
const turnsOf = (f, handle) => f.adapter.calls.filter((c) => c.handle === handle);
/** The agent’s reply that says text. @param {any} f @param {string} text */
const replyOf = (f, text) => f.store.items(f.t.id).find((x) => x.kind === 'agent' && x.text === text);

/**
 * A turn that ends the exchange as the room guide asks: a 👍 on the last message another agent wrote in its thread, and
 * no reply. @param {any} f
 */
const reacts = (f) => async (/** @type {any} */ c, /** @type {any} */ _m, /** @type {any} */ se) => {
  const last = f.store.items(c.thread.id).findLast((x) => x.kind === 'agent' && x.sessionId !== se.id && x.text);
  const r = c.tools.react({ id: last.id, emoji: '👍' });
  assert.equal(r.ok, true, r.message);
};

/** Runs scripted turns until the room is quiet, however many wakes chain. @param {any} f */
async function quiet(f) {
  for (let i = 0; i < 20 && (f.rt.turns.size || f.rt.exiting.size || f.adapter.next.length); i++) await settle(f.rt);
  await settle(f.rt);
}

test('#1518 a reply that @-mentions no one goes back to the agent whose mention woke it', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md, at the root.'));
  f.adapter.next.push(reacts(f));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  const alpha = turnsOf(f, 'alpha');
  assert.equal(alpha.length, 2, turns(f).join('\n'));
  assert.match(alpha[1].message.text, /It’s CHANGELOG\.md, at the root\./, 'alpha is given beta’s reply');
  assert.equal(alpha[1].message.from, '@beta', 'as if beta had mentioned it');
  // beta was told where its reply goes, and how to hand off instead.
  assert.match(turnsOf(f, 'beta')[0].message.text, /Your reply posts there and goes back to @alpha\. @-mention another agent to hand off to them instead\./);
  // Shown where it happened: the reply says where it went, and why.
  assert.deepEqual(replyOf(f, 'It’s CHANGELOG.md, at the root.').wentBack, ['alpha']);
});

test('#1523, #1591 replies that name no one go back and forth, until an agent’s second in a row that only writes', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  for (const text of ['It’s CHANGELOG.md.', 'Which section?', 'Under Unreleased.', 'Done, it’s there.']) f.adapter.next.push(async (c) => c.text(text));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha', 'beta', 'alpha'],
  );
  assert.deepEqual(replyOf(f, 'It’s CHANGELOG.md.').wentBack, ['alpha']);
  // The follow-up question and its answer are each an agent’s first reply that only writes, so both are delivered.
  assert.deepEqual(replyOf(f, 'Which section?').wentBack, ['beta']);
  assert.deepEqual(replyOf(f, 'Under Unreleased.').wentBack, ['alpha']);
  // alpha’s second in a row posts, and wakes no one: no reaction was needed to end it.
  assert.equal(replyOf(f, 'Done, it’s there.').wentBack, undefined);
  assert.equal(f.rt.turns.size, 0, 'no one is woken');
  // Each woken agent is told where its reply goes: after a bounce as before one, until its last reply only wrote.
  assert.match(turnsOf(f, 'alpha')[1].message.text, /Your reply posts there and goes back to @beta\. @-mention another agent to hand off to them instead\./);
  assert.match(
    turnsOf(f, 'alpha')[2].message.text,
    /Your reply posts there\. Your last reply to @beta only wrote, so this one goes back to @beta only if you do work this turn/,
  );
});

test('#1523 a reaction ends a chain where a reply would go on: after two bounces, a turn that only reacts wakes no one', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md.'));
  // A reply here, after a bounce, goes back to beta: one bounce per chain (#1518) would have stopped it.
  f.adapter.next.push(async (c) => c.text('Which section?'));
  f.adapter.next.push(reacts(f));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha', 'beta'],
  );
  assert.deepEqual(replyOf(f, 'Which section?').wentBack, ['beta']);
  // beta reacted to it instead, which posts nothing, so the chain ends with no failed reply and no one woken.
  assert.deepEqual(
    replyOf(f, 'Which section?').reactions.map((r) => `${r.handle} ${r.emoji}`),
    ['beta 👍'],
  );
  assert.ok(!f.store.items(f.t.id).some((x) => x.kind === 'agent' && x.handle === 'beta' && x.turnId && !x.text?.trim()), 'no empty or failed reply');
  assert.equal(f.adapter.next.length, 0);
  assert.equal(f.rt.turns.size, 0, 'no one is woken');
});

test('#1523 a turn that reacts and streams only whitespace posts no reply, so nothing goes back', async () => {
  // A harness can stream blank text around a tool call: “ \n\n ” is no reply, and must not carry the chain on.
  const f = setup();
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md.'));
  f.adapter.next.push(async (c, m, se) => {
    await reacts(f)(c, m, se);
    c.text(' \n\n ');
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha'],
  );
  assert.ok(!f.store.items(f.t.id).some((x) => x.wentBack && !x.text.trim()), 'no blank item went back');
  assert.equal(f.rt.turns.size, 0, 'no one is woken');
});

test('#1518 a reply that @-mentions anyone goes only where it says: a third agent wakes, and the asker doesn’t', async () => {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => c.text('@gamma you own the changelog: which file is it?'));
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md.'));
  f.adapter.next.push(reacts(f));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  // gamma’s own answer goes back to beta, whose mention woke it, and beta ends it with a reaction.
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'gamma', 'beta'],
  );
  assert.equal(replyOf(f, '@gamma you own the changelog: which file is it?').wentBack, undefined);
});

test('#1518 a mention in a quote, in code or in a copied line names no one, so the reply still goes back', async () => {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => {
    // A copy of alpha’s own line, as Postbox gave it, wakes no one either (server/copied-line.mjs).
    const asked = f.store.items(f.t.id).find((x) => x.kind === 'agent' && x.handle === 'alpha');
    c.text(`> @gamma said it’s CHANGELOG.md\n\nRun \`@gamma check\` to see.\n\n[${asked.id}] @alpha: @beta which file holds the changelog?`);
  });
  f.adapter.next.push(reacts(f));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha'],
    'gamma isn’t woken, and alpha is',
  );
});

test('#1518 the chain limit counts the reply that goes back, and past it the wake waits for the person', async () => {
  const f = setup();
  arrange.setThread(f.rt, f.t.id, { chainLimit: 1 });
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  assert.equal(turnsOf(f, 'alpha').length, 1, 'alpha isn’t woken past the limit');
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop');
  assert.equal(card?.status, 'open', 'a card asks the person, as for any wake past the limit');
  assert.deepEqual([card.from, card.to, card.n], ['beta', 'alpha', 2]);
  assert.equal(replyOf(f, 'It’s CHANGELOG.md.').wentBack, undefined, 'the note waits for it to go: the card shows it till then');
});

test('#1518 a reply going back that is held on a waiting card says so as a reply, not as a mention its agent wrote', async () => {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  arrange.setThread(f.rt, f.t.id, { chainLimit: 2 });
  f.adapter.next.push(async (c) => c.text('@beta @gamma which file holds the changelog?'));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  // beta’s answer going back raised the card; gamma’s waits on it.
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  assert.equal(card.held?.length, 1, JSON.stringify(card));
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.handle === 'gamma');
  const told = (f.store.state.sessions[gamma.id].context ?? []).join(' | ');
  assert.match(told, /Your message to @alpha is held\./);
  assert.doesNotMatch(told, /Your mention of @alpha/);
});

test('#1518 a turn that opens a topic naming an agent hands off, so its reply doesn’t go back', async () => {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => {
    const asked = f.store.items(f.t.id).find((x) => x.kind === 'agent' && x.handle === 'alpha');
    c.tools.open_topic({ itemId: asked.id, message: '@gamma you own the changelog: which file is it?' });
    c.text('I asked gamma in a topic.');
  });
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md.'));
  f.adapter.next.push(reacts(f));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  assert.equal(turnsOf(f, 'alpha').length, 1, turns(f).join('\n'));
  assert.ok(turnsOf(f, 'gamma').length >= 1, 'gamma was woken in the topic');
  assert.equal(replyOf(f, 'I asked gamma in a topic.').wentBack, undefined);
});

test('#1518 a turn the person started goes back to no one', async () => {
  const f = setup();
  f.rt.sendMessage(f.t.id, { text: '@beta what’s in the changelog?' });
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['beta'],
  );
  assert.ok(!f.store.items(f.t.id).some((x) => x.wentBack));
});

test('#1523 a thanks loop stops at the chain limit and waits for the person, and goes on when allowed', async () => {
  // The demo’s @indexer thanked “@researcher” for each answer, and each thanks was answered: chaining goes on until
  // an agent reacts instead, or the chain limit asks the person.
  const f = setup();
  arrange.setThread(f.rt, f.t.id, { chainLimit: 4 });
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  for (const text of ['It’s CHANGELOG.md.', 'Thanks @beta, adding it there.', 'Glad to help.', 'Thanks @beta, again.', 'Glad to help, again.']) {
    f.adapter.next.push(async (c) => c.text(text));
  }
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha', 'beta', 'alpha'],
  );
  assert.deepEqual(replyOf(f, 'Glad to help.').wentBack, ['alpha']);
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  assert.deepEqual([card?.from, card?.to, card?.n], ['alpha', 'beta', 5], 'the fifth wake waits for the person');
  f.adapter.next.push(reacts(f));
  f.rt.resolveHop(f.t.id, card.id, true);
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha', 'beta', 'alpha', 'beta', 'alpha'],
    'allowed, beta answers, and alpha ends it with a reaction',
  );
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'hop' && x.status === 'open').length, 0);
});

test('#1518 a turn that reviews the asker’s block hands off by the review, so its reply doesn’t go back too', async () => {
  // The showcase replays: @builder hands @critic its app, and @critic answers with comments on its block.
  const f = setup();
  const block = { id: 'plan', type: 'review', version: 1, title: 'plan.md', fallback: 'The plan', format: 'markdown', content: '# Plan\n\nShip it.' };
  f.adapter.next.push(async (c) => {
    c.tools.show_block({ block });
    c.text('@beta please review the plan.');
  });
  f.adapter.next.push(async (c) => {
    const r = await c.tools.review_block({ blockId: 'plan', comments: [{ line: 3, col: 1, endLine: 3, endCol: 7, quote: 'Ship it', text: 'When?' }] });
    assert.equal(r.ok, true, r.message);
    c.text('One comment on your plan.');
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha write the plan' });
  await quiet(f);
  const alpha = turnsOf(f, 'alpha');
  assert.equal(alpha.length, 2, turns(f).join('\n'));
  assert.equal(alpha[1].message.kind, 'event', 'alpha’s next turn is the review, not a bounce');
  assert.equal(replyOf(f, 'One comment on your plan.').wentBack, undefined);
});

test('#1523 a reply that came back counts as that agent’s mention: the answer to it goes back, unless the turn took anything else', async () => {
  const { backTo } = await import('../server/reply-back.mjs');
  const bounce = { source: 'mention', from: 'beta', bounce: true };
  assert.deepEqual(backTo([bounce]), ['beta']);
  assert.deepEqual(backTo([bounce, { source: 'notice' }]), ['beta'], 'a notice rides along');
  assert.deepEqual(backTo([bounce, { source: 'mention', from: 'gamma' }]), ['beta', 'gamma'], 'with another agent’s mention');
  assert.deepEqual(backTo([bounce, { source: 'person', from: 'you' }]), [], 'the person’s message');
  assert.deepEqual(backTo([bounce, { source: 'scheduled' }]), [], 'a scheduled wake');
  assert.deepEqual(backTo([bounce, { source: 'review', from: 'gamma' }]), [], 'a review');
});

test('#1523 an open_topic written after a bounce wakes as any mention: the answer in the topic goes back', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md.'));
  f.adapter.next.push(async (c) => {
    const answer = replyOf(f, 'It’s CHANGELOG.md.');
    c.tools.open_topic({ itemId: answer.id, message: '@beta and which section?' });
    c.text('I asked beta in a topic.');
  });
  f.adapter.next.push(async (c) => c.text('Under Unreleased.'));
  f.adapter.next.push(reacts(f));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha', 'beta', 'alpha'],
  );
  const inTopic = Object.values(f.store.state.threads).find((x) => x.kind === 'topic');
  const answer = f.store.items(inTopic.id).find((x) => x.kind === 'agent' && x.text === 'Under Unreleased.');
  assert.deepEqual(answer?.wentBack, ['alpha']);
});
