// #1695: the reply-form checks (#63) told an agent that its hand-off to another agent "should have been a block". In the
// sprint room of 23 November 2026, lead-harnesses handed PR #1656 to critic in 49 lines starting "please re-review",
// followed the nudge, and the person got a review block that wasn't theirs to answer. A reply addressed to another agent
// isn't a draft, options or questions for the person, so those checks skip it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockProblems } from '../server/checks.mjs';
import { settle, setup } from './blocks-fixture.mjs';

// The recorded hand-off's shape: 49 lines, “please re-review” at the start, the PR's head, what changed and the checks.
const HANDOFF = [
  '@critic, please re-review **#1656** (Fixes #759) at `817c5abf56e874613371208484afaf934c5db614`. GitHub CI is green.',
  ...Array.from({ length: 46 }, (_, i) => `- Point ${i + 1}: what changed in the relay, and the test that holds it.`),
  'The one action needed: re-review this exact head.',
  'Nothing else is owed.',
].join('\n');
const codes = (text, opts) => blockProblems(text, [], '', opts).map((p) => p.code);

test('#1695 a long hand-off to another agent isn’t a draft for the person; the same text for the person still is', () => {
  assert.equal(HANDOFF.split('\n').length, 49);
  assert.deepEqual(codes(HANDOFF, { toAgent: true }), []);
  assert.deepEqual(codes(HANDOFF.replace('@critic, please', 'Please')), ['draft-in-prose']);
  // Options and questions for another agent aren't the person's to pick or answer either.
  const options = 'Two ways to fix it:\n1. Drop the hold\n2. Keep the report\n\nWhich do you want?';
  assert.deepEqual(codes(options, { toAgent: true }), []);
  assert.deepEqual(codes(options), ['options-in-prose']);
});

test('#1695 a turn whose reply @-mentions another agent gets no reply-form lint; one that mentions no one does', async () => {
  const { rt, store, t, adapter } = setup();
  const lead = rt.createPersona({ handle: 'lead' });
  rt.ensureSession(t.id, lead.id);
  // Each scripted reply names no one, so it would go back and forth to the chain limit: two hops keep the run short.
  rt.threads.patch(t.id, () => ({ chainLimit: 2 }));
  const leadSession = Object.values(store.state.sessions).find((se) => se.handle === 'lead' && se.threadId === t.id);
  const lints = () => adapter.calls.filter((c) => c.sessionId === leadSession.id && c.message.kind === 'lint');
  adapter.next.push(async (c) => c.text(HANDOFF));
  rt.sendMessage(t.id, { text: '@lead hand #1656 to critic' });
  await settle(rt);
  assert.deepEqual(
    lints()
      .flatMap((c) => c.message.problems.map((p) => p.code))
      .filter((c) => c.endsWith('-in-prose')),
    [],
    'no reply-form problem',
  );
  adapter.next.push(async (c) => c.text(HANDOFF.replace('@critic, please', 'Please')));
  rt.sendMessage(t.id, { text: '@lead write it up for me' });
  await settle(rt);
  assert.ok(
    lints().some((c) => c.message.problems.some((p) => p.code === 'draft-in-prose')),
    'the same text, addressed to no agent, is still a draft',
  );
});

test('#1695 a Retry whose reply @-mentions the agent the failed reply already woke gets no reply-form lint', async () => {
  const { rt, store, t, adapter } = setup();
  const lead = rt.createPersona({ handle: 'lead' });
  rt.ensureSession(t.id, lead.id);
  rt.threads.patch(t.id, () => ({ chainLimit: 2 }));
  const leadSession = Object.values(store.state.sessions).find((se) => se.handle === 'lead' && se.threadId === t.id);
  const lints = () => adapter.calls.filter((c) => c.sessionId === leadSession.id && c.message.kind === 'lint');
  // The reply that fails has already woken @critic, so the retry’s mention of it wakes no one again.
  adapter.next.push(async (c) => {
    c.text('@critic, please re-review #1656.');
    throw new Error('Claude Code exited with code 1.');
  });
  adapter.next.push(async (c) => c.text('ok'));
  rt.sendMessage(t.id, { text: '@lead hand #1656 to critic' });
  await settle(rt);
  const failed = store.items(t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.deepEqual(failed.wokeOnFailure, ['critic']);
  adapter.next.push(async (c) => c.text(HANDOFF));
  await rt.retry(t.id, failed.id);
  await settle(rt);
  assert.ok(
    store.items(t.id).some((i) => i.kind === 'agent' && i.status === 'done' && i.text?.includes('Point 46')),
    'the retry answered',
  );
  assert.deepEqual(
    lints()
      .flatMap((c) => c.message.problems.map((p) => p.code))
      .filter((c) => c.endsWith('-in-prose')),
    [],
    'no reply-form problem',
  );
});

test('#1695 a reply that goes back to the agent that woke it, naming no one, gets no reply-form lint', async () => {
  const { rt, store, t, adapter } = setup();
  const lead = rt.createPersona({ handle: 'lead' });
  rt.ensureSession(t.id, lead.id);
  // Each scripted reply names no one, so it would go back and forth to the chain limit: two hops keep the run short.
  rt.threads.patch(t.id, () => ({ chainLimit: 2 }));
  const leadSession = Object.values(store.state.sessions).find((se) => se.handle === 'lead' && se.threadId === t.id);
  const lints = () => adapter.calls.filter((c) => c.sessionId === leadSession.id && c.message.kind === 'lint');
  // @critic asks @lead; @lead's answer names no one, so it goes back to @critic (reply-back.mjs, #1518).
  adapter.next.push(async (c) => c.text('@lead what changed in #1656 since my review?'));
  adapter.next.push(async (c) => c.text(HANDOFF.replace('@critic, please', 'Please')));
  rt.sendMessage(t.id, { text: '@critic check with lead' });
  await settle(rt);
  const answer = store.items(t.id).findLast((it) => it.kind === 'agent' && it.sessionId === leadSession.id && it.text?.startsWith('Please'));
  assert.deepEqual(answer?.wentBack, ['critic'], 'the answer went back to critic');
  assert.deepEqual(
    lints()
      .flatMap((c) => c.message.problems.map((p) => p.code))
      .filter((c) => c.endsWith('-in-prose')),
    [],
    'no reply-form problem',
  );
});

test('#1695 a turn that opens a topic for another agent, then offers the person options, is still asked for a choice', async () => {
  const { rt, store, t, adapter } = setup();
  const lead = rt.createPersona({ handle: 'lead' });
  rt.ensureSession(t.id, lead.id);
  rt.threads.patch(t.id, () => ({ chainLimit: 2 }));
  const leadSession = Object.values(store.state.sessions).find((se) => se.handle === 'lead' && se.threadId === t.id);
  const lints = () => adapter.calls.filter((c) => c.sessionId === leadSession.id && c.message.kind === 'lint');
  adapter.next.push(async (c) => {
    const asked = store.items(t.id).findLast((it) => it.kind === 'user');
    c.tools.open_topic({ itemId: asked.id, message: '@critic could you check the relay while I ask?' });
    c.text('Two ways to go:\n1. Drop the hold\n2. Keep the report\n\nWhich do you want?');
  });
  rt.sendMessage(t.id, { text: '@lead how should we fix #438?' });
  await settle(rt);
  assert.ok(
    lints().some((c) => c.message.problems.some((p) => p.code === 'options-in-prose')),
    'the topic named an agent, but the reply asks the person',
  );
});
