// #647: an agent’s need mid-turn and at the turn’s end agree (#633), but not for a kept block in another thread. A turn
// you didn’t start keeps the block the agent was waiting on (`se.keptId`): mid-turn it counts wherever it is, while the
// turn’s end looked it up only in the turn’s own thread, so a block in a topic thread stopped being the need once
// another agent’s wake in the conversation ended.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { room } from './card-needs-fixture.mjs';
import { held, settle, sleep } from './side-threads-fixture.mjs';

/** @alpha waits on block B, which it showed in a topic thread; then another agent’s wake runs it in the conversation. */
async function keptInTopic() {
  const r = room();
  const root = r.rt.threads.addItem(r.t.id, { kind: 'user', text: 'The release plan', status: 'done' });
  const topic = r.rt.startTopic(r.t.id, root.id).threadId;
  // From a turn before the last, so only the kept block (`se.keptId`), not the turns kept, makes it count.
  const b = r.block('turn_old', topic);
  r.setNeed('block', b.id);
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.turnService.run(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' }); // not you moving on
  await sleep(5);
  return { ...r, b, topic, work };
}

test('#647: a block kept in a topic thread is still the need when another agent’s wake in the conversation ends', async () => {
  const r = await keptInTopic();
  assert.equal(r.needs()?.itemId, r.b.id, 'mid-turn');
  r.work.release();
  await settle(r.rt);
  assert.equal(r.needs()?.itemId, r.b.id, 'and at the turn’s end');
  assert.equal(r.rt.s.sessions[r.alpha.id].state, 'needs');
});

test('#647: once the person answers the kept block, the turn’s end leaves no need for it', async () => {
  const r = await keptInTopic();
  r.rt.threads.patchItem(r.topic, r.b.id, { answered: true });
  r.work.release();
  await settle(r.rt);
  assert.notEqual(r.needs()?.itemId, r.b.id);
});

test('#647: a silent turn counts no unread on the conversation for a block kept in a topic', async () => {
  // Pre-review: the topic’s block, now found at the turn’s end, mustn’t count as the conversation’s activity (#228). A
  // scheduled wake owes no reply and isn’t the person moving on, so it keeps the block and may end with nothing.
  const r = room();
  const root = r.rt.threads.addItem(r.t.id, { kind: 'user', text: 'The release plan', status: 'done' });
  const topic = r.rt.startTopic(r.t.id, root.id).threadId;
  const b = r.block('turn_old', topic);
  r.setNeed('block', b.id);
  const before = r.rt.s.sessions[r.alpha.id].unread ?? 0;
  r.adapter.next.push(async () => {});
  r.rt.turnService.run(r.alpha.id, { kind: 'wake', note: 'check the plan' });
  await sleep(5);
  await settle(r.rt);
  assert.equal(r.needs()?.itemId, b.id, 'the block is still the need');
  assert.equal(r.rt.s.sessions[r.alpha.id].unread ?? 0, before, 'and the conversation counts nothing new');
});

test('#647: the wake’s end raises no new “needs you” alert for the block it kept, which didn’t change', async () => {
  // Integrator review of #1598: the person already had this alert when the block first became the need, and a notice
  // comes when something changes (designs/developing.md, “Design habits”, 12). Another agent’s wake changed nothing.
  const r = await keptInTopic();
  /** @type {any[]} */
  const heard = [];
  r.rt.store.subscribe((/** @type {any} */ ev) => ev.type === 'notify' && heard.push(ev.data));
  r.work.release();
  await settle(r.rt);
  assert.equal(r.needs()?.itemId, r.b.id, 'still the need');
  assert.deepEqual(
    heard.filter((n) => n.level === 'blocking'),
    [],
  );
});
