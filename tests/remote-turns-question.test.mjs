// #1059: Claude Code’s AskUserQuestion on a host asks as choice blocks, as it does on this computer (#521), and the
// pick is the host prompt’s answer. The prompts are recorded (fixtures/claude-code/ask-user-question-prompts.json,
// Claude Code 2.1.319, #521). The call’s stream line is the recorded turn’s first tool call with AskUserQuestion in it,
// as tests/ask-question-cli.test.mjs builds it: no stream recorded on a host has this call.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { createFakeDaemon, fixtureLines } from './fake-daemon.mjs';
import { messageOf, rig, running, settled, starts, startUp, until } from './remote-turns-helpers.mjs';

const RECORDED = JSON.parse(readFileSync(new URL('fixtures/claude-code/ask-user-question-prompts.json', import.meta.url), 'utf8')).prompts;
const ONE = RECORDED.find((p) => p.run === 'one-auto');
const TWO = RECORDED.find((p) => p.run === 'two-auto');
const request = (/** @type {any} */ p) => ({ tool_name: 'AskUserQuestion', input: p.input, tool_use_id: p.tool_use_id });

/** The stream’s line for the call. @param {any} p */
function callLine(p) {
  const line = JSON.parse(fixtureLines().find((l) => l.startsWith('{"type":"assistant"') && l.includes('"tool_use"')) ?? '');
  line.message.content = [{ type: 'tool_use', id: p.tool_use_id, name: 'AskUserQuestion', input: p.input }];
  return JSON.stringify(line);
}

const questions = (/** @type {any} */ r) => r.store.items(r.t.id).filter((/** @type {any} */ i) => i.kind === 'block' && i.question);
/** @param {any} q @param {string} label */
const pick = (r, q, label) => r.rt.act(r.t.id, q.id, 'choose', { selected: [q.block.options.find((/** @type {any} */ o) => o.label === label).id] });

test('#1059 on a host, a question is a choice block, and the pick is the prompt’s answer in the same turn', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(ONE));
  const id = r.d.prompt(turn, request(ONE));
  await until(() => questions(r).length === 1, 'the question’s block');
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'permission').length, 0, 'no permission card');
  pick(r, questions(r)[0], 'Green');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.deepEqual(r.d.answers[0], {
    turn,
    id,
    result: { behavior: 'allow', updatedInput: { ...ONE.input, answers: { 'Which color do you prefer?': 'Green' } } },
  });
  r.d.end(turn);
  await settled(r);
});

test('#1059 at the host’s permissionWaitMax the question stays open, and a later answer reaches the agent as an event', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(ONE));
  const id = r.d.prompt(turn, request(ONE));
  await until(() => questions(r).length === 1, 'the question’s block');
  r.d.expire(turn, id);
  await until(() => !r.rt.permissionWaits.has(questions(r)[0].id), 'the wait to end');
  assert.equal(questions(r)[0].answered, false, 'still asking');
  r.d.end(turn);
  await settled(r);
  const before = starts(r.d).length;
  pick(r, questions(r)[0], 'Green');
  await until(() => starts(r.d).length > before, 'the agent’s next turn');
  assert.match(messageOf(starts(r.d).at(-1)), /Which color do you prefer\?[\s\S]*Green/);
  assert.equal(r.d.answers.length, 0, 'nothing went to the expired prompt');
  r.d.end(starts(r.d).at(-1).turn);
  await settled(r);
});

/**
 * Postbox stopped while a host turn asked `p`; its blocks, as `parts` says, were shown before. The daemon sends the
 * prompt again once the new Postbox connects, unless resend is false. onHost false: the host no longer has the turn.
 * @param {any} p @param {Record<string, any>[]} parts @param {{ onHost?: boolean, resend?: boolean }} [o]
 */
function restartedAsking(p, parts, { onHost = true, resend = true } = {}) {
  const d = createFakeDaemon({ autoEnd: false });
  const first = rig({ d });
  first.rt.remote.close();
  const se = first.se();
  arrange.setSession(first.rt, se.id, {
    backendState: { claudeSessionId: 'e6f7d942-4a4f-4015-b186-0ef8d5c103ca' },
    remoteTurn: { hostId: first.host.id, turn: 'host-turn-1', offset: 120, rtTurn: 'turn_old', threadId: first.t.id, state: 'waiting', at: 1 },
  });
  for (const [part, extra] of parts.entries()) {
    const q = p.input.questions[part];
    const options = q.options.map((/** @type {any} */ o, /** @type {number} */ i) => ({ id: `o${i + 1}`, label: o.label }));
    const block = { id: `ask-${part}`, type: 'choice', version: 1, prompt: q.question, options, multiple: false, fallback: q.question };
    arrange.post(first.rt, first.t.id, {
      kind: 'block',
      sessionId: se.id,
      handle: 'coder',
      turnId: 'turn_old',
      valid: true,
      block,
      answered: false,
      question: true,
      toolUseId: p.tool_use_id,
      ...extra,
      remote: { hostId: first.host.id, turn: 'host-turn-1', prompt: 'p-1', part, ...extra.remote },
    });
  }
  if (onHost) {
    d.addTurn('host-turn-1', { exit: null });
    d.append('host-turn-1', callLine(p));
    if (resend) d.prompt('host-turn-1', request(p), 'p-1');
  }
  d.drop();
  d.connect();
  const r = rig({ store: first.store, d });
  startUp(r);
  return r;
}

test('#1059 after a restart, the resent prompt shows no second block, and the answer still reaches the call', async () => {
  const r = restartedAsking(ONE, [{}]);
  await until(() => r.rt.permissionWaits.has(questions(r)[0].id), 'the block to wait again');
  assert.equal(questions(r).length, 1, 'no second block');
  pick(r, questions(r)[0], 'Blue');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.deepEqual(r.d.answers[0].result.updatedInput.answers, { 'Which color do you prefer?': 'Blue' });
  r.d.end('host-turn-1');
  await settled(r);
});

test('#1059 after a restart part-way through, the answered question counts and the next one is asked', async () => {
  const answered = { answered: true, answer: { action: 'choose', values: { selected: ['o3'] }, at: 1, revision: 1, read: true } };
  const r = restartedAsking(TWO, [answered]);
  await until(() => questions(r).length === 2, 'the second question’s block');
  const second = questions(r)[1];
  assert.equal(second.remote.part, 1);
  pick(r, second, 'Plum');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.deepEqual(r.d.answers[0].result.updatedInput.answers, { 'Which color?': 'Blue', 'Which fruits?': 'Plum' });
  // Each block keeps the call’s answer, so none reads as still waiting on the host.
  await until(() => questions(r).every((q) => q.remote?.answer), 'the answer on each block');
  r.d.end('host-turn-1');
  await settled(r);
});

test('#1059 a lost answer is sent again from the block when the prompt comes again', async () => {
  // The call was answered before the restart, but the answer frame never reached the host.
  const result = { behavior: 'allow', updatedInput: { ...ONE.input, answers: { 'Which color do you prefer?': 'Red' } } };
  const answer = { action: 'choose', values: { selected: ['o1'] }, at: 1, revision: 1, read: true };
  const r = restartedAsking(ONE, [{ answered: true, answer, remote: { answer: result } }]);
  await until(() => r.d.answers.length === 1, 'the answer sent again');
  assert.deepEqual(r.d.answers[0], { turn: 'host-turn-1', id: 'p-1', result });
  assert.equal(questions(r).length, 1, 'no second block');
  assert.equal(r.rt.permissionWaits.size, 0, 'nothing waits');
  r.d.end('host-turn-1');
  await settled(r);
});

test('#1059 a question whose host turn is gone after a restart stays asking, not closed as a card', async () => {
  const r = restartedAsking(ONE, [{}], { onHost: false });
  await until(() => r.se().remoteTurn?.state !== 'waiting', 'the gone turn to be given up');
  const [q] = questions(r);
  assert.deepEqual({ answered: q.answered, status: q.status, closed: q.closed }, { answered: false, status: undefined, closed: undefined });
  r.rt.remote.close();
});

test('#1059 an answer given after a restart, before the prompt comes again, reaches the agent once', async () => {
  const r = restartedAsking(ONE, [{}], { resend: false });
  await until(() => r.d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach');
  // Nothing waits on the block yet: the pick goes to the agent’s inbox as a message.
  const [q] = questions(r);
  pick(r, q, 'Green');
  const waiting = () => r.rt.delivery.entriesFrom(q.id).filter((e) => e.state === 'waiting');
  await until(() => waiting().length === 1, 'the answer as a message');
  // The prompt comes again: the call takes the answer, and the message is withdrawn.
  r.d.prompt('host-turn-1', request(ONE), 'p-1');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.deepEqual(r.d.answers[0].result.updatedInput.answers, { 'Which color do you prefer?': 'Green' });
  assert.equal(waiting().length, 0, 'not also as a message');
  r.d.end('host-turn-1');
  await settled(r);
});
