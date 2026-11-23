// ATIF trajectories from a real UAT run (tools/atif.mjs): steps in time order, an AskUserQuestion’s blocks and answers
// in its call, and a block’s answer that reached the agent later where it came. The fixture is the run’s recorded
// /api/stream: tests/fixtures/atif/uat-askquestion.md says how it was made.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';

const all = (events, live) => trajectories(events, { version: POSTBOX_VERSION, live });

// A UAT run with a real agent (Claude Code, claude-haiku-5-5): tests/uat/e2e/scenarios/askquestion.md, recorded by the
// UAT kit on 20 November 2026 at 933d9884 (tests/fixtures/atif/uat-askquestion/, unedited).
const UAT = readRecording(new URL('fixtures/atif/uat-askquestion/', import.meta.url).pathname);

test('the real UAT run’s trajectory has its steps in time order, each question and answer once, in its call', () => {
  const [t] = all(UAT.events, UAT.live).map((x) => x.trajectory);
  const times = t.steps.map((s) => Date.parse(s.timestamp));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  const calls = t.steps.flatMap((s) => s.tool_calls ?? []);
  assert.deepEqual(
    calls.map((c) => c.function_name),
    ['AskUserQuestion', 'AskUserQuestion'],
  );
  // The call took each answer at once (`read`), so its result carries it: no block and no answer is a step of its own,
  // and no model is credited with a step it never took.
  const blocks = UAT.events.filter((e) => e.type === 'item.add' && e.data.item.kind === 'block').map((e) => e.data.item);
  assert.equal(blocks.length, 3);
  assert.equal(t.steps.filter((s) => blocks.some((b) => b.id === s.extra.item_id)).length, 0);
  assert.equal(t.steps.filter((s) => s.extra.answer_to !== undefined).length, 0);
  const results = t.steps.flatMap((s) => s.observation?.results ?? []).map((r) => r.content);
  assert.match(results[0], /"Which of these three names should I use for your new project\?"="Tidewell"/);
  assert.match(results[1], /"Which logo color should I use\?"="Warm amber"/);
  // Its arguments are its questions, as the blocks Postbox made from them show them (server/ask-question.mjs).
  assert.deepEqual(
    calls[1].arguments.questions.map((q) => [q.question, q.options.length, q.multiSelect]),
    [
      ['Which logo color should I use?', 3, false],
      [blocks[2].block.prompt, blocks[2].block.options.length, true],
    ],
  );
  assert.equal(calls[1].extra.arguments_source, 'question blocks');
});

/**
 * The real run with its first answer one the question’s call no longer waited for (`read: false`), as when the person
 * answers after the agent’s clock expired, with `answer` changing it; then, if `takenBy`, an answer entry as
 * server/blocks.mjs sends one, and its take by that turn, after everything else.
 */
function unreadFirst(answerOf = (a) => a, takenBy = null) {
  const answer = UAT.events.find((e) => e.type === 'item.patch' && e.data.patch?.answer);
  const unread = { ...answer, data: { ...answer.data, patch: { ...answer.data.patch, answer: { ...answer.data.patch.answer, read: false } } } };
  const events = UAT.events.map((e) => (e === answer ? answerOf(unread) : e));
  const sessionId = UAT.events.find((e) => e.type === 'session').data.id;
  const entry = { id: 'en_answer', sessionId, threadId: answer.data.threadId, source: 'answer', itemId: answer.data.id, state: 'waiting', takenBy: null };
  const later = takenBy
    ? [
        { seq: 10_000, type: 'entry.add', data: { sessionId, entry } },
        { seq: 10_001, type: 'entry.patch', data: { sessionId, id: 'en_answer', patch: { state: 'taken', takenBy } } },
      ]
    : [];
  return { answer, events: [...events, ...later] };
}

test('an answer that comes after another message is placed after it, at its own time', () => {
  // The first answer’s patch moves after the next message, a second later than it, as when the person answers a block
  // only after posting something else; a later turn takes it from the inbox.
  const first = UAT.events.find((e) => e.type === 'item.patch' && e.data.patch?.answer);
  const next = UAT.events.find((e) => e.type === 'item.add' && e.seq > first.seq && e.data.item.kind === 'user');
  const late = (u) => ({
    ...u,
    seq: next.seq + 0.5,
    data: { ...u.data, patch: { ...u.data.patch, answer: { ...u.data.patch.answer, at: next.data.item.at + 1000 } } },
  });
  const { answer, events } = unreadFirst(late, 'turn_later');
  const [t] = all(events, UAT.live).map((x) => x.trajectory);
  const times = t.steps.map((s) => Date.parse(s.timestamp));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  const order = t.steps.map((s) => s.extra.item_id);
  assert.ok(order.indexOf(next.data.item.id) < order.lastIndexOf(answer.data.id), 'the answer comes after the message');
});

test('an answer its call didn’t take is no step while it waits in the inbox; once a turn took its entry, it is', () => {
  const answers = (list) => all(list, UAT.live)[0].trajectory.steps.filter((s) => s.extra.answer_to !== undefined);
  // The other two the calls took at once, so they are in their results: no answer step at all.
  assert.equal(answers(unreadFirst().events).length, 0, 'the unread one is left out');
  const { answer, events } = unreadFirst(undefined, 'turn_later');
  const waiting = events.filter((e) => e.type !== 'entry.patch' || e.data.id !== 'en_answer');
  assert.equal(answers(waiting).length, 0, 'an entry still waiting didn’t reach the agent');
  assert.equal(answers(events).length, 1);
  assert.equal(answers(events)[0].extra.item_id, answer.data.id);
  assert.equal(answers(events)[0].extra.taken_by_turn, 'turn_later');
});
