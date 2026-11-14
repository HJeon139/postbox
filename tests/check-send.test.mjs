// Where a lint turn goes (designs/architecture/services.md, “Checks” and “Ports”): the problems a finished turn left go
// back to its agent through the runtime’s deliver, looked up when the lint turn is sent, so a deliver put in place
// after the runtime was built is the one that runs, as tests/close-timers.test.mjs relies on. Checks is a service now,
// and reaches deliver only through the `send` port the root binds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

/** A runtime whose one agent replies at once, with a deliver swapped in after it was built. */
function setup() {
  const store = new Store(null);
  const adapter = {
    name: 'mock',
    async deliver(_se, _m, ctx) {
      ctx.text('Done');
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/proj' });
  const a = rt.createPersona({ handle: 'dev' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const se = arrange.agentIn(rt, t.id, 'dev');
  const deliver = rt.deliver.bind(rt);
  /** @type {any[]} */
  const lintTurns = [];
  rt.deliver = (sessionId, message, opts) => {
    if (message.kind === 'lint') {
      lintTurns.push({ sessionId, message, opts });
      return Promise.resolve();
    }
    return deliver(sessionId, message, opts);
  };
  return { rt, store, t, se, lintTurns };
}

const settle = async (rt) => {
  for (let i = 0; i < 100 && arrange.liveTurns(rt); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
};

test('a turn that left a progress step running sends its lint turn through the deliver in place when it goes', async () => {
  const { rt, store, t, se, lintTurns } = setup();
  const block = arrange.post(rt, t.id, {
    kind: 'block',
    valid: true,
    sessionId: se.id,
    block: { type: 'progress', id: 'b1', title: 'Plan', steps: [{ id: 's1', label: 'Fetch', state: 'running' }] },
  });
  await rt.deliver(se.id, { text: 'go' });
  await settle(rt);
  assert.equal(store.item(t.id, block.id).block.steps[0].state, 'stalled');
  assert.equal(lintTurns.length, 1);
  assert.equal(lintTurns[0].sessionId, se.id);
  assert.deepEqual(
    lintTurns[0].message.problems.map((p) => p.code),
    ['steps-left-running'],
  );
  assert.deepEqual(lintTurns[0].opts, { threadId: t.id });
});
