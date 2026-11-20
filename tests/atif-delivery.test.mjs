// What reached an agent, in its ATIF trajectory (tools/atif.mjs, noteTake): each message as it was when one of its
// turns first took it, whatever later edits or a retry’s give-back do to the final state. Built from the recorded run
// in tests/fixtures/atif/dry-run.md, with one later event added in each test, as the store writes such events.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';

const rec = readRecording(new URL('fixtures/atif/dry-run/', import.meta.url).pathname);
const dryOf = (events) => trajectories(events, { version: POSTBOX_VERSION, live: rec.live }).find((t) => t.handle === 'dry').trajectory;
const sessionId = rec.events.find((e) => e.type === 'session' && e.data.handle === 'dry').data.id;
// @dry’s first message, and the patch that took its entry.
const take = rec.events.find((e) => e.type === 'entry.patch' && e.data.sessionId === sessionId && e.data.patch.takenBy);
const entry = rec.events.find((e) => e.type === 'entry.add' && e.data.entry.id === take.data.id).data.entry;
const item = rec.events.find((e) => e.type === 'item.add' && e.data.item.id === entry.itemId).data.item;
const last = Math.max(...rec.events.map((e) => e.seq));
/** How the trajectory says the message reached @dry: carried by the prompt of the turn that took it. */
const carried = (t) => t.steps.flatMap((s) => (s.extra.delivered ?? []).map((d) => ({ ...d, turn: s.extra.turn_id }))).find((d) => d.item_id === item.id);

test('a message edited after a turn took it shows as the agent read it, not as it was edited', () => {
  const edited = [...rec.events, { seq: last + 1, type: 'item.patch', data: { threadId: entry.threadId, id: item.id, patch: { text: 'Edited later.' } } }];
  const got = carried(dryOf(edited));
  assert.equal(got.text, item.text);
  assert.equal(got.turn, take.data.patch.takenBy);
});

test('a message a retry gave back to the inbox after a turn took it still reached the agent', () => {
  // As server/delivery.mjs’s turnFailed gives a lost turn’s entries back: waiting again, taken by no turn.
  const givenBack = [
    ...rec.events,
    { seq: last + 1, type: 'entry.patch', data: { sessionId, id: entry.id, patch: { state: 'waiting', takenBy: null, resend: true } } },
  ];
  assert.equal(carried(dryOf(givenBack)).text, item.text);
});

test('a subagent’s own words are narration on its reply, not a tool call', () => {
  // A step as server/harness-text.mjs’s narrate adds one, on @dry’s first reply.
  const reply = rec.events.find((e) => e.type === 'item.add' && e.data.item.sessionId === sessionId && e.data.item.kind === 'agent').data;
  const said = { id: 'said-1', label: 'Found the file.', state: 'done', kind: 'said', detail: 'Found the file. It has two lines.', who: 'Explore' };
  const events = [...rec.events, { seq: last + 1, type: 'item.patch', data: { threadId: reply.threadId, id: reply.item.id, activityStep: said } }];
  const step = dryOf(events).steps.find((s) => s.extra.item_id === reply.item.id);
  assert.equal(
    step.tool_calls.some((c) => c.tool_call_id === 'said-1'),
    false,
  );
  assert.equal(
    step.observation.results.some((r) => r.source_call_id === 'said-1'),
    false,
  );
  assert.deepEqual(step.extra.narration, [{ step_id: 'said-1', text: said.detail, who: 'Explore' }]);
});
