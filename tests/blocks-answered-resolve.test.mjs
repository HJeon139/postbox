// #901: an agent resolving one of its review threads after the person answered the review changes nothing they’d
// answer, only the thread’s status, which shows at once. So the review stays answered, with its answer and outcome,
// and nothing moves, as a fallback-only change does (#286) and as a waiting review does (#593). The person chose this
// on 9 November 2026. A real change, or new words in a thread, still asks again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { review, settle, setup, turn } from './blocks-fixture.mjs';

const thread = (status, text = 'Is this the right heading?') => ({ id: 't1', line: 1, status, comments: [{ author: '@critic', text }] });
const draft = (more = {}) => ({ ...review, threads: [thread('open')], ...more });
const moves = (s) => s.store.items(s.t.id).filter((i) => i.kind === 'stub').length;

/** The agent shows the draft, and the person approves it. */
async function answered() {
  const s = setup();
  await turn(s.rt, s.adapter, s.t, (tools) => tools.show_block({ block: draft() }));
  const id = s.store.items(s.t.id).find((i) => i.kind === 'block').id;
  s.rt.act(s.t.id, id, 'submit', { verdict: 'approve', comments: [] }, 1);
  await settle(s.rt);
  const now = () => s.store.item(s.t.id, id);
  assert.equal(now().answered, true);
  return { ...s, id, now };
}

test('#901 resolving a thread on an answered review keeps it answered, shows the resolve, and moves nothing', async () => {
  const s = await answered();
  const r = await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: draft({ threads: [thread('resolved')] }) }));
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /stays answered/);
  assert.equal(s.now().answered, true);
  assert.equal(s.now().answer.values.verdict, 'approve', 'the person’s answer stands');
  assert.equal(s.now().revision ?? 1, 1);
  assert.equal(s.now().block.threads[0].status, 'resolved');
  assert.equal(moves(s), 0, 'nothing moved to the newest point');
});

test('#901 a resolve on an answered review keeps the outcome reported under the answer', async () => {
  const s = await answered();
  await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: { id: review.id, outcome: 'Filed as #12.' } }));
  await turn(s.rt, s.adapter, s.t, (tools) => tools.update_block({ block: draft({ threads: [thread('resolved')] }) }));
  assert.equal(s.now().block.outcome, 'Filed as #12.');
  assert.equal(s.now().answered, true);
});

test('#901 a real change with the resolve, or new words in a thread, still asks again', async () => {
  const changed = await answered();
  await turn(changed.rt, changed.adapter, changed.t, (tools) =>
    tools.update_block({ block: draft({ content: '# Draft\n\nSeen on 22 October.', threads: [thread('resolved')] }) }),
  );
  assert.equal(changed.now().answered, false);
  assert.equal(changed.now().revision, 2);
  const worded = await answered();
  await turn(worded.rt, worded.adapter, worded.t, (tools) => tools.update_block({ block: draft({ threads: [thread('open', 'Is this the right title?')] }) }));
  assert.equal(worded.now().answered, false);
  assert.equal(worded.now().revision, 2);
});
