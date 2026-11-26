// An agent’s update over its own block’s answer that came while its turn ran (#1810): the refusal gives the answer in
// full and settles what still carried it, so the agent reads it once, updates in the same turn, and no later turn
// gives it again. server/block-unread.mjs, unreadAnswer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFromEntries } from '../server/turns.mjs';
import { answeredMidTurn, answersGiven, COMMENTS } from './block-answer-midturn-fixture.mjs';
import { review, settle, setup, turn } from './blocks-fixture.mjs';

/** The refusal gives the whole answer, and the update after it in the same turn applies. */
function assertGivenOnce({ store, t, item, replies }) {
  assert.equal(replies[0].ok, false);
  assert.match(
    replies[0].message,
    /^The update wasn’t applied\. The person answered revision 1 of issue-agents-rail at \d\d:\d\d: request_changes, 2 comments\./,
  );
  assert.match(replies[0].message, /It was waiting for this turn to end, and comes here instead, so here it is in full: submit \{"verdict":"request_changes"/);
  for (const c of COMMENTS) assert.ok(replies[0].message.includes(c.text), `the refusal carries “${c.text}”`);
  assert.match(replies[0].message, /Read it, then update\.$/);
  assert.equal(replies[1].ok, true, replies[1].message);
  assert.equal(store.item(t.id, item.id).revision, 2);
}

test('#1810 an answer waiting in the agent’s inbox comes whole in the refusal, an update in the same turn applies, and no turn gives it again', async () => {
  const s = await answeredMidTurn({
    during: ({ rt, se, item }) => {
      // The person’s answer waits as an entry in the agent’s inbox while it works.
      assert.equal(rt.delivery.waiting(se.id).filter((e) => e.source === 'answer' && e.itemId === item.id).length, 1);
    },
  });
  assertGivenOnce(s);
  const { rt, t, adapter, item, se, calls } = s;
  // No turn followed for the answer, and its entry was delivered by the refusal.
  assert.equal(adapter.calls.length, calls);
  assert.deepEqual(
    rt.delivery
      .inbox(se.id)
      .filter((e) => e.itemId === item.id)
      .map((e) => e.state),
    ['delivered'],
  );
  await turn(rt, adapter, t, () => {}, 'and now?');
  assert.deepEqual(answersGiven(adapter, item.id), []);
});

test('#1810 an answer held behind the running turn comes whole in the refusal, leaves the turn’s queue, and no turn gives it again', async () => {
  const s = await answeredMidTurn({
    during: ({ rt, se, item }) => {
      // The inbox’s wake raced the turn: its entry was taken for a turn that waits behind this one.
      startFromEntries(rt, se.id);
      assert.equal(rt.running.turnOf(se.id).pending.filter((p) => p.message.blockItemId === item.id).length, 1);
    },
  });
  assertGivenOnce(s);
  const { rt, t, adapter, item, se, calls } = s;
  assert.equal(adapter.calls.length, calls);
  // The entry the waiting turn took is delivered, not left taken, which a restart would reopen and give again.
  assert.deepEqual(
    rt.delivery
      .inbox(se.id)
      .filter((e) => e.itemId === item.id)
      .map((e) => e.state),
    ['delivered'],
  );
  rt.delivery.start();
  await settle(rt);
  await turn(rt, adapter, t, () => {}, 'and now?');
  assert.deepEqual(answersGiven(adapter, item.id), []);
});

test('#1810 an unread answer that no longer waits still comes whole in the refusal, which counts as reading it', async () => {
  const { rt, store, t, adapter } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: review }));
  const item = store.items(t.id).find((i) => i.kind === 'block');
  // As a stopped turn or a restart leaves it: answered and unread, with nothing carrying it.
  const answer = { action: 'submit', values: { verdict: 'approve', comments: [] }, voice: 'Approved', at: Date.now(), revision: 1, read: false };
  rt.threads.patchItem(t.id, item.id, { answered: true, answer });
  const replies = await turn(rt, adapter, t, (tools) => [
    tools.update_block({ block: { ...review, content: '# Draft 2' } }),
    tools.update_block({ block: { ...review, content: '# Draft 2' } }),
  ]);
  assert.equal(replies[0].ok, false);
  assert.match(
    replies[0].message,
    /It didn’t reach you in a turn, so here it is in full: submit \{"verdict":"approve","comments":\[\]\}\. Read it, then update\.$/,
  );
  assert.equal(replies[1].ok, true, replies[1].message);
});

test('#1810 an answer too long to give whole in the refusal isn’t settled: it comes whole at the turn’s end', async () => {
  // Five comments of 3,500 characters are past the refusal’s cut (CATCH_UP_CHARS): its tail would be lost for good.
  const long = Array.from({ length: 5 }, (_, i) => ({ line: 1, text: `${i} ${'x'.repeat(3500)}` }));
  const f = await answeredMidTurn({ comments: long });
  assert.equal(f.replies[0].ok, false);
  assert.match(f.replies[0].message, /It reaches you when this turn ends: read it, then update\./);
  assert.equal(answersGiven(f.adapter, f.item.id).length, 1, 'the next turn gets it, whole, once');
});

test('#1810 a correction the person sent since still comes: only the answer itself is settled', async () => {
  const f = await answeredMidTurn({
    during: ({ rt, t, item, se }) => {
      const event = {
        blockId: item.block.id,
        revision: 1,
        action: 'correct',
        values: { threadId: 'th_x', replaces: 'Name the owner.', text: 'Name the team.' },
      };
      rt.delivery.send({
        sessionId: se.id,
        threadId: t.id,
        source: 'answer',
        itemId: item.id,
        from: 'you',
        message: { kind: 'event', event, blockItemId: item.id },
      });
    },
  });
  assert.equal(f.replies[0].ok, false);
  const given = answersGiven(f.adapter, f.item.id);
  assert.deepEqual(
    given.map((m) => m.event?.action),
    ['correct'],
    'the correction reaches the next turn; the answer, given in the refusal, doesn’t',
  );
});

test('#1810 a long answer held behind the running turn stays in its queue, and comes whole when the turn ends', async () => {
  const long = Array.from({ length: 5 }, (_, i) => ({ line: 1, text: `${i} ${'x'.repeat(3500)}` }));
  const f = await answeredMidTurn({
    comments: long,
    during: ({ rt, se }) => startFromEntries(rt, se.id),
  });
  assert.match(f.replies[0].message, /It reaches you when this turn ends/);
  assert.equal(answersGiven(f.adapter, f.item.id).length, 1, 'the queued turn gets it, whole, once');
});

test('#1810 a long answer that no longer waits comes in the refusal cut at its limit, which counts as reading it', async () => {
  const { rt, store, t, adapter } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: review }));
  const item = store.items(t.id).find((i) => i.kind === 'block');
  // Past the refusal’s cut, and with nothing carrying it: the refusal is all that’s left of it, as on main.
  const comments = Array.from({ length: 5 }, (_, i) => ({ line: 1, text: `${i} ${'x'.repeat(3500)}` }));
  const answer = { action: 'submit', values: { verdict: 'request_changes', comments }, voice: 'Changes', at: Date.now(), revision: 1, read: false };
  rt.threads.patchItem(t.id, item.id, { answered: true, answer });
  const [refused, read, applied] = await turn(rt, adapter, t, (tools) => [
    tools.update_block({ block: { ...review, content: '# Draft 2' } }),
    store.item(t.id, item.id).answer.read,
    tools.update_block({ block: { ...review, content: '# Draft 2' } }),
  ]);
  assert.match(refused.message, /It didn’t reach you in a turn, so here it is in full: submit \{"verdict":"request_changes"/);
  assert.equal(read, true);
  assert.equal(applied.ok, true, applied.message);
});

test('#1810 a correction queued behind the running turn stays there when the answer beside it is settled', async () => {
  const f = await answeredMidTurn({
    during: ({ rt, t, item, se }) => {
      // The answer and then the correction were each taken for a turn that waits behind this one.
      startFromEntries(rt, se.id);
      const event = {
        blockId: item.block.id,
        revision: 1,
        action: 'correct',
        values: { threadId: 'th_x', replaces: 'Name the owner.', text: 'Name the team.' },
      };
      const message = { kind: 'event', event, blockItemId: item.id };
      rt.delivery.send({ sessionId: se.id, threadId: t.id, source: 'answer', itemId: item.id, from: 'you', message });
      startFromEntries(rt, se.id);
      assert.equal(rt.running.turnOf(se.id).pending.filter((p) => p.message.blockItemId === item.id).length, 2);
    },
  });
  assert.equal(f.replies[0].ok, false);
  assert.deepEqual(
    answersGiven(f.adapter, f.item.id).map((m) => m.event?.action),
    ['correct'],
    'the queued correction reaches the next turn; the answer, given in the refusal, doesn’t',
  );
});

test('#1810 another agent’s review of the block, waiting beside the answer, isn’t settled with it', async () => {
  const f = await answeredMidTurn({
    during: ({ rt, t, item, se }) => {
      const event = { blockId: item.block.id, revision: 1, action: 'peer-review', values: { verdict: 'comment' } };
      rt.delivery.send({ sessionId: se.id, threadId: t.id, source: 'review', itemId: item.id, from: 'beta', message: { kind: 'event', event } });
    },
  });
  assert.equal(f.replies[0].ok, false);
  const given = f.adapter.calls.slice(f.calls).flatMap((c) => c.message.messages ?? [c.message]);
  assert.deepEqual(
    given.filter((m) => m.kind === 'event').map((m) => m.event?.action),
    ['peer-review'],
    'the review reaches the next turn',
  );
});

test('#1810 the answer to another block of the agent’s, waiting beside this one’s, isn’t settled with it', async () => {
  const f = await answeredMidTurn({
    during: ({ rt, t, se }) => {
      const event = { blockId: 'another-block', revision: 1, action: 'submit', values: { verdict: 'approve' } };
      const message = { kind: 'event', event, blockItemId: 'it_another' };
      rt.delivery.send({ sessionId: se.id, threadId: t.id, source: 'answer', itemId: 'it_another', from: 'you', message });
    },
  });
  assert.equal(f.replies[0].ok, false);
  assert.equal(answersGiven(f.adapter, 'it_another').length, 1, 'the other block’s answer reaches the next turn');
  assert.deepEqual(answersGiven(f.adapter, f.item.id), []);
});
