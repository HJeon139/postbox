// Each turn’s prompt in an ATIF trajectory (tools/atif-prompts.mjs): the guide Postbox appends and each prompt as it
// left, as system steps, and what a trajectory still leaves out. The fixture is a recorded /api/stream:
// tests/fixtures/atif/dry-run.md says how it was made.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOT_RECORDED, NOT_RECORDED_WITHOUT_PROMPTS, trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';

const rec = readRecording(new URL('fixtures/atif/dry-run/', import.meta.url).pathname);
const all = (events = rec.events, live = rec.live) => trajectories(events, { version: POSTBOX_VERSION, live });
const of = (handle) => all().find((t) => t.handle === handle).trajectory;
const sessionOf = (handle) => rec.events.find((e) => e.type === 'session' && e.data.handle === handle).data.id;

test('a trajectory says what it was built from, and what of the agent’s prompt it still leaves out', () => {
  for (const { trajectory: t } of all()) {
    assert.deepEqual(t.extra.scope, { record: 'postbox-conversation-and-prompts', not_recorded: NOT_RECORDED });
    assert.match(
      t.notes,
      /^Built from Postbox’s conversation record, with each turn’s prompt as Postbox sent it\. It leaves out the system prompt the agent’s backend adds/,
    );
  }
  // A recording from before prompts were recorded says it has none of them.
  const before = all(rec.events.filter((e) => !e.type.startsWith('turn.'))).map((x) => x.trajectory);
  for (const t of before) assert.deepEqual(t.extra.scope, { record: 'postbox-conversation', not_recorded: NOT_RECORDED_WITHOUT_PROMPTS });
});

test('each turn’s prompt is a system step, exactly as sent, after its guide, before the reply it led to', () => {
  const t = of('dry');
  const sent = rec.events.filter((e) => e.type === 'turn.prompt' && e.data.sessionId === sessionOf('dry'));
  const steps = t.steps.filter((s) => s.extra.event === 'turn.prompt');
  assert.deepEqual(
    steps.map((s) => s.message),
    sent.map((e) => e.data.text),
  );
  const guide = t.steps.find((s) => s.extra.event === 'turn.guide');
  assert.equal(guide.message, rec.events.find((e) => e.type === 'turn.guide' && e.data.sha === sent[0].data.guideSha).data.text);
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
  // As a recording begun after Postbox recorded the guide, or a data folder whose segment with it is gone, has it.
  const t = all(rec.events.filter((e) => e.type !== 'turn.guide')).find((x) => x.handle === 'dry').trajectory;
  assert.match(t.notes, /^Partial: Built from Postbox’s conversation record/);
  assert.equal(t.extra.scope.unresolved_guides, 3);
  assert.match(t.extra.scope.not_recorded[0], /^the system prompt Postbox appended to 3 of its prompts, whose guide came before this recording began$/);
  assert.equal(t.steps.filter((s) => s.extra.event === 'turn.guide').length, 0);
  assert.equal(t.steps.filter((s) => s.extra.event === 'turn.prompt').length, 3);
});
