// Each turn’s prompt in an ATIF trajectory (tools/atif-prompts.mjs): the guide Postbox gives the backend and each prompt
// as the backend got it, from the run’s prompts.jsonl (#1528), and what a trajectory still leaves out. The fixture is a
// recorded /api/stream and its prompts.jsonl: tests/fixtures/atif/dry-run.md says how it was made.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOT_RECORDED, NOT_RECORDED_WITHOUT_PROMPTS, trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';

const rec = readRecording(new URL('fixtures/atif/dry-run/', import.meta.url).pathname);
const all = (prompts = rec.prompts) => trajectories(rec.events, { version: POSTBOX_VERSION, live: rec.live, prompts });
const of = (handle) => all().find((t) => t.handle === handle).trajectory;
const sessionOf = (handle) => rec.events.find((e) => e.type === 'session' && e.data.handle === handle).data.id;

test('a trajectory says what it was built from, and what of the agent’s prompt it still leaves out', () => {
  for (const { trajectory: t } of all()) {
    assert.ok(
      t.extra.scope.not_recorded.some((x) => /CLAUDE\.md and AGENTS\.md files, Kiro’s steering, skills, plugins/.test(x)),
      'what the backend loads itself',
    );
    assert.deepEqual(t.extra.scope, { record: 'postbox-conversation-and-prompts', not_recorded: NOT_RECORDED });
    assert.match(
      t.notes,
      /^Built from Postbox’s conversation record, with each turn’s prompt as Postbox sent it\. It leaves out the system prompt the agent’s backend adds/,
    );
  }
  // A recording without prompts.jsonl (made outside UAT recording mode) says it has none of them.
  const before = all([]).map((x) => x.trajectory);
  for (const t of before) assert.deepEqual(t.extra.scope, { record: 'postbox-conversation', not_recorded: NOT_RECORDED_WITHOUT_PROMPTS });
});

test('each turn’s prompt is its user step, exactly as sent, after its system guide, and nothing it carried is a step again', () => {
  const t = of('dry');
  const sent = rec.prompts.filter((r) => r.type === 'prompt' && r.sessionId === sessionOf('dry'));
  const steps = t.steps.filter((s) => s.extra.record === 'prompt');
  // What the backend got as the user’s message: the user steps are the prompts, and only they.
  assert.deepEqual(
    t.steps.filter((s) => s.source === 'user'),
    steps,
  );
  assert.equal(t.steps.find((s) => s.extra.record === 'guide').source, 'system');
  assert.deepEqual(
    steps.map((s) => s.message),
    sent.map((r) => r.text),
  );
  const guide = t.steps.find((s) => s.extra.record === 'guide');
  assert.equal(guide.message, rec.prompts.find((r) => r.type === 'guide' && r.sha === sent[0].guideSha).text);
  assert.match(guide.message, /^You are @dry, an agent in Postbox/);
  assert.ok(t.steps.indexOf(guide) < t.steps.indexOf(steps[0]));
  // Each prompt comes before its turn’s reply, and ends with the clock’s line.
  for (const s of steps) {
    const reply = t.steps.find((r) => r.source === 'agent' && r.extra.turn_id === s.extra.turn_id);
    assert.ok(t.steps.indexOf(s) < t.steps.indexOf(reply));
    assert.match(s.message, /\[Postbox\] Run clock: elapsed \d+s \/ budget 30s\. /);
  }
});

test('a prompt whose guide came before the recording began makes the trajectory partial, and says the guide is missing', () => {
  // As a prompts.jsonl cut short has it.
  const t = all(rec.prompts.filter((r) => r.type !== 'guide')).find((x) => x.handle === 'dry').trajectory;
  assert.match(t.notes, /^Partial: Built from Postbox’s conversation record/);
  assert.equal(t.extra.scope.unresolved_guides, 3);
  assert.match(t.extra.scope.not_recorded[0], /^the system prompt Postbox appended to 3 of its prompts, whose guide came before this recording began$/);
  assert.equal(t.steps.filter((s) => s.extra.record === 'guide').length, 0);
  assert.equal(t.steps.filter((s) => s.extra.record === 'prompt').length, 3);
});

test('a prompt goes where its turn first shows, else at its turn’s end, else by its time among the items', () => {
  // prompts.jsonl’s rows carry no seq (#1528): placePrompts puts each among the events.
  const id = sessionOf('dry');
  const steps = (events, prompts = rec.prompts) =>
    trajectories(events, { version: POSTBOX_VERSION, live: rec.live, prompts }).find((x) => x.handle === 'dry').trajectory.steps;
  // @dry’s last turn, which the clock stopped, without its reply: its prompt goes before the turn’s end.
  const reply = rec.events.filter((e) => e.type === 'item.add' && e.data.item.sessionId === id && e.data.item.kind === 'agent').at(-1).data.item;
  const noReply = rec.events.filter((e) => !(e.type === 'item.add' && e.data.item.id === reply.id) && e.data?.id !== reply.id);
  const last = steps(noReply).at(-1);
  assert.equal(last.extra.record, 'prompt');
  assert.equal(last.extra.turn_id, reply.turnId);
  // A prompt whose turn the recording doesn’t have at all goes after the last item added before it was sent.
  const first = rec.events.find((e) => e.type === 'item.add' && e.data.item.sessionId === id && e.data.item.kind === 'agent').data.item;
  const stray = {
    type: 'prompt',
    sessionId: id,
    turnId: 'turn_unknown',
    threadId: first.threadId ?? 'th_9rDc0zBs',
    guideSha: null,
    text: 'Stray.',
    at: first.at + 1,
  };
  const got = steps(rec.events, [...rec.prompts, stray]);
  const at = got.findIndex((s) => s.message === 'Stray.');
  assert.equal(got[at - 1].extra.item_id, first.id);
});
