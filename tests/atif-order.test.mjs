// ATIF trajectories from a real UAT run (tools/atif.mjs): steps in time order, a block’s answer where it came. The
// fixture is the run’s recorded /api/stream: tests/fixtures/atif/uat-askquestion.md says how it was made.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';

const all = (events, live) => trajectories(events, { version: POSTBOX_VERSION, live });

// A UAT run with a real agent (Claude Code, claude-haiku-5-5): tests/uat/e2e/scenarios/askquestion.md, recorded by the
// UAT kit on 20 November 2026 at 933d9884 (tests/fixtures/atif/uat-askquestion/, unedited).
const UAT = readRecording(new URL('fixtures/atif/uat-askquestion/', import.meta.url).pathname);

test('the real UAT run’s trajectory has its steps in time order, its answers among them', () => {
  const [t] = all(UAT.events, UAT.live).map((x) => x.trajectory);
  const times = t.steps.map((s) => Date.parse(s.timestamp));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  assert.equal(t.steps.filter((s) => s.extra.answer_to !== undefined).length, 3);
  assert.deepEqual(
    t.steps.flatMap((s) => s.tool_calls ?? []).map((c) => c.function_name),
    ['AskUserQuestion', 'AskUserQuestion'],
  );
});

test('an answer that comes after another message is placed after it, at its own time', () => {
  // From the real run: the first answer’s patch moves after the next message, a second later than it, as when the
  // person answers a block only after posting something else.
  const answer = UAT.events.find((e) => e.type === 'item.patch' && e.data.patch?.answer);
  const next = UAT.events.find((e) => e.type === 'item.add' && e.seq > answer.seq && e.data.item.kind === 'user');
  const late = {
    ...answer,
    seq: next.seq + 0.5,
    data: { ...answer.data, patch: { ...answer.data.patch, answer: { ...answer.data.patch.answer, at: next.data.item.at + 1000 } } },
  };
  const [t] = all(
    UAT.events.map((e) => (e === answer ? late : e)),
    UAT.live,
  ).map((x) => x.trajectory);
  const times = t.steps.map((s) => Date.parse(s.timestamp));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  const order = t.steps.map((s) => s.extra.item_id);
  assert.ok(order.indexOf(next.data.item.id) < order.lastIndexOf(answer.data.id), 'the answer comes after the message');
});
