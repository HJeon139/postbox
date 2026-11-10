// Reviews stored before #1143’s author rule: a comment its agent wrote in another name (the demo’s mock wrote “You”)
// reads as that agent’s, so the person’s submit and the agent’s revision still land. Moved out of
// review-person.test.mjs, at its size ceiling.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup, turn } from './blocks-fixture.mjs';

const DRAFT = ['# Plan', '', 'We: the quoted text, then more.', 'Last line.'].join('\n');
const draft = { id: 'plan', type: 'review', version: 1, title: 'plan.md', fallback: 'The plan', format: 'markdown', content: DRAFT };

/** @critic shows the draft; returns the item as it is now, and the session. */
async function shown() {
  const s = setup();
  const r = await turn(s.rt, s.adapter, s.t, (tools) => tools.show_block({ block: draft }), '@critic draft it');
  assert.equal(r.ok, true, r.message);
  const item = () => s.store.items(s.t.id).find((i) => i.kind === 'block');
  const update = (b) => s.rt.toolsFor(item().sessionId).update_block({ block: b });
  return { ...s, item, update };
}

/** A review stored before the author rule, with a thread its agent wrote in the person’s name, as the demo’s mock did. */
async function legacy() {
  const s = await shown();
  const threads = [
    {
      id: 'c1',
      status: 'open',
      line: 4,
      comments: [
        { author: 'You', text: 'Cut it.' },
        { author: '@critic', text: 'Done.' },
      ],
    },
  ];
  s.rt.patchItem(s.t.id, s.item().id, { block: { ...s.item().block, threads } });
  return s;
}

test('#1143: a review stored with an author outside the rule still takes the person’s submit, its comment named for its agent', async () => {
  const s = await legacy();
  s.rt.act(s.t.id, s.item().id, 'submit', { verdict: 'request_changes', comments: [{ line: 3, text: 'And this.' }] }, 1);
  await settle(s.rt);
  const authors = s.item().block.threads.flatMap((t) => t.comments.map((c) => c.author));
  assert.deepEqual(authors, ['@critic', '@critic', 'you'], 'the old “You” was its agent’s words, so it reads as its agent’s');
});

test('#1143: a review stored with an author outside the rule can still be revised', async () => {
  const s = await legacy();
  // Its agent’s own thread, sent back with what it holds now: the old “You” reads as the agent’s.
  const threads = [
    {
      id: 'c1',
      status: 'resolved',
      line: 4,
      comments: [
        { author: '@critic', text: 'Cut it.' },
        { author: '@critic', text: 'Done.' },
      ],
    },
  ];
  const r = s.update({ ...draft, content: `${DRAFT}\nMore.`, threads });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(
    s.item().block.threads.map((t) => [t.status, t.comments.map((c) => c.author)]),
    [['resolved', ['@critic', '@critic']]],
  );
});

test('#1143: an old answered review with an author outside the rule still takes its agent’s outcome', async () => {
  const s = await legacy();
  s.rt.act(s.t.id, s.item().id, 'submit', { verdict: 'approve', comments: [] }, 1);
  await settle(s.rt);
  // Its agent reads the answer in a turn, then reports what came of it.
  const r = await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: { id: 'plan', outcome: 'Filed as #1.' } }), '@critic report it');
  assert.equal(r.ok, true, r.message);
  assert.equal(s.item().block.outcome, 'Filed as #1.');
  assert.deepEqual(
    s.item().block.threads[0].comments.map((c) => c.author),
    ['@critic', '@critic'],
  );
});

test('#1143: an agent reads an old review’s off-rule author as its own, and can send it back as read', async () => {
  const s = await legacy();
  const read = String(s.rt.describeItem(s.item()));
  assert.match(read, /- @critic: Cut it\./, 'read as its agent’s');
  assert.doesNotMatch(read, /- You: Cut it\./, 'never as the person’s');
  const threads = [
    {
      id: 'c1',
      status: 'resolved',
      line: 4,
      comments: [
        { author: '@critic', text: 'Cut it.' },
        { author: '@critic', text: 'Done.' },
      ],
    },
  ];
  const r = s.update({ ...draft, content: `${DRAFT}\nMore.`, threads });
  assert.equal(r.ok, true, r.message);
});

test('#1143: an off-rule author sent back is refused with what to do instead', async () => {
  const s = await legacy();
  const threads = [{ id: 'c1', status: 'resolved', line: 4, comments: [{ author: 'You', text: 'Cut it.' }] }];
  const r = s.update({ ...draft, content: `${DRAFT}\nMore.`, threads });
  assert.equal(r.ok, false);
  assert.match(r.message, /send stored comments back as read_message shows them, or leave them out/);
});
