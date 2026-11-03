// The conversation action’s and the local restart’s rules that need no page (tools/uat/conversation-step.mjs,
// tools/uat/steps.mjs). Their clicks were tried against a Postbox of their own through a real page; the run’s
// records (facts.probes.conversation) are what turn-in-deleting-conversation reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { interruptAct, localRestart, STEPS } from '../tools/uat/steps.mjs';
import { SCHEMA, systemPrompt } from '../tools/uat/tester.mjs';

const ctx = () => ({
  d: { kit: { ev: async () => '#/p/p1' } },
  api: async () => ({ state: { threads: {}, sessions: {}, projects: {} } }),
  facts: { probes: {} },
});

test('a fault or a conversation action mid-turn is the driver’s answer; stop and send_now stay its own', async () => {
  const runner = { fault: async (i) => `fault ${i.fault}`, answer: async (i) => `answer ${i.item}`, ctx: ctx() };
  const fault = interruptAct({ do: 'fault', fault: 'kill-ssh' }, runner);
  assert.deepEqual([fault.do, await fault.answer()], ['answer', 'fault kill-ssh']);
  const conv = interruptAct({ do: 'conversation', conversation: 'rename' }, runner);
  assert.equal(conv.do, 'answer');
  await assert.rejects(conv.answer(), /delete, undo, new or open, not “rename”/, 'it runs the conversation action');
  const block = interruptAct({ do: 'answer', item: 'I3' }, runner);
  assert.deepEqual([block.do, await block.answer()], ['answer', 'answer I3']);
  assert.equal(interruptAct({ do: 'stop' }, runner).do, 'stop');
});

test('the conversation action refuses what it can’t do, saying what it can', async () => {
  await assert.rejects(STEPS.conversation(ctx(), { conversation: 'undo' }), /Nothing was deleted to undo/);
  await assert.rejects(STEPS.conversation(ctx(), { conversation: 'delete' }), /No conversation is open to delete/);
  await assert.rejects(STEPS.conversation(ctx(), { conversation: 'new', agents: ['researcher'] }), /Open a conversation first/);
  await assert.rejects(STEPS.conversation(ctx(), { conversation: 'open', title: 'Nope' }), /no conversation “Nope”/);
  const c = ctx();
  await STEPS.conversation(c, { conversation: 'undo' }).catch(() => {});
  assert.deepEqual(c.facts.probes.conversation, [], 'its records start empty');
});

test('a run without hosts restarts Postbox, and refuses the faults only a host has', async () => {
  const said = [];
  const postbox = { restart: async () => 1234 };
  const page = { reload: async () => said.push('reloaded') };
  assert.match(await localRestart({ postbox, page, log: (l) => said.push(l) }, { fault: 'restart-postbox' }), /down 1\.2 s/);
  assert.deepEqual(said, ['reloaded', 'fault restart-postbox: Restarted Postbox on the same data. It was down 1.2 s.']);
  await assert.rejects(localRestart({ postbox, page, log: () => {} }, { fault: 'kill-ssh' }), /can only restart Postbox, not kill-ssh/);
});

test('the tester has the action, and a delete as an interrupt, and is told how to use both', () => {
  const action = SCHEMA.properties.action.properties;
  assert.ok(action.type.enum.includes('conversation'));
  assert.deepEqual(action.conversation.enum, ['delete', 'undo', 'new', 'open']);
  assert.deepEqual(action.interrupt.properties.conversation.enum, ['delete']);
  const prompt = systemPrompt({ scenario: parseScenario('# T\n'), issues: [] });
  assert.match(prompt, /- conversation \{conversation, undo_after\?, agents\?, title\?\}/);
  assert.match(prompt, /an interrupt \{after, do: conversation, conversation: delete, undo_after\?\}/);
  assert.match(prompt, /- fault \{fault: restart-postbox\}: in a run without hosts too/);
});
