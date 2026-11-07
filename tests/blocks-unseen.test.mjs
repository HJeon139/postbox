// #593: an update to a block that’s still waiting, which changes nothing the person sees, doesn’t raise its revision
// (server/blocks.mjs, updateBlock). It used to, so the person’s answer was refused as stale and the review showed
// “Changes since you looked” over an empty diff.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { review, settle, setup, turn } from './blocks-fixture.mjs';
import { setup as filesSetup, png, reviewBlock } from './review-files-fixture.mjs';

const thread = (status, text = 'Is this the right heading?') => ({ id: 't1', line: 1, status, comments: [{ author: '@critic', text }] });
const draft = (more = {}) => ({ ...review, threads: [thread('open')], ...more });

/** The agent shows the draft; returns the block’s item and a way to read it again. */
async function shown() {
  const s = setup();
  await turn(s.rt, s.adapter, s.t, (tools) => tools.show_block({ block: draft() }));
  const id = s.store.items(s.t.id).find((i) => i.kind === 'block').id;
  return { ...s, id, now: () => s.store.item(s.t.id, id) };
}
const moves = (s) => s.store.items(s.t.id).filter((i) => i.kind === 'stub').length;

test('#593 an identical update to a waiting review keeps its revision, stays in place, and the person’s answer to it counts', async () => {
  const s = await shown();
  const r = await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: draft() }));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.message, `Nothing in ${review.id} changed, so it still waits on the person as it was.`);
  assert.equal(s.now().revision ?? 1, 1);
  assert.equal(moves(s), 0, 'nothing moved to the newest point');
  s.rt.act(s.t.id, s.id, 'submit', { verdict: 'approve', comments: [] }, 1);
  await settle(s.rt);
  assert.equal(s.now().answered, true);
  assert.equal(s.now().answer.values.verdict, 'approve');
});

test('#593 resolving a thread on a waiting review shows the resolve in place, with no new revision', async () => {
  const s = await shown();
  const r = await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: draft({ threads: [thread('resolved')] }) }));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.message, `Updated the threads’ status of ${review.id}; it still waits on the person as it was, since nothing they’d answer changed.`);
  assert.equal(s.now().revision ?? 1, 1);
  assert.equal(s.now().block.threads[0].status, 'resolved');
  assert.equal(moves(s), 0);
});

test('#593 a new fallback on a waiting block is written in place, with no new revision', async () => {
  const s = await shown();
  const r = await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: draft({ fallback: 'The draft issue, v2' }) }));
  assert.equal(r.message, `Updated the fallback of ${review.id}; it still waits on the person as it was, since nothing they’d answer changed.`);
  assert.equal(s.now().revision ?? 1, 1);
  assert.equal(s.now().block.fallback, 'The draft issue, v2');
});

test('#593 a real change still raises the revision, also when it comes with a resolve', async () => {
  const s = await shown();
  await turn(s.rt, s.adapter, s.t, (tools) =>
    tools.update_block({ block: draft({ content: '# Draft\n\nSeen on 22 October.', threads: [thread('resolved')] }) }),
  );
  assert.equal(s.now().revision, 2);
  assert.equal(s.now().block.content, '# Draft\n\nSeen on 22 October.');
});

test('#593 new words in a thread are something the person sees, so they raise the revision', async () => {
  const s = await shown();
  await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: draft({ threads: [thread('open', 'Is this the right title?')] }) }));
  assert.equal(s.now().revision, 2);
});

// Only a block that’s still waiting: an identical update to an answered one asks again on purpose (eb48fd94, #286).
test('#593 an identical update after the person answered still asks again, so the rule is only for a waiting block', async () => {
  const s = await shown();
  await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: draft() }));
  s.rt.act(s.t.id, s.id, 'submit', { verdict: 'approve', comments: [] }, 1);
  await settle(s.rt);
  const r = await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: draft() }));
  assert.match(r.message, /asks again/);
  assert.equal(s.now().answered, false);
  assert.equal(s.now().revision, 2);
});

test('#593 an identical update to a withdrawn block still asks again, as an update to it does', async () => {
  const s = await shown();
  await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: { id: review.id, withdraw: 'Not needed.' } }));
  assert.ok(s.now().closed);
  await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: draft() }));
  assert.equal(s.now().closed, null);
  assert.equal(s.now().revision, 2);
});

test('#593 a new figure on a waiting review is something the person sees, so it raises the revision', async () => {
  const f = await filesSetup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  await writeFile(join(f.folder, 'figs/today.png'), png(8, 8));
  await f.call('update_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  assert.equal(f.review('fig').revision, 2);
});

// A block that never waits on the person (progress, card, table…) has no answer for a revision to guard: the rule is
// only for blocks that ask. A progress block sent again as a heartbeat must still be stamped as updated.
test('#593 a progress block sent again unchanged in its turn is still stamped as updated, so its steps don’t go stale', async () => {
  const s = setup();
  const progress = { id: 'job', type: 'progress', version: 1, fallback: 'The job', steps: [{ id: 'a', label: 'Read the papers', state: 'running' }] };
  let r;
  let shownAt;
  await turn(s.rt, s.adapter, s.t, async (tools) => {
    tools.show_block({ block: progress });
    shownAt = s.store.items(s.t.id).find((i) => i.kind === 'block').updatedAt ?? 0;
    await new Promise((done) => setTimeout(done, 5));
    r = tools.update_block({ block: progress });
  });
  assert.equal(r.message, 'Updated block job.');
  const it = s.store.items(s.t.id).find((i) => i.kind === 'block');
  assert.ok(it.updatedAt > shownAt, `updatedAt ${it.updatedAt} after ${shownAt}`);
});
