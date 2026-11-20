// Which model an ATIF step names (tools/atif.mjs): the one its backend reported for its turn. The fixture is a
// recorded /api/stream: tests/fixtures/atif/dry-run.md says how it was made.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';

const rec = readRecording(new URL('fixtures/atif/dry-run/', import.meta.url).pathname);
const of = (handle, events = rec.events) => trajectories(events, { version: POSTBOX_VERSION, live: rec.live }).find((t) => t.handle === handle).trajectory;

test('each reply names the model that ran it, and the trajectory names a default only when one model ran it all', () => {
  // The recorded run replays a Claude Code turn on claude-sonnet-5-5, then two on claude-opus-5-5 (dry-run.md).
  const t = of('dry');
  assert.deepEqual(
    t.steps.filter((s) => s.source === 'agent').map((s) => s.model_name),
    ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5'],
  );
  assert.equal(t.agent.model_name, undefined, 'no default: two models ran');
  assert.deepEqual(t.agent.extra.models, ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.equal(of('dry2').agent.model_name, 'claude-sonnet-5-5');
});

test('a model a turn reports only after its first words is still that turn’s, not the one before', () => {
  // The order Codex can give (server/adapters/codex.mjs, the model on turn/completed): the session ran `old`, the new
  // turn’s reply is added, and then the turn reports `new`. Each event as the recorded run shapes it (dry-run.md).
  const turn = { id: 'turn_2', kind: 'turn', sessionId: 'se_1', handle: 'dry', startedAt: 10 };
  const events = [
    { seq: 1, type: 'session', data: { id: 'se_1', handle: 'dry', threadId: 'th_1', backend: 'codex', lastModel: 'old' } },
    { seq: 2, type: 'work.add', data: { convId: 'th_1', entry: turn } },
    {
      seq: 3,
      type: 'item.add',
      data: { threadId: 'th_1', item: { id: 'it_r', at: 11, kind: 'agent', sessionId: 'se_1', handle: 'dry', turnId: 'turn_2', text: 'Done.' } },
    },
    { seq: 4, type: 'session.patch', data: { id: 'se_1', patch: { lastModel: 'new' } } },
    { seq: 5, type: 'work.patch', data: { convId: 'th_1', id: 'turn_2', patch: { status: 'done', endedAt: 12 } } },
  ];
  const [reply] = of('dry', events).steps.filter((s) => s.source === 'agent');
  assert.equal(reply.model_name, 'new');
});

test('steps from a new epoch, numbered from lower again after a restart, come after the old epoch’s', () => {
  // As the UAT kit’s recorder keeps them (tools/uat/history.mjs): epoch 0 to seq 100, then epoch 1 from seq 1.
  const events = [
    { seq: 99, type: 'session', data: { id: 'se_1', handle: 'dry', threadId: 'th_1', backend: 'claude-code', lastModel: 'old' } },
    { seq: 100, type: 'clock.started', data: { sessionId: 'se_1', threadId: 'th_1', budgetMs: 60_000, at: 1_000 } },
    { seq: 1, epoch: 1, type: 'clock.restored', data: { sessionId: 'se_1', elapsedMs: 30_000, budgetMs: 60_000, at: 2_000 } },
    {
      seq: 2,
      epoch: 1,
      type: 'item.add',
      data: { threadId: 'th_1', item: { id: 'it_r', at: 3_000, kind: 'agent', sessionId: 'se_1', handle: 'dry', text: 'After.' } },
    },
  ];
  const t = of('dry', events);
  assert.deepEqual(
    t.steps.map((s) => s.extra.event ?? s.extra.item_id),
    ['clock.started', 'clock.restored', 'it_r'],
  );
  const times = t.steps.map((s) => Date.parse(s.timestamp));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
});
