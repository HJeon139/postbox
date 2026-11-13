// Whether an agent waits for its host turn to be attached again after a restart (#1135) follows the state Retry
// installs. Running keeps the sessions awaiting attach, so a move held behind a commit that fails, then dropped by
// Retry, mustn’t leave an entry that no longer matches where the agent runs (#1303’s review).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageOf, restarted, rig, settled, sleep, starts, startUp, until } from './remote-turns-helpers.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** The restart window on a store on disk, with the host’s welcome held until releaseWelcome(). */
async function heldWindow() {
  const h = await heldStore();
  const { store, d } = restarted({ welcome: 'running', store: h.store });
  const r = rig({ store, d });
  let releaseWelcome = () => {};
  const held = new Promise((res) => {
    releaseWelcome = res;
  });
  const ensure = r.hosts.ensureWelcome;
  r.hosts.ensureWelcome = async (/** @type {string} */ hostId) => {
    if (hostId === r.host.id) await held;
    return ensure(hostId);
  };
  startUp(r);
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
  await h.store.flush();
  return { r, d, h, releaseWelcome };
}

/** Runs fn behind a commit whose fsync then fails, closing writes, and retries: the disk’s state is installed. */
async function droppedByRetry(h, fn) {
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  fn();
  h.release(Object.assign(new Error('disk sync refused'), { code: 'EIO' }));
  await commit.catch(() => {});
  await h.store.flush().catch(() => {});
  await h.store.reload();
}

const queued = (r) => (r.store.pending.thread(r.t.id)?.queue ?? []).map((q) => q.text);
const moveTo = (r, hostId) => r.rt.updatePersona(r.se().personaId, { remote: hostId ? { hostId } : null });

test('#1135 a move off the silent host that Retry drops leaves the agent waiting for the attach', async () => {
  const { r, d, h, releaseWelcome } = await heldWindow();
  await droppedByRetry(h, () => moveTo(r, null));
  assert.equal(r.rt.persona(r.se().personaId).remote?.hostId, r.host.id, 'Retry put the agent back on the host');
  r.rt.sendMessage(r.t.id, { text: 'after the retry' });
  await sleep(20);
  assert.equal(starts(d).length, 0, 'no second turn on the host');
  assert.deepEqual(queued(r), ['after the retry'], 'it waits in the queue for the attach');
  releaseWelcome();
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach');
  d.end('host-turn-1');
  await until(() => starts(d).length === 1, 'the queued message’s turn');
  assert.match(messageOf(starts(d)[0]), /after the retry/);
  d.end(starts(d)[0].turn);
  await settled(r);
});

test('#1135 a move back onto the silent host that Retry drops leaves the agent free where it runs', async () => {
  const { r, d, h, releaseWelcome } = await heldWindow();
  const other = r.rt.addHost({ name: 'other.example.com' });
  moveTo(r, other.id);
  await h.store.flush();
  await droppedByRetry(h, () => moveTo(r, r.host.id));
  assert.equal(r.rt.persona(r.se().personaId).remote?.hostId, other.id, 'Retry left the agent on the other host');
  r.rt.sendMessage(r.t.id, { text: 'after the retry' });
  assert.deepEqual(queued(r), [], 'the silent host’s turn holds nothing back');
  await until(() => starts(d).length === 1, 'its turn where it runs now');
  assert.match(messageOf(starts(d)[0]), /after the retry/);
  d.end(starts(d)[0].turn);
  await settled(r);
  releaseWelcome();
});
