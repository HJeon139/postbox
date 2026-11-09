// #521's UAT trigger: an AskUserQuestion question shown as a choice block, answered, and the agent going on in the same
// turn with the answer as the tool's result. Read from a room's items as a run records them, made by a real Runtime:
// a turn that asks through the SDK's canUseTool (server/adapters/sdk-permission.mjs), with the recorded input.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canUseTool } from '../server/adapters/sdk-permission.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const RECORDED = JSON.parse(readFileSync(new URL('fixtures/claude-code/ask-user-question-prompts.json', import.meta.url), 'utf8')).prompts;
const ONE = RECORDED.find((p) => p.run === 'one-auto').input;
const TWO = RECORDED.find((p) => p.run === 'two-auto').input;
const MULTI = RECORDED.find((p) => p.run === 'multi-auto').input;

const until = async (fn, what) => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`Timed out waiting for ${what}`);
};

const firedBy = (name, r) => TRIGGERS[name].run({ threads: [r.t.id], state: { items: { [r.t.id]: r.store.items(r.t.id) } } });
const fired = (r) => firedBy('question-answered-in-turn', r);

/** A room whose @alpha asks the recorded question, then says what it got in the same turn. */
async function asking({ input = ONE, after = (c, answer) => c.text(`Going with ${Object.values(answer.updatedInput?.answers ?? {})[0] ?? 'nothing'}.`) } = {}) {
  const r = setup();
  let answered;
  const done = new Promise((res) => {
    answered = res;
  });
  r.adapter.next.push(async (c) => {
    c.text('Let me ask you.');
    const answer = await canUseTool(c, 'AskUserQuestion', structuredClone(input), { toolUseID: 'toolu_uat_1' });
    answered(answer);
    await after(c, answer);
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha ask me which color' });
  const question = () => r.store.items(r.t.id).findLast((i) => i.kind === 'block' && i.question);
  await until(question, 'the question block');
  /** Picks options of the newest question by label. @param {...string} labels */
  const choose = (...labels) => {
    const q = question();
    r.rt.act(r.t.id, q.id, 'choose', { selected: q.block.options.filter((o) => labels.includes(o.label)).map((o) => o.id) });
  };
  return { ...r, question, choose, done };
}

test('#521 question-answered-in-turn fires once the person picks and the agent goes on in the same turn, naming the question and the pick', async () => {
  const r = await asking();
  assert.deepEqual(fired(r), [], 'not while the question waits');
  r.choose('Blue');
  await r.done;
  await settle(r.rt);
  const [hit, ...rest] = fired(r);
  assert.deepEqual(rest, []);
  assert.match(hit.evidence, /@alpha asked “Which color do you prefer\?”, the person picked “Blue”, and its reply in the same turn said: “Going with Blue\.”/);
  assert.equal(typeof hit.at, 'number');
});

test('#521 question-answered-in-turn doesn’t fire when a permission card for AskUserQuestion is in the run', async () => {
  const r = await asking();
  r.choose('Red');
  await r.done;
  await settle(r.rt);
  r.rt.addItem(r.t.id, {
    kind: 'permission',
    sessionId: r.alpha.id,
    handle: 'alpha',
    tool: 'AskUserQuestion',
    summary: 'use AskUserQuestion',
    status: 'allowed',
  });
  assert.deepEqual(fired(r), []);
});

test('#521 question-answered-in-turn doesn’t fire when the answer reaches the agent only on a later turn', async () => {
  // The turn is stopped while the question waits, so the call ends unanswered and the turn writes nothing more; the
  // person's pick then reaches the agent as an event, in a turn of its own.
  const r = await asking({ after: () => {} });
  r.rt.stop(r.alpha.id);
  await r.done;
  await settle(r.rt);
  r.adapter.next.push(async (c) => c.text('You picked Green, so Green it is.'));
  r.choose('Green');
  await until(() => r.adapter.calls.some((x) => x.message.kind === 'event'), 'the answer as an event');
  await settle(r.rt);
  const later = r.store.items(r.t.id).filter((i) => i.kind === 'agent' && i.text.includes('Green it is'));
  assert.equal(later.length, 1, 'the agent answered in a later turn');
  assert.notEqual(later[0].turnId, r.question().turnId);
  assert.deepEqual(fired(r), []);
});

test('#521 questions-answered-in-turn fires for two questions of one call, one with several picks, answered in the turn', async () => {
  const after = (c, answer) => c.text(`Color ${answer.updatedInput.answers['Which color?']}, fruits ${answer.updatedInput.answers['Which fruits?']}.`);
  const r = await asking({ input: TWO, after });
  r.choose('Green');
  assert.deepEqual(firedBy('questions-answered-in-turn', r), [], 'not with one of two answered');
  await until(() => r.store.items(r.t.id).filter((i) => i.kind === 'block' && i.question).length === 2, 'the second question');
  r.choose('Apple', 'Plum');
  await r.done;
  await settle(r.rt);
  const [hit, ...rest] = firedBy('questions-answered-in-turn', r);
  assert.deepEqual(rest, []);
  assert.match(hit.evidence, /2 questions/);
  assert.match(hit.evidence, /“Apple, Plum”/);
  assert.match(hit.evidence, /Color Green, fruits Apple, Plum\./);
});

test('#521 questions-answered-in-turn doesn’t fire for one question, even with several picks, or for two with one pick each', async () => {
  const one = await asking();
  one.choose('Blue');
  await one.done;
  await settle(one.rt);
  assert.deepEqual(firedBy('questions-answered-in-turn', one), [], 'one question');
  const several = await asking({ input: MULTI, after: (c) => c.text('Thanks.') });
  several.choose('Pear', 'Plum');
  await several.done;
  await settle(several.rt);
  assert.deepEqual(firedBy('questions-answered-in-turn', several), [], 'one question, even with several picks');
  const two = await asking({ input: TWO, after: (c) => c.text('Thanks.') });
  two.choose('Red');
  await until(() => two.store.items(two.t.id).filter((i) => i.kind === 'block' && i.question).length === 2, 'the second question');
  two.choose('Pear');
  await two.done;
  await settle(two.rt);
  assert.deepEqual(firedBy('questions-answered-in-turn', two), [], 'no question with several picks');
});

test('each of the askquestion scenario’s two phases is there to cause it', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/askquestion.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.deepEqual(
    s.phases.map((p) => p.triggers ?? []),
    [['question-answered-in-turn'], ['questions-answered-in-turn']],
  );
  assert.equal(s.permissionModes.researcher, 'auto');
});
