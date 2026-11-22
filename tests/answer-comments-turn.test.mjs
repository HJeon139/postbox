// #1253: another agent reads the comments that came with the person’s review on the answer line, in its turn’s own
// input (turnTail, which reads with no session: critic’s review of PR #1600), and each answer keeps its own comments
// when the agent revises the review and the person answers again.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup, turn } from './blocks-fixture.mjs';

const review = { id: 'plan', type: 'review', version: 1, title: 'Release plan', format: 'markdown', content: 'Ship Friday.', fallback: 'The plan.' };

/** The fixture’s @critic shows the review; @lead is another agent of the room. */
async function room() {
  const f = setup();
  const lead = f.rt.createPersona({ handle: 'lead' });
  f.rt.ensureSession(f.t.id, lead.id);
  await turn(f.rt, f.adapter, f.t, (tools) => tools.show_block({ block: review }));
  const item = f.store.items(f.t.id).find((i) => i.kind === 'block');
  const leadSe = () => Object.values(f.store.state.sessions).find((x) => x.handle === 'lead' && x.threadId === f.t.id);
  return { ...f, item, leadSe };
}

test('#1253: the answer line in another agent’s turn input carries the review’s comments', async () => {
  const f = await room();
  // Its marker is past the draft already, as critic’s probe had it: only the answer line is new.
  f.rt.sessions.update(f.leadSe().id, { seenItem: f.item.id });
  f.rt.act(f.t.id, f.item.id, 'submit', { verdict: 'request_changes', comments: [{ line: 1, text: 'Fix the date.' }] });
  await settle(f.rt);
  const { tail } = f.rt.memory.turnTail(f.leadSe(), []);
  const line = tail.find((l) => l.includes('Request changes'));
  assert.ok(line, tail.join('\n'));
  assert.match(line, /line 1: Fix the date\./);
});

test('#1253: each answer line keeps its own comments when the review is revised and answered again', async () => {
  const f = await room();
  f.rt.act(f.t.id, f.item.id, 'submit', { verdict: 'request_changes', comments: [{ line: 1, text: 'Fix the date.' }] });
  await settle(f.rt);
  const r = await turn(f.rt, f.adapter, f.t, (tools) => tools.update_block({ block: { ...review, content: 'Ship Monday.' } }));
  assert.equal(r.ok, true, r.message);
  f.rt.act(f.t.id, f.item.id, 'submit', { verdict: 'approve', comments: [{ line: 1, text: 'Ready to ship.' }] });
  await settle(f.rt);
  const { tail } = f.rt.memory.turnTail(f.leadSe(), []);
  const first = tail.find((l) => l.includes('Request changes'));
  const second = tail.find((l) => l.includes('Approve'));
  assert.ok(first && second, tail.join('\n'));
  assert.match(first, /Fix the date\./);
  assert.doesNotMatch(first, /Ready to ship/);
  assert.match(second, /Ready to ship\./);
});
