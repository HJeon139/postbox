// #425: a compaction the harness doesn’t count (Codex’s, recorded in tests/fixtures/codex-app-server/compact.jsonl)
// still shows in the room, with no counts made up, and leaves the ring’s context reading to the next one. A total of 0
// is a count the harness didn’t give (Claude Code’s stream with no pre_tokens), and shows nothing, as before.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { HarnessEvents } from '../server/harness-events.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

/** A room whose one agent emits `events` through the contract, and the room once its turn ends. @param {any[]} events */
async function roomAfter(events) {
  const store = new Store(null);
  const adapter = {
    name: 'mock',
    async folderFor() {
      return null;
    },
    async deliver(/** @type {any} */ _se, /** @type {any} */ _m, /** @type {any} */ ctx) {
      const emit = new HarnessEvents(ctx).event;
      for (const e of events) emit(e);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'gpt' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = arrange.sessionsIn(rt, t.id)[0];
  rt.sessions.update(se.id, { ctx: 61 });
  rt.sendMessage(t.id, { text: 'Go.' });
  for (let i = 0; i < 400 && (rt.turns.size || !store.items(t.id).some((x) => x.kind === 'agent')); i++) await new Promise((r) => setTimeout(r, 5));
  return { lines: store.items(t.id).filter((x) => x.variant === 'compaction'), session: store.state.sessions[se.id] };
}

test('#425 a compaction with no counts shows in the room, makes none up, and leaves the context reading as it was', async () => {
  const { lines, session } = await roomAfter([
    { kind: 'compaction', summary: 'Codex summarized the earlier conversation to make room.' },
    { kind: 'turn_end' },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kept, undefined);
  assert.equal(lines[0].total, undefined);
  assert.equal(lines[0].summary, 'Codex summarized the earlier conversation to make room.');
  assert.equal(session.compactions, 1);
  assert.equal(session.ctx, 61, 'no reading made up from counts it doesn’t have');
});

test('#425 a counted compaction sets the context reading from its counts, and a total of 0 shows nothing', async () => {
  const counted = await roomAfter([{ kind: 'compaction', kept: 20_000, total: 200_000, summary: 's' }, { kind: 'turn_end' }]);
  assert.deepEqual([counted.lines.length, counted.lines[0].kept, counted.lines[0].total, counted.session.ctx], [1, 20_000, 200_000, 10]);
  const zero = await roomAfter([{ kind: 'compaction', kept: 0, total: 0, summary: 's' }, { kind: 'turn_end' }]);
  assert.equal(zero.lines.length, 0);
  assert.equal(zero.session.compactions, 0);
});
