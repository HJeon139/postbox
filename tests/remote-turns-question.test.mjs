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
  assert.equal(r.rt.permissionWaits.get(questions(r)[0].id).timer, null, 'the host’s permissionWaitMax ends it, not a timer here');
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
  assert.equal(r.se().needs?.kind, 'block', 'the agent shows as needing the person again');
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

test('#1059 an answer the agent already had as a message after a restart ends the call, with no promise of another', async () => {
  const r = restartedAsking(ONE, [{}], { resend: false });
  await until(() => r.d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach');
  const [q] = questions(r);
  pick(r, q, 'Green');
  await until(() => r.rt.delivery.entriesFrom(q.id).some((e) => e.state === 'waiting'), 'the answer as a message');
  // The agent’s next turn took it before the prompt came again.
  for (const e of r.rt.delivery.entriesFrom(q.id)) r.rt.delivery.patch(e, { state: 'delivered' });
  r.d.prompt('host-turn-1', request(ONE), 'p-1');
  await until(() => r.d.answers.length === 1, 'the answer');
  const { result } = r.d.answers[0];
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /already reached you as a message/);
  assert.doesNotMatch(result.message, /stays open|reaches you as a message, so/, 'no second answer is promised');
  r.d.end('host-turn-1');
  await settled(r);
});

test('#1059 a two-question call the host ends while its second block waits leaves nothing waiting, and counts as ended', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(TWO));
  const id = r.d.prompt(turn, request(TWO));
  await until(() => questions(r).length === 1, 'the first block');
  pick(r, questions(r)[0], 'Blue');
  await until(() => questions(r).length === 2 && r.rt.permissionWaits.has(questions(r)[1].id), 'the second block, waiting');
  r.d.expire(turn, id);
  await until(() => !questions(r).some((q) => r.rt.permissionWaits.has(q.id)), 'no wait left');
  await until(() => r.se().remoteTurn?.state === 'running', 'the turn no longer waiting on the person');
  assert.ok(
    questions(r).every((q) => q.remote.ended),
    'each block records the end, so the prompt no longer counts as open',
  );
  const before = starts(r.d).length;
  r.d.end(turn);
  // The first answer reaches the agent as a message, which wakes it.
  await until(() => starts(r.d).length > before, 'the agent’s next turn');
  r.d.end(starts(r.d).at(-1).turn);
  await settled(r);
});

test('#1059 a reconnect’s resend of a question still waiting doesn’t ask it again', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(ONE));
  r.d.prompt(turn, request(ONE));
  await until(() => questions(r).length === 1 && r.rt.permissionWaits.has(questions(r)[0].id), 'the block, waiting');
  let asked = 0;
  const ask = r.rt.requestPermission.bind(r.rt);
  r.rt.requestPermission = (/** @type {any[]} */ ...a) => {
    asked++;
    return ask(...a);
  };
  const resent = () => r.d.sent.filter((m) => m.type === 'prompt').length;
  const before = resent();
  r.link.reconnect();
  await until(() => resent() > before, 'the daemon to send the prompt again');
  // The resend crosses the link, then onPrompt handles it in the same tick.
  for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
  assert.equal(asked, 0, 'the resend waits on the block already waiting');
  assert.equal(questions(r).length, 1);
  pick(r, questions(r)[0], 'Green');
  await until(() => r.d.answers.length === 1, 'one answer');
  r.d.end(turn);
  await settled(r);
});

test('#1059 a two-question call the host ends after the first answer: the agent still gets that answer', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(TWO));
  const id = r.d.prompt(turn, request(TWO));
  await until(() => questions(r).length === 1, 'the first block');
  pick(r, questions(r)[0], 'Red');
  await until(() => questions(r).length === 2 && r.rt.permissionWaits.has(questions(r)[1].id), 'the second block, waiting');
  r.d.expire(turn, id);
  await until(() => !questions(r).some((q) => r.rt.permissionWaits.has(q.id)), 'no wait left');
  const before = starts(r.d).length;
  r.d.end(turn);
  // The person’s first answer went to the call that ended, so it comes to the agent as a message, as a late answer does.
  await until(() => starts(r.d).length > before, 'the agent’s next turn');
  assert.match(messageOf(starts(r.d).at(-1)), /Which color\?[\s\S]*Red/);
  assert.equal(r.rt.delivery.entriesFrom(questions(r)[0].id).length, 1, 'once');
  r.d.end(starts(r.d).at(-1).turn);
  await settled(r);
});

test('#1059 a two-question call the host ends before the second was shown: it’s shown, and stays answerable', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(TWO));
  const id = r.d.prompt(turn, request(TWO));
  await until(() => questions(r).length === 1 && r.rt.permissionWaits.has(questions(r)[0].id), 'the first block, waiting');
  r.d.expire(turn, id);
  await until(() => questions(r).length === 2, 'the second question, shown as well');
  const second = questions(r)[1];
  assert.equal(second.block.prompt, 'Which fruits?');
  assert.equal(r.rt.permissionWaits.has(second.id), false, 'nothing waits on it: its answer comes as a message');
  r.d.end(turn);
  await settled(r);
  const before = starts(r.d).length;
  pick(r, second, 'Plum');
  await until(() => starts(r.d).length > before, 'the agent’s next turn');
  assert.match(messageOf(starts(r.d).at(-1)), /Which fruits\?[\s\S]*Plum/);
  r.d.end(starts(r.d).at(-1).turn);
  await settled(r);
});

test('#1059 an ended question no longer counts as open: a prompt-expired naming no prompt ends the lone card beside it', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.append(turn, callLine(ONE));
  const q = r.d.prompt(turn, request(ONE));
  await until(() => questions(r).length === 1, 'the question’s block');
  r.d.expire(turn, q);
  await until(() => questions(r)[0].remote?.ended, 'the question ended');
  // An ordinary permission card for the same host turn, then an old daemon’s expiry that names no prompt.
  r.d.prompt(turn);
  const card = () => r.store.items(r.t.id).find((i) => i.kind === 'permission' && i.remote?.turn === turn);
  await until(() => card()?.status === 'open', 'the card');
  r.link.hear({ type: 'error', code: 'internal', re: 'prompt-expired', turn, message: 'Couldn’t write down that a prompt ended.' });
  await until(() => card().status !== 'open', 'the lone open card ended');
  r.d.end(turn);
  await settled(r);
});
