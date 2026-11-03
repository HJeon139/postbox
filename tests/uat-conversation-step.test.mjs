// The conversation action’s and the local restart’s rules that need no page (tools/uat/conversation-step.mjs,
// tools/uat/steps.mjs). Their clicks were tried against a Postbox of their own through a real page; the run’s
// records (facts.probes.conversation) are what turn-in-deleting-conversation reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delayUntil } from '../tools/uat/conversation-step.mjs';
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
  assert.match(prompt, /- conversation \{conversation, at\?, undo_after\?, agents\?, title\?\}/);
  assert.equal(action.at.type, 'string');
  assert.match(prompt, /an interrupt \{after, do: conversation, conversation: delete, undo_after\?\}/);
  assert.match(prompt, /- fault \{fault: restart-postbox\}: in a run without hosts too/);
});

test('a delete’s at: it waits until then, goes at once if it has passed, and refuses a time it can’t read or far off', async () => {
  const now = Date.parse('2026-11-03T10:45:40Z');
  assert.deepEqual(delayUntil(undefined, now), { wait: 0, note: '' });
  // A wake due at 10:45:48.9, less 4 s, as #726’s phase 2 asks.
  const soon = delayUntil('2026-11-03T10:45:44.900Z', now);
  assert.equal(soon.wait, 4900);
  assert.match(soon.note, /waited for its at/);
  const late = delayUntil('2026-11-03T10:45:38Z', now);
  assert.equal(late.wait, 0);
  assert.match(late.note, /had passed 2\.0 s before, so it went at once/);
  assert.throws(() => delayUntil('in a bit', now), /a time such as .*, not “in a bit”/);
  assert.throws(() => delayUntil('2026-11-03T11:00:00Z', now), /at most 5 minutes away/);
  // A bad at is refused before anything is clicked.
  let clicked = 0;
  const c = ctx();
  c.d.kit.ev = async () => '#/t/th_1';
  c.d.kit.clickAt = async () => clicked++;
  c.api = async () => ({ state: { threads: { th_1: { id: 'th_1', title: 'T' } }, sessions: {}, projects: {} } });
  await assert.rejects(STEPS.conversation(c, { conversation: 'delete', at: 'soon' }), /not “soon”/);
  assert.equal(clicked, 0);
});

test('a delete with at opens its confirm first, and presses Delete no earlier than at', async () => {
  const clicks = [];
  const thread = { id: 'th_1', title: 'T', projectId: 'p1' };
  const c = ctx();
  c.d.kit.ev = async () => '#/t/th_1';
  c.d.kit.clickAt = async (_expr, what) => clicks.push({ what, at: Date.now() });
  // Marked as being deleted once the confirm’s Delete is pressed, as the server does.
  c.api = async () => ({ state: { threads: { th_1: { ...thread, deleting: clicks.length >= 3 ? Date.now() + 10_000 : null } }, sessions: {}, projects: {} } });
  const at = new Date(Date.now() + 400).toISOString();
  const said = await STEPS.conversation(c, { conversation: 'delete', at });
  assert.deepEqual(
    clicks.map((x) => x.what),
    ['the conversation’s menu', 'Delete in its menu', 'the confirm’s Delete'],
  );
  assert.ok(clicks[1].at < Date.parse(at), 'the confirm opened before at');
  assert.ok(clicks[2].at >= Date.parse(at), `Delete pressed ${Date.parse(at) - clicks[2].at} ms before at`);
  assert.match(said, /waited for its at/);
  assert.equal(c.facts.probes.conversation[0].do, 'delete');
});

test('Undo’s time is taken before its click, so a turn that starts as the click returns isn’t in the window', async () => {
  // A recorded rerun (assets-delete phase 2, with #727): the wake’s turn came right after Undo, and Undo’s time, taken
  // after the click returned, was 0.25 s late, so the turn read as started in the window.
  const clicks = [];
  const c = ctx();
  c.d.kit.ev = async () => true;
  c.d.kit.clickAt = async (_expr, what) => {
    clicks.push({ what, at: Date.now() });
    await new Promise((r) => setTimeout(r, 250));
  };
  c.d.kit.page = { waitFor: async () => {} };
  c.api = async () => ({ state: { threads: { th_1: { id: 'th_1', title: 'T', deleting: null } } } });
  const del = { do: 'delete', at: Date.now() - 3000, threadId: 'th_1', title: 'T', handles: ['researcher'], until: Date.now() + 7000 };
  c.facts.probes.conversation = [del];
  await STEPS.conversation(c, { conversation: 'undo' });
  const undo = c.facts.probes.conversation.find((x) => x.do === 'undo');
  const pressed = clicks.find((x) => x.what === 'Undo on the delete’s toast').at;
  assert.ok(undo.at <= pressed, `Undo recorded ${undo.at - pressed} ms after its click began`);
  // The turn check then counts a turn that starts 0.3 s after that time as after Undo.
  const { turnsInDeletes } = await import('../tools/uat/checks-assets.mjs');
  const stream = { handle: 'researcher', events: [], started: undo.at + 300, ended: undo.at + 5000 };
  assert.deepEqual(turnsInDeletes({ probes: { conversation: c.facts.probes.conversation }, streams: [stream] }), []);
});
