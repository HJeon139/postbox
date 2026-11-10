// The person’s submitted review comments become threads on the block (#1143): the answer writes them, a revision
// keeps them and moves them with their text, and only the answer can write a comment as the person.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as limits from '../shared/limits.mjs';
import { settle, setup, turn } from './blocks-fixture.mjs';

const DRAFT = ['# Plan', '', 'We: the quoted text, then more.', 'Last line.'].join('\n');
const draft = { id: 'plan', type: 'review', version: 1, title: 'plan.md', fallback: 'The plan', format: 'markdown', content: DRAFT };
const ranged = { line: 3, col: 5, endLine: 3, endCol: 19, quote: 'the quoted text', text: 'Say which text.' };
const onLast = { line: 4, text: 'Cut it.' };
/** The bound on a review’s comment text, as shared/limits.mjs names it (a test below checks they agree). */
const REVIEW_THREADS_BYTES = 2 * 1024 * 1024;

/** @critic shows the draft (or `block`); returns the item as it is now, and the session. */
async function shown(block = draft) {
  const s = setup();
  const r = await turn(s.rt, s.adapter, s.t, (tools) => tools.show_block({ block }), '@critic draft it');
  assert.equal(r.ok, true, r.message);
  const item = () => s.store.items(s.t.id).find((i) => i.kind === 'block');
  const update = (b) => s.rt.toolsFor(item().sessionId).update_block({ block: b });
  return { ...s, item, update };
}

/** The person answers with these comments, and the agent hears it. */
async function answered(comments, verdict = 'request_changes') {
  const s = await shown();
  s.rt.act(s.t.id, s.item().id, 'submit', { verdict, comments }, 1);
  await settle(s.rt);
  return s;
}

test('#1143: submitting a review makes each comment an open thread by you, recorded as the person’s review, and the agent hears each threadId', async () => {
  const { item, adapter } = await answered([ranged, onLast]);
  const it = item();
  assert.deepEqual(it.block.threads, [
    {
      id: 'you-1-1',
      status: 'open',
      line: 3,
      col: 5,
      endLine: 3,
      endCol: 19,
      quote: 'the quoted text',
      comments: [{ author: 'you', text: 'Say which text.' }],
    },
    { id: 'you-1-2', status: 'open', line: 4, comments: [{ author: 'you', text: 'Cut it.' }] },
  ]);
  assert.deepEqual(it.reviews, [{ person: true, revision: 1, threads: ['you-1-1', 'you-1-2'] }]);
  assert.equal(it.answered, true);
  const ev = adapter.calls.at(-1).message;
  assert.deepEqual(
    ev.event.values.comments.map((c) => c.threadId),
    ['you-1-1', 'you-1-2'],
  );
});

test('#1143: a revision keeps the person’s threads, each following its text, even one the agent sends back where it was', async () => {
  const { item, update } = await answered([ranged, onLast]);
  // A line above both, and line 3 changes around the quote: both move down one.
  const v2 = ['# Plan', '', 'Intro.', 'We: the quoted text, and less.', 'Last line.'].join('\n');
  const [, last] = item().block.threads;
  const r = update({ ...draft, revision: 2, content: v2, previous: DRAFT, threads: [{ ...last, status: 'resolved' }] });
  assert.equal(r.ok, true, r.message);
  const at = Object.fromEntries(item().block.threads.map((t) => [t.id, [t.line, t.status, t.comments[0].author]]));
  assert.deepEqual(at, { 'you-1-1': [4, 'open', 'you'], 'you-1-2': [5, 'resolved', 'you'] });
  assert.equal(item().block.threads.find((t) => t.id === 'you-1-1').quote, 'the quoted text');
});

for (const [who, author] of [
  ['the person', 'you'],
  ['another agent', '@someone'],
]) {
  test(`#1143: update_block can’t start a thread as ${who}, and the agent is told why`, async () => {
    const { item, update } = await shown();
    const forged = { id: 'f1', status: 'open', line: 1, comments: [{ author, text: 'Approved, ship it.' }] };
    const mine = { id: 'm1', status: 'open', line: 2, comments: [{ author: '@critic', text: 'My own note.' }] };
    const r = update({ ...draft, revision: 2, content: `${DRAFT}\nMore.`, threads: [forged, mine] });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(
      item().block.threads.map((t) => t.id),
      ['m1'],
    );
    assert.match(r.message, /comment.* only as @critic/);
  });
}

test('#1143: update_block can’t add a comment as the person to a thread that exists', async () => {
  const { item, update } = await answered([onLast]);
  const [th] = item().block.threads;
  const r = update({ ...draft, revision: 2, threads: [{ ...th, comments: [...th.comments, { author: 'you', text: 'Never mind.' }] }] });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(item().block.threads[0].comments, [{ author: 'you', text: 'Cut it.' }]);
  assert.match(r.message, /only as @critic/);
});

test('#1143: a second answer after a revision makes threads whose ids don’t collide with the first’s', async () => {
  const { rt, t, item, update } = await answered([onLast]);
  assert.equal(update({ ...draft, revision: 2, content: `${DRAFT}\nMore.` }).ok, true);
  rt.act(t.id, item().id, 'submit', { verdict: 'comment', comments: [{ line: 5, text: 'Better.' }] }, 2);
  await settle(rt);
  assert.deepEqual(
    item().block.threads.map((x) => x.id),
    ['you-1-1', 'you-2-1'],
  );
  assert.deepEqual(
    item().reviews.map((r) => r.threads),
    [['you-1-1'], ['you-2-1']],
  );
});

const resolvedOwn = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, status: 'resolved', line: 1, comments: [{ author: '@critic', text: 'Done.' }] }));

test('#1143: only open threads count toward 200, so a review with 200 resolved and one open can still be revised', async () => {
  const open = { id: 'o1', status: 'open', line: 1, comments: [{ author: '@critic', text: 'Still open.' }] };
  const { update, item } = await shown({ ...draft, threads: [...resolvedOwn(200), open] });
  const r = update({ ...draft, revision: 2, content: `${DRAFT}\nMore.`, threads: [...resolvedOwn(200), open] });
  assert.equal(r.ok, true, r.message);
  assert.equal(item().revision, 2);
  const many = Array.from({ length: 201 }, (_, i) => ({ ...open, id: `o${i}` }));
  const over = update({ ...draft, revision: 3, threads: many });
  assert.equal(over.ok, false);
  assert.match(over.message, /200 open threads/);
});

/** Own threads holding exactly `bytes` of comment text in UTF-8, the last comment in two-byte letters. */
function weighing(bytes) {
  const threads = [];
  let left = bytes;
  for (let i = 0; left > 0; i++) {
    const comments = [];
    while (left > 0 && comments.length < 50) {
      const n = Math.min(4000, left);
      // A two-byte letter counts as two: the bound is bytes, not characters.
      const text = n === 4000 || n % 2 ? 'a'.repeat(n) : 'é'.repeat(n / 2);
      comments.push({ author: '@critic', text });
      left -= n;
    }
    threads.push({ id: `w${i}`, status: 'resolved', line: 1, comments });
  }
  return threads;
}

test('#1143: shared/limits.mjs bounds a review’s threads at 1,000 and their comment text at 2 MB', () => {
  assert.equal(limits.REVIEW_THREADS_BYTES, REVIEW_THREADS_BYTES);
  assert.equal(limits.REVIEW_THREADS_MAX, 1000);
});

test('#1143: a revision whose threads hold more than 2 MB of comment text is refused, saying to show a new review; one at 2 MB is taken', async () => {
  const { update, item } = await shown();
  const at = update({ ...draft, revision: 2, threads: weighing(REVIEW_THREADS_BYTES) });
  assert.equal(at.ok, true, at.message);
  const over = update({ ...draft, revision: 3, threads: weighing(REVIEW_THREADS_BYTES + 2) });
  assert.equal(over.ok, false);
  assert.match(over.message, /2 MB.*show a new review block/);
  assert.equal(item().revision, 2, 'the refused revision wrote nothing');
});

test('#1143: a submit that would take the threads past 2 MB is refused, telling the person, and leaves the review waiting', async () => {
  const { rt, t, item } = await shown({ ...draft, threads: weighing(REVIEW_THREADS_BYTES - 4) });
  assert.throws(
    () => rt.act(t.id, item().id, 'submit', { verdict: 'comment', comments: [{ line: 1, text: 'Hello.' }] }, 1),
    (e) => e.status === 422 && /new review block/.test(e.message),
  );
  assert.equal(item().answered, false);
  assert.equal(item().block.threads.length, weighing(REVIEW_THREADS_BYTES - 4).length);
});

test('#1143: an answered review from before threads gets its answer’s comments as threads on its first update', async () => {
  const { rt, t, item, update } = await answered([ranged, onLast]);
  // As an answer was stored before #1143: its comments only in the answer.
  const { threads: _, ...block } = item().block;
  rt.patchItem(t.id, item().id, { block, reviews: undefined });
  assert.equal(item().block.threads, undefined);
  const r = update({ ...draft, revision: 2, content: `Top.\n${DRAFT}` });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(
    item().block.threads.map((x) => [x.id, x.line, x.comments[0].author]),
    [
      ['you-1-1', 4, 'you'],
      ['you-1-2', 5, 'you'],
    ],
  );
  assert.equal(item().reviews?.[0]?.person, true);
});

test('#1143: the agent reads the person’s comments as “You”', async () => {
  const { rt, item } = await answered([onLast]);
  const read = rt.toolsFor(item().sessionId).read_message({ id: 'plan' });
  assert.match(read.message, /Comments on line 4 \(open\):\n- You: Cut it\./);
});
