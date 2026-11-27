// #1797: deleting a persona stops its sessions’ turns, and each backend forgets it. A local Claude Code turn stops on a
// SIGINT the CLI handles in its own time, and its adapter’s forget removed memory/<persona id> at once, while the CLI
// could still write its auto memory as it exits, making the folder again. So each backend forgets the persona only once
// its stopped local turns have exited, as #1680 has a host wait for its turn there (#1789). A backend here stands in for
// the CLI: its turn ends only when the test lets it, after the stop.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { untilTurns } from './until-turns.mjs';

test('#1797 a persona deleted while its turn is still exiting is forgotten only once that turn has exited', async () => {
  const store = new Store(null);
  /** @type {() => void} */
  let exit = () => {};
  const forgot = /** @type {string[]} */ ([]);
  const cli = {
    name: 'slow-exit',
    async deliver(/** @type {any} */ _se, /** @type {any} */ _message, /** @type {any} */ ctx) {
      await new Promise((r) => ctx.signal.addEventListener('abort', r, { once: true }));
      // Stopped: the process ends in its own time, as a CLI handling SIGINT does.
      await new Promise((r) => {
        exit = () => r(undefined);
      });
    },
    forget: async (/** @type {any} */ p) => {
      forgot.push(p.id);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(/** @type {any} */ (cli)),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/nonexistent' });
  const p = rt.createPersona({ handle: 'slow', backend: 'slow-exit' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  rt.sendMessage(t.id, { text: 'Work on it.' });
  await untilTurns(() => rt.turns.size === 1, 'the turn to start');
  const { forgotten } = rt.deletePersona(p.id);
  assert.equal(store.state.personas[p.id], undefined, 'the persona is gone at once');
  // Its turn is stopped but hasn’t exited. A forget that didn’t wait would have run by the next turn of the event
  // loop, which runs every microtask a wait already settled would take.
  assert.equal(rt.exiting.size, 1, 'the stopped turn is exiting');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(forgot, [], 'not forgotten while its turn is still exiting');
  exit();
  await untilTurns(() => forgot.length > 0, 'it to be forgotten once its turn has exited');
  await forgotten;
  assert.deepEqual(forgot, [p.id], 'forgotten once it has exited');
  assert.equal(rt.exiting.size, 0);
});
