// A session’s changes travel as session.patch, carrying only the fields that changed (designs/508, “Store events”;
// the “Now” step of the rollout). The shared reducer applies it; the checks’ history keeps reading whole sessions.
// The size check replays streams recorded from real Claude Code turns (claude 2.1.296, local paths removed; their
// sources are in tests/agent-activity.test.mjs): subagent-tree.jsonl (#73, 23 October 2026), monitor.jsonl (#129,
// 23 October 2026), background-subagent.jsonl (#189, 23 October 2026) and block.jsonl (tests/claude-code.test.mjs).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { keepEvent } from '../server/room-events.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
import { setup as telemetrySetup, turn } from './telemetry-fixture.mjs';

const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** The store’s events since `from`, as the browser receives them: each line, parsed. */
const linesSince = (store, from) => store.events.filter((e) => e.seq > from).map((e) => ({ ...JSON.parse(e.line), bytes: Buffer.byteLength(e.line) }));

test('the shared reducer merges a session.patch into its session, and drops the fields it unsets', () => {
  const s = emptyState();
  apply(s, 'session', { id: 'se_1', handle: 'alpha', state: 'idle', ctx: 10, needs: { kind: 'block' } });
  apply(s, 'session.patch', { id: 'se_1', patch: { state: 'think', ctx: 12 }, unset: ['needs'] });
  assert.deepEqual(s.sessions.se_1, { id: 'se_1', handle: 'alpha', state: 'think', ctx: 12 });
  // A patch for a session that’s gone (removed in between) changes nothing and doesn’t throw.
  apply(s, 'session.patch', { id: 'se_gone', patch: { state: 'think' } });
  assert.equal(Object.hasOwn(s.sessions, 'se_gone'), false);
});

test('updateSession emits a session.patch with only the changed fields, not the whole session', () => {
  const { store, rt, alpha } = setup();
  const from = store.state.seq;
  rt.updateSession(alpha.id, { state: 'think', currentStep: 'Thinking', handle: alpha.handle });
  const [ev, ...rest] = linesSince(store, from);
  assert.equal(rest.length, 0);
  assert.equal(ev.type, 'session.patch');
  assert.equal(ev.data.id, alpha.id);
  // handle didn’t change, so it isn’t sent; updatedAt always is.
  assert.deepEqual(Object.keys(ev.data.patch).sort(), ['currentStep', 'state', 'updatedAt']);
  assert.equal(store.state.sessions[alpha.id].state, 'think');
  assert.equal(store.state.sessions[alpha.id].handle, alpha.handle);
  // A field set to undefined is gone from the session, as it was when the whole session went as JSON.
  rt.updateSession(alpha.id, { currentStep: undefined });
  assert.equal(Object.hasOwn(store.state.sessions[alpha.id], 'currentStep'), false);
  assert.deepEqual(linesSince(store, from).at(-1).data.unset, ['currentStep']);
});

test('live session events from recorded Claude Code turns average under 1 KB', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  const from = store.state.seq;
  for (const name of ['subagent-tree', 'monitor', 'background-subagent', 'block']) {
    adapter.next.push(async (ctx) => {
      const m = createStreamMapper(ctx);
      for (const e of fixture(name)) m.push(e);
    });
    rt.sendMessage(t.id, { text: `@alpha replay ${name}` });
    await settle(rt);
  }
  const live = linesSince(store, from).filter((e) => (e.type === 'session' || e.type === 'session.patch') && e.data.id === alpha.id);
  assert.ok(live.length > 50, `${live.length} session events: the replay reached the session`);
  const average = live.reduce((n, e) => n + e.bytes, 0) / live.length;
  assert.ok(average < 1024, `live session events average ${Math.round(average)} bytes over ${live.length} events`);
});

test('the checks’ history keeps a session.patch as the whole session it leaves, so they read state and finishedAt', () => {
  const sessions = new Map();
  keepEvent(1, 'session', { id: 'se_1', state: 'think', finishedAt: null, updatedAt: 1 }, sessions);
  const kept = keepEvent(2, 'session.patch', { id: 'se_1', patch: { ctx: 30, updatedAt: 2 } }, sessions);
  assert.deepEqual(kept, { seq: 2, type: 'session', data: { id: 'se_1', state: 'think', finishedAt: null, updatedAt: 2 } });
  const ended = keepEvent(3, 'session.patch', { id: 'se_1', patch: { state: 'idle', finishedAt: 5, updatedAt: 3 } }, sessions);
  assert.deepEqual(ended?.data, { id: 'se_1', state: 'idle', finishedAt: 5, updatedAt: 3 });
});

test('a recorded room keeps a session’s session.patch as the whole session, so its report reads each turn’s start and end', async () => {
  const f = telemetrySetup({ record: true });
  f.adapter.next.push(turn('Done.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha run the tests' });
  await settle(f.rt);
  f.stop();
  const kept = readFileSync(join(f.data, 'telemetry', f.t.id, 'recording', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'session' || e.type === 'session.patch');
  assert.ok(kept.length >= 2, `${kept.length} session events recorded`);
  assert.ok(
    kept.every((e) => e.type === 'session'),
    'each is kept as a session',
  );
  assert.ok(kept.some((e) => e.data.state === 'think' && e.data.finishedAt === null) && kept.at(-1).data.finishedAt !== null, 'a turn starting and ending');
});

test('#508: the checks’ history ignores a session.patch for a session it hasn’t seen whole, rather than building one from the patch', () => {
  // A stream that starts after a session existed would otherwise keep it as { id, ...patch }, and blockHistory would
  // misread its turns (integrator review of #537).
  const sessions = new Map();
  assert.equal(keepEvent(5, 'session.patch', { id: 'se_new', patch: { state: 'think', updatedAt: 5 } }, sessions), null);
  assert.equal(sessions.has('se_new'), false);
  keepEvent(6, 'session', { id: 'se_new', state: 'idle', finishedAt: 1, updatedAt: 6 }, sessions);
  assert.equal(keepEvent(7, 'session.patch', { id: 'se_new', patch: { state: 'think', updatedAt: 7 } }, sessions)?.data.state, 'think');
});
