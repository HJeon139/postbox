// Stop with Keep running behind a held commit (#1042): the progress step that follows the kept job runs on, as it
// does unheld (#129), though Stop's own write of heldSteps is only pending when it settles the turn's steps.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { fakeKill, slowToExit } from './stop-fixture.mjs';
import { heldStore, until } from './stop-reply-fixture.mjs';

class Scripted {
  name = 'mock';
  next = [];
  async folderFor() {
    return null;
  }
  async deliver(_session, message, ctx) {
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx, message);
  }
}

/** A conversation with @developer on `store`, which kills nothing real and lists no processes. */
function rig(store) {
  const adapter = new Scripted();
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    signalProcess: fakeKill().kill,
    listProcesses: async () => [],
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'developer' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { store, rt, adapter, t, se: rt.sessionsIn(t.id)[0] };
}

/**
 * A turn running a background job, with a progress step running that follows it, stopped with `jobs`; held: Stop
 * comes while a commit is held, released before the turn's process exits. Returns the step's state once it has, and
 * what the agent was told.
 * @param {{ held: boolean, jobs?: 'keep' }} opts
 */
async function stopped({ held, jobs }) {
  const h = held ? await heldStore() : null;
  const { store, rt, adapter, t, se } = rig(h ? h.store : new Store(null));
  const turn = slowToExit({ job: { id: 'bgH', command: 'heartbeat loop' } });
  adapter.next.push(turn);
  rt.sendMessage(t.id, { text: 'go' });
  await until(() => (store.pending.session(se.id).jobs ?? []).some((j) => j.id === 'bgH'), 'the job to start');
  const block = rt.addItem(t.id, {
    kind: 'block',
    sessionId: se.id,
    valid: true,
    block: {
      id: 'hb',
      type: 'progress',
      version: 1,
      title: 'Heartbeat',
      fallback: 'Heartbeat',
      steps: [{ id: 'w', label: 'Write heartbeat-1.log', state: 'running' }],
    },
  });
  await store.flush();
  let commit = null;
  if (h) {
    h.hold();
    commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
  }
  rt.stop(se.id, { jobs });
  if (h) {
    h.release();
    await commit;
  }
  turn.exit();
  await until(() => !rt.exiting.has(se.id) && !rt.turns.has(se.id), 'the stopped turn to exit');
  await store.flush();
  const state = store.item(t.id, block.id).block.steps[0].state;
  const told = (store.state.sessions[se.id].context ?? []).join('\n');
  const kept = (store.state.sessions[se.id].jobs ?? []).filter((j) => j.kept).map((j) => j.id);
  if (h) await store.close();
  return { state, told, kept };
}

const STALLED_NOTE = /stopped your last turn while progress steps were running/;

test('control, unheld: Stop with Keep running leaves the step that follows the kept job running', async () => {
  const r = await stopped({ held: false, jobs: 'keep' });
  assert.deepEqual(r.kept, ['bgH']);
  assert.equal(r.state, 'running');
  assert.doesNotMatch(r.told, STALLED_NOTE);
});

test('Stop with Keep running behind a held commit leaves the step that follows the kept job running', async () => {
  const r = await stopped({ held: true, jobs: 'keep' });
  assert.deepEqual(r.kept, ['bgH'], 'the job was kept');
  assert.equal(r.state, 'running', 'the step runs on with it');
  assert.doesNotMatch(r.told, STALLED_NOTE, 'the agent isn’t asked to close a step that’s still being worked');
});

test('a plain Stop behind a held commit still stalls the step', async () => {
  const r = await stopped({ held: true });
  assert.deepEqual(r.kept, []);
  assert.equal(r.state, 'stalled');
  assert.match(r.told, STALLED_NOTE);
});
