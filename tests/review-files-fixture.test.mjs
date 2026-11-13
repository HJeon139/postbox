// The turn helper the tool-call tests share (tests/review-files-fixture.mjs): it gives the step’s own result, however
// long the step takes, and its error, and only once the turn has ended (#779).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { duringTurn } from './review-files-fixture.mjs';

/** An adapter that runs each turn’s step. */
class Steps {
  name = 'mock';
  next = [];
  async deliver(_se, _m, ctx) {
    await (this.next.shift() ?? (async () => {}))(ctx);
  }
}

function setup() {
  const store = new Store(null);
  const adapter = new Steps();
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: null });
  const a = rt.createPersona({ handle: 'alpha' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  return { rt, adapter, t };
}

test('#779 a step that outlasts the old 500 ms poll still gives its result', async () => {
  const { rt, adapter, t } = setup();
  const out = await duringTurn(rt, adapter, t.id, async () => {
    await new Promise((r) => setTimeout(r, 600));
    return { result: 'late' };
  });
  assert.deepEqual(out, { result: 'late' });
});

test('#779 a step that fails rejects with its own error, rather than hanging the test', { timeout: 5000 }, async () => {
  const { rt, adapter, t } = setup();
  await assert.rejects(
    duringTurn(rt, adapter, t.id, async () => {
      throw new Error('the step broke');
    }),
    /the step broke/,
  );
});

test('#779 the helper gives the result only once the turn has ended', async () => {
  const { rt, adapter, t } = setup();
  await duringTurn(rt, adapter, t.id, async () => 'done');
  assert.equal(arrange.liveTurns(rt), 0);
});
