// #485: a failed reply’s @-mentions still wake their agents, marked as from a failed turn (the person’s choice, 29
// October 2026), and Retry doesn’t wake them again for the same hand-off (the integrator’s review of PR #536). In #485,
// developer’s report asked two agents to act, and neither heard. tests/empty-reply.test.mjs has the rest of #485.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMessage } from '../server/read-message.mjs';
import { setup as blocksSetup, settle as settleBlocks } from './blocks-fixture.mjs';

test('#485: a failed reply’s @-mentions still wake their agents, with the message marked as from a failed turn', async () => {
  // The person’s choice, 29 October 2026: in #485, developer’s report asked two agents to act, and neither heard.
  const { store, rt, adapter, t } = blocksSetup();
  const other = rt.createPersona({ handle: 'researcher' });
  rt.ensureSession(t.id, other.id);
  adapter.next.push(async (c) => {
    c.text('#451 is ready at 41f3a0f. @researcher please record it.');
    throw new Error('Claude Code exited with code 1.');
  });
  adapter.next.push(async (c) => c.text('Recorded.'));
  rt.sendMessage(t.id, { text: '@critic watch the checks' });
  await settleBlocks(rt);
  const woke = adapter.calls.find((x) => x.message.kind === 'agent' && x.message.from === '@critic');
  assert.ok(woke, 'researcher was woken');
  assert.match(woke.message.text, /^\(This reply failed before it finished: Claude Code exited with code 1\.[^)]*\)/);
  assert.match(woke.message.text, /#451 is ready at 41f3a0f\. @researcher please record it\./);
  // It wakes from the failed reply itself, which isn’t posted again.
  assert.equal(store.items(t.id).filter((i) => i.kind === 'agent' && i.text?.includes('#451 is ready')).length, 1);
});

test('#485: Retry doesn’t wake again the agents a failed reply already woke', async () => {
  // Integrator review of PR #536: the failed reply woke researcher; the retried one mentions it too.
  const { store, rt, adapter, t } = blocksSetup();
  const other = rt.createPersona({ handle: 'researcher' });
  rt.ensureSession(t.id, other.id);
  adapter.next.push(async (c) => {
    c.text('#451 is ready. @researcher please record it.');
    throw new Error('Claude Code exited with code 1.');
  });
  adapter.next.push(async (c) => c.text('Recorded.'));
  rt.sendMessage(t.id, { text: '@critic watch the checks' });
  await settleBlocks(rt);
  const failed = store.items(t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.deepEqual(failed.wokeOnFailure, ['researcher']);
  const woken = () => adapter.calls.filter((x) => x.message.kind === 'agent' && x.message.from === '@critic').length;
  assert.equal(woken(), 1);
  adapter.next.push(async (c) => c.text('#451 is ready at 41f3a0f. @researcher please record it.'));
  await rt.retry(t.id, failed.id);
  await settleBlocks(rt);
  assert.ok(
    store.items(t.id).some((i) => i.kind === 'agent' && i.status === 'done' && i.text?.includes('41f3a0f')),
    'the retry answered',
  );
  assert.equal(woken(), 1, 'researcher isn’t woken a second time for the same hand-off');
  // The failed text still reads as failed, next to the retry’s reply.
  const researcher = rt.sessionsIn(t.id).find((x) => x.handle === 'researcher');
  assert.match(readMessage(rt, researcher, { id: failed.id }).message, /^@critic \(this reply failed and was retried: /);
});

test('#485: a second Retry doesn’t wake again the agents the first failure woke', async () => {
  // Critic’s P2 on 47aa466: the first retry fails too, waking no one new, and its item carried no list.
  const { store, rt, adapter, t } = blocksSetup();
  const other = rt.createPersona({ handle: 'researcher' });
  rt.ensureSession(t.id, other.id);
  const fails = (text) => async (c) => {
    c.text(text);
    throw new Error('Claude Code exited with code 1.');
  };
  adapter.next.push(fails('#451 is ready. @researcher please record it.'));
  adapter.next.push(async (c) => c.text('Recorded.'));
  rt.sendMessage(t.id, { text: '@critic watch the checks' });
  await settleBlocks(rt);
  const woken = () => adapter.calls.filter((x) => x.message.kind === 'agent' && x.message.from === '@critic').length;
  const lastFailed = () =>
    store
      .items(t.id)
      .filter((i) => i.kind === 'agent' && i.status === 'failed')
      .at(-1);
  adapter.next.push(fails('#451 is ready again. @researcher please record it.'));
  await rt.retry(t.id, lastFailed().id);
  await settleBlocks(rt);
  assert.deepEqual(lastFailed().wokeOnFailure, ['researcher'], 'the second failure keeps the list');
  adapter.next.push(async (c) => c.text('#451 is ready at 41f3a0f. @researcher please record it.'));
  await rt.retry(t.id, lastFailed().id);
  await settleBlocks(rt);
  assert.equal(woken(), 1, 'researcher is woken once in all');
});
