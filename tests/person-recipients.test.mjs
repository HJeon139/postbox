// Agents answered a message the person sent to another agent: the catch-up gave it as “You: …”, which reads as the
// reading agent itself, and never said who it went to. The person’s message now keeps its recipients, and every
// agent-facing line names the person and who they wrote to.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const userItems = (f, threadId) => f.store.items(threadId).filter((i) => i.kind === 'user');

/** The fixture after one exchange with @alpha, so a message without an @mention replies to @alpha. */
async function afterAlpha() {
  const f = setup();
  f.rt.sendMessage(f.t.id, { text: '@alpha start the totals' });
  await settle(f.rt);
  return f;
}

test('a message the person sent to @alpha reads as theirs, to @alpha, in @beta’s catch-up', async () => {
  const f = await afterAlpha();
  f.rt.sendMessage(f.t.id, { text: 'Please fix the tally.' });
  await settle(f.rt);
  // @beta wakes later for its own reason: @alpha hands it something else.
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@alpha', text: 'Can you check the build?' });
  await settle(f.rt);
  const call = f.adapter.calls.findLast((c) => c.handle === 'beta');
  const background = (call.message.context ?? []).join('\n');
  assert.match(background, /The person, to @alpha: Please fix the tally\./);
  assert.doesNotMatch(background, /You: /);
});

test('the person’s message keeps who it went to: an @mention, or the agent it replies to', async () => {
  const f = await afterAlpha();
  f.rt.sendMessage(f.t.id, { text: 'Please fix the tally.' });
  f.rt.sendMessage(f.t.id, { text: '@beta and @alpha, compare notes.' });
  await settle(f.rt);
  assert.deepEqual(
    userItems(f, f.t.id).map((i) => i.to),
    [['alpha'], ['alpha'], ['beta', 'alpha']],
  );
});

test('a queued message keeps its recipients when it’s delivered later', async () => {
  const f = await afterAlpha();
  const h = held();
  f.adapter.next.push(h.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha one more thing' });
  await sleep(20);
  const sent = f.rt.sendMessage(f.t.id, { text: 'And the footnotes.' });
  assert.ok(sent.queued, 'it waits for @alpha’s turn');
  h.release();
  await settle(f.rt);
  assert.deepEqual(userItems(f, f.t.id).at(-1).to, ['alpha']);
  assert.equal(userItems(f, f.t.id).at(-1).text, 'And the footnotes.');
});

test('a message in a topic thread keeps its recipients, and the thread’s opener names them', async () => {
  const f = await afterAlpha();
  const root = userItems(f, f.t.id)[0];
  const topic = f.store.state.threads[f.rt.startTopic(f.t.id, root.id).threadId];
  f.rt.sendMessage(topic.id, { text: '@beta what do you think?' });
  await settle(f.rt);
  assert.deepEqual(userItems(f, topic.id).at(-1).to, ['beta']);
  const call = f.adapter.calls.findLast((c) => c.handle === 'beta');
  const context = [call.message.taskContext, ...(call.message.context ?? [])].join('\n');
  assert.match(context, /This thread started from the person’s message to @alpha: @alpha start the totals/);
});

test('an item from before recipients were kept still reads as the person’s', () => {
  const f = setup();
  const it = arrange.post(f.rt, f.t.id, { kind: 'user', text: 'Old message.' });
  assert.equal(arrange.describeItem(f.rt, it, f.beta), 'The person: Old message.');
});

test('every agent-facing reading of the person says “The person”, never “You”', () => {
  const f = setup();
  const add = (x) => arrange.post(f.rt, f.t.id, x);
  const lines = [
    add({ kind: 'voice', text: 'Approved.' }),
    add({ kind: 'shared', fromTitle: 'Totals', question: 'Which year?', text: '1908.' }),
    add({ kind: 'system', variant: 'wake', from: 'you', to: 'alpha' }),
    add({ kind: 'command', command: 'ls', cwd: '/tmp', text: 'a', status: 'done', exitCode: 0 }),
  ].map((it) => arrange.describeItem(f.rt, it, f.beta));
  assert.deepEqual(lines, [
    'The person: Approved.',
    'Shared from the thread “Totals”, by the person: The person asked: “Which year?” 1908.',
    'The person woke @alpha',
    'The person ran `ls` in /tmp (it exited with 0). Output:\n```\na\n```',
  ]);
  // read_message gives the agent its own messages as “You”, and the person’s as theirs.
  assert.equal(arrange.readLine(f.rt, add({ kind: 'user', text: 'Hi.', to: ['alpha'] }), f.beta), 'The person, to @alpha: Hi.');
});

test('a message queued only for an agent that’s deleted is posted with that agent as its recipient', async () => {
  const f = await afterAlpha();
  const h = held();
  f.adapter.next.push(h.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha one more thing' });
  await sleep(20);
  assert.ok(f.rt.sendMessage(f.t.id, { text: 'And the footnotes.' }).queued);
  f.rt.deleteSession(f.alpha.id);
  h.release();
  await settle(f.rt);
  const it = userItems(f, f.t.id).find((i) => i.text === 'And the footnotes.');
  assert.deepEqual(it.to, ['alpha']);
});

test('a skill or command the person runs for an agent keeps that agent as its recipient', async () => {
  const f = setup();
  f.rt.runAgentCommand(f.t.id, { sessionId: f.beta.id, text: '/review src/a.js' });
  await settle(f.rt);
  assert.deepEqual(userItems(f, f.t.id).at(-1).to, ['beta']);
});
