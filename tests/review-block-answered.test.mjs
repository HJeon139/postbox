// #716: a reviewer’s review_block on a review the person already answered. In the #508 room, design reads of approved
// pages went into the room as prose, apart from the block they discussed, because review_block refused once the block
// was answered. Now the comments land on it as threads, under the person’s answer, without reopening it; its agent
// hears them. A review its agent withdrew still takes none (tests/review-block.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { formatMessage } from '../server/adapters/guide.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

const draft = {
  id: 'plan',
  type: 'review',
  version: 1,
  title: 'plan.md',
  fallback: 'The plan',
  format: 'markdown',
  content: '# Plan\n\nWe index first.\nLast line.',
};

function setup(onDeliver = () => {}) {
  const store = new Store(null);
  /** @type {any[]} */
  const heard = [];
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {},
      fork() {},
      async deliver(_s, m) {
        heard.push(m);
        await onDeliver(m);
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const personas = ['researcher', 'critic'].map((handle) => rt.createPersona({ handle }).id);
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: personas });
  const [mine, theirs] = ['researcher', 'critic'].map((h) => arrange.agentIn(rt, t.id, h));
  assert.equal(rt.toolsFor(mine.id).show_block({ block: draft }).ok, true);
  const item = () => store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'plan');
  return { store, rt, t, mine, theirs, item, heard };
}

test('#716 a reviewer comments on a review the person already answered: the threads land, and the answer stands', async () => {
  const { rt, t, theirs, item, heard } = setup();
  rt.act(t.id, item().id, 'submit', { verdict: 'approve', comments: [] }, 1);
  const answer = item().answer;

  const r = rt.toolsFor(theirs.id).review_block({ blockId: 'plan', verdict: 'comment', comments: [{ line: 3, text: 'A read of the approved design.' }] });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /The person already answered it, and your comments don’t reopen it\./);
  assert.deepEqual(
    item().block.threads.map((th) => [th.line, th.comments[0].author, th.comments[0].text]),
    [[3, '@critic', 'A read of the approved design.']],
  );
  assert.equal(item().answered, true, 'still answered');
  assert.deepEqual(item().answer, answer, 'the answer as the person gave it');
  assert.deepEqual(
    item().reviews.map((rv) => [rv.handle, rv.verdict]),
    [['critic', 'comment']],
  );
  // The block’s agent hears it in a turn of its own.
  const review = () => heard.find((m) => m.kind === 'event' && m.event?.action === 'review');
  for (let i = 0; i < 100 && !review(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(review()?.event.values.comments[0].text, 'A read of the approved design.');
  // Told the person answered it, so a reply or a revision would ask them again; not to revise as if it still waited on them.
  const said = formatMessage(review());
  assert.match(
    said,
    /The person already answered this block: changing only status to “resolved” in update_block’s threads\? keeps their answer; adding a reply, changing its content or sending it back unchanged asks them again\./,
  );
  assert.doesNotMatch(said, /still waits on the person/);
});

test('#716 after a reviewer comments on an answered review, a status-only resolve keeps the answer while a reply or content change asks again, and a dismissed review refuses comments', async () => {
  const { rt, t, mine, theirs, item, heard } = setup();
  rt.act(t.id, item().id, 'submit', { verdict: 'approve', comments: [] }, 1);
  const answer = item().answer;
  for (let i = 0; i < 100 && !heard.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [{ line: 3, text: 'Note.' }] }).ok, true);

  const resolved = item().block.threads.map((th) => ({ ...th, status: 'resolved' }));
  const kept = rt.toolsFor(mine.id).update_block({ block: { ...draft, threads: resolved } });
  assert.equal(kept.ok, true, kept.message);
  assert.match(kept.message, /stays answered/);
  assert.equal(item().answered, true);
  assert.deepEqual(item().answer, answer);
  assert.equal(item().block.threads[0].status, 'resolved');

  const replied = rt.toolsFor(mine.id).update_block({
    block: { ...draft, threads: [{ ...resolved[0], comments: [...resolved[0].comments, { author: '@researcher', text: 'Done.' }] }] },
  });
  assert.equal(replied.ok, true, replied.message);
  assert.match(replied.message, /asks again/);
  assert.equal(item().answered, false);
  assert.equal(item().revision, 2);

  // Dismissed by the person: closed, so review_block refuses it.
  rt.act(t.id, item().id, 'dismiss', {}, 2);
  assert.equal(item().closed?.by, 'person');
  const dismissed = rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [{ line: 1, text: 'More.' }] });
  assert.equal(dismissed.ok, false);
  assert.match(dismissed.message, /@researcher’s plan is closed, so it takes no more comments/);
});

test('#716 answered on the review event is read when the turn takes the entry, not when review_block ran', async () => {
  let releaseAnswer = () => {};
  const { rt, t, mine, theirs, item, heard } = setup(async (m) => {
    if (m.kind === 'event' && m.event?.action === 'submit') await new Promise((r) => (releaseAnswer = r));
  });
  rt.act(t.id, item().id, 'submit', { verdict: 'approve', comments: [] }, 1);
  for (let i = 0; i < 100 && !heard.length; i++) await new Promise((r) => setTimeout(r, 5));
  // While the answer’s turn is running, @critic reviews the answered block, then @researcher revises it in that turn.
  assert.equal(rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [{ line: 3, text: 'Note.' }] }).ok, true);
  assert.equal(rt.toolsFor(mine.id).update_block({ block: { ...draft, content: '# Plan\n\nRevised.' } }).ok, true);
  assert.equal(item().answered, false);
  releaseAnswer();
  const review = () => heard.find((m) => m.kind === 'event' && m.event?.action === 'review');
  for (let i = 0; i < 100 && !review(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(review()?.event.answered, undefined);
  assert.match(formatMessage(review()), /still waits on the person/);
});

test('#716 a review withdrawn after a reviewer commented is delivered as closed: no answer to keep, and any update asks again', async () => {
  let releaseAnswer = () => {};
  const { rt, t, mine, theirs, item, heard } = setup(async (m) => {
    if (m.kind === 'event' && m.event?.action === 'submit') await new Promise((r) => (releaseAnswer = r));
  });
  rt.act(t.id, item().id, 'submit', { verdict: 'approve', comments: [] }, 1);
  for (let i = 0; i < 100 && !heard.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [{ line: 3, text: 'Note.' }] }).ok, true);
  // In the answer’s turn, @researcher withdraws the block before the review reaches it.
  assert.equal(rt.toolsFor(mine.id).update_block({ block: { id: 'plan', withdraw: 'Handled in the room.' } }).ok, true);
  assert.ok(item().closed);
  releaseAnswer();
  const review = () => heard.find((m) => m.kind === 'event' && m.event?.action === 'review');
  for (let i = 0; i < 100 && !review(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([review()?.event.answered, review()?.event.closed], [undefined, true]);
  const said = formatMessage(review());
  assert.match(
    said,
    /This block is closed, so it no longer asks the person: any update_block to it but an outcome, even one that only resolves a comment, asks them again\./,
  );
  assert.doesNotMatch(said, /keeps their answer|still waits on the person/);
  // The one update that doesn’t ask again: an outcome under the person’s answer.
  assert.equal(rt.toolsFor(mine.id).update_block({ block: { id: 'plan', outcome: 'Merged as is.' } }).ok, true);
  assert.equal(item().answered, true);
});

test('#716 sending an answered review back unchanged, after a reviewer commented, asks the person again, as its note says', async () => {
  const { rt, t, mine, theirs, item, heard } = setup();
  rt.act(t.id, item().id, 'submit', { verdict: 'approve', comments: [] }, 1);
  for (let i = 0; i < 100 && !heard.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(rt.toolsFor(theirs.id).review_block({ blockId: 'plan', comments: [{ line: 3, text: 'Note.' }] }).ok, true);
  // The draft as it was first shown: the reviewer’s threads stay on it either way (#133).
  const same = rt.toolsFor(mine.id).update_block({ block: draft });
  assert.equal(same.ok, true, same.message);
  assert.equal(item().answered, false);
});
