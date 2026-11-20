// #1518: an agent @-mentioned with a question that answers without @-mentioning back left its asker asleep, and the
// room’s work stopped. A turn only agents’ mentions started, whose replies @-mention no one, goes back to the agents
// that woke it, once: a turn that bounce started goes back to no one (designs/intent.md, the agents-waking row).

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

/** Runs scripted turns until the room is quiet, however many wakes chain. @param {any} f */
async function quiet(f) {
  for (let i = 0; i < 20 && (f.rt.turns.size || f.rt.exiting.size || f.adapter.next.length); i++) await settle(f.rt);
  await settle(f.rt);
}

/** The person asks alpha, alpha asks beta, and beta answers with `answer`. */
async function askBeta(answer, { alphaAsks = '@beta which file holds the changelog?', after = [] } = {}) {
  const f = setup();
  f.adapter.next.push(async (c) => c.text(alphaAsks));
  f.adapter.next.push(async (c) => c.text(answer));
  for (const text of after) f.adapter.next.push(async (c) => c.text(text));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  return f;
}

test('#1518 a reply that @-mentions no one goes back to the agent whose mention woke it', async () => {
  const f = await askBeta('It’s CHANGELOG.md, at the root.', { after: ['Got it, adding the entry there.'] });
  const alpha = turnsOf(f, 'alpha');
  assert.equal(alpha.length, 2, turns(f).join('\n'));
  assert.match(alpha[1].message.text, /It’s CHANGELOG\.md, at the root\./, 'alpha is given beta’s reply');
  assert.equal(alpha[1].message.from, '@beta', 'as if beta had mentioned it');
  // beta was told where its reply goes, and how to hand off instead.
  assert.match(turnsOf(f, 'beta')[0].message.text, /Your reply posts there and goes back to @alpha\. @-mention another agent to hand off to them instead\./);
  // Shown where it happened: the reply says where it went, and why.
  assert.deepEqual(replyOf(f, 'It’s CHANGELOG.md, at the root.').wentBack, ['alpha']);
});

test('#1518 one bounce only: the reply to a reply that came back goes to no one', async () => {
  const f = await askBeta('It’s CHANGELOG.md.', { after: ['Thanks, got it.', 'You’re welcome.'] });
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha'],
    'beta never hears alpha’s thanks',
  );
  assert.equal(replyOf(f, 'Thanks, got it.').wentBack, undefined);
  assert.equal(f.adapter.next.length, 1, 'the last scripted reply was never asked for');
  // What the woken agent is told matches: its reply to a bounce goes back to no one.
  assert.match(turnsOf(f, 'alpha')[1].message.text, /Your reply posts there and goes to no one unless you @-mention an agent\./);
});

test('#1518 a reply that @-mentions anyone goes only where it says: a third agent wakes, and the asker doesn’t', async () => {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => c.text('@gamma you own the changelog: which file is it?'));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  // gamma’s own answer goes back to beta, whose mention woke it, and beta’s to that is the bounce’s, so it ends there.
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

test('#1518 a reply going back that waits on a card past the chain limit is still the one bounce once allowed', async () => {
  const f = setup();
  arrange.setThread(f.rt, f.t.id, { chainLimit: 1 });
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md.'));
  f.adapter.next.push(async (c) => c.text('Thanks, got it.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  f.rt.resolveHop(f.t.id, card.id, true);
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha'],
  );
  assert.match(turnsOf(f, 'alpha')[1].message.text, /goes to no one unless you @-mention an agent/);
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'hop' && x.status === 'open').length, 0, 'no second card');
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

test('#1518 a thanks that @-mentions back, after a reply came back, gets an answer that goes back to no one: no loop', async () => {
  // The demo’s @indexer thanks “@researcher” for its answer: without this, each answer went back and was thanked again.
  const f = await askBeta('It’s CHANGELOG.md.', { after: ['Thanks @beta, adding it there.', 'Glad to help.', 'Thanks @beta, again.', 'Glad to help, again.'] });
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha', 'beta'],
  );
  assert.equal(replyOf(f, 'Glad to help.').wentBack, undefined);
  assert.match(turnsOf(f, 'beta')[1].message.text, /Your reply posts there and goes to no one unless you @-mention an agent\./);
});

test('#1518 only a turn agents’ mentions alone woke comes from a bounce: with the person’s message, a scheduled wake or a review, it doesn’t', async () => {
  const { fromBounce } = await import('../server/reply-back.mjs');
  const bounce = { source: 'mention', from: 'beta', bounce: true };
  const notice = { source: 'notice' };
  assert.equal(fromBounce([bounce]), true);
  assert.equal(fromBounce([bounce, notice]), true, 'a notice rides along');
  assert.equal(fromBounce([bounce, { source: 'mention', from: 'gamma' }]), true, 'with another agent’s mention');
  assert.equal(fromBounce([bounce, { source: 'person', from: 'you' }]), false, 'the person’s message');
  assert.equal(fromBounce([bounce, { source: 'scheduled' }]), false, 'a scheduled wake');
  assert.equal(fromBounce([bounce, { source: 'review', from: 'gamma' }]), false, 'a review');
  assert.equal(fromBounce([{ source: 'mention', from: 'beta' }]), false, 'no bounce at all');
});

test('#1518 an open_topic written after a bounce is a bounce too: the answer in the topic goes back to no one', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md.'));
  f.adapter.next.push(async (c) => {
    const answer = replyOf(f, 'It’s CHANGELOG.md.');
    c.tools.open_topic({ itemId: answer.id, message: '@beta and which section?' });
    c.text('I asked beta in a topic.');
  });
  f.adapter.next.push(async (c) => c.text('Under Unreleased.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  await quiet(f);
  assert.deepEqual(
    turns(f).map((x) => x.split(':')[0]),
    ['alpha', 'beta', 'alpha', 'beta'],
  );
  const inTopic = Object.values(f.store.state.threads).find((x) => x.kind === 'topic');
  const answer = f.store.items(inTopic.id).find((x) => x.kind === 'agent' && x.text === 'Under Unreleased.');
  assert.ok(answer, 'beta answered in the topic');
  assert.equal(answer.wentBack, undefined);
});
