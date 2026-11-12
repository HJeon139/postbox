// A turn’s steps fold to what its record keeps however it ends (shared/step-fold.mjs): it finishes, it’s stopped, or a
// restart cuts it off. The live view’s detail (a call’s input and output, where it fell in the words, a thought whole)
// goes with the turn, or every stopped or interrupted turn would keep it in the room’s state for good.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { HarnessEvents } from '../server/harness-events.mjs';
import { settleInterrupted } from '../server/restart-sweep.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { STEP_TEXT } from '../shared/limits.mjs';

const THOUGHT = 'Why the sum is wrong. '.repeat(250).trim(); // 5,000 characters or so, past what a record keeps

/** A runtime whose one agent thinks, runs a command, then waits until the test is done with it. */
function heldTurn() {
  const store = new Store(null);
  let waiting = false;
  const adapter = {
    name: 'mock',
    async folderFor() {
      return null;
    },
    async deliver(/** @type {any} */ _se, /** @type {any} */ _m, /** @type {any} */ ctx) {
      const emit = new HarnessEvents(ctx).event;
      emit({ kind: 'thinking', text: THOUGHT, block: 'th1' });
      emit({ kind: 'thinking_end', block: 'th1' });
      emit({ kind: 'text', text: 'Running the tests.' });
      emit({ kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'npm test' }, final: true });
      emit({ kind: 'tool_result', id: 'b1', text: '3 passed' });
      waiting = true;
      await new Promise((r) => ctx.signal?.addEventListener('abort', r));
    },
  };
  const config = { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 };
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(adapter), config });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'dev' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return {
    store,
    rt,
    adapter,
    t,
    se: () => rt.sessionsIn(t.id)[0],
    reply: () => store.items(t.id).find((x) => x.kind === 'agent' && x.activity),
    async started() {
      rt.sendMessage(t.id, { text: 'Go.' });
      for (let i = 0; i < 400 && !waiting; i++) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

/** Each step as its record keeps it: none of the live view’s detail, and a thought cut to other detail’s length. */
function assertFolded(/** @type {any[]} */ steps) {
  assert.ok(steps.length >= 2, JSON.stringify(steps));
  for (const s of steps) for (const k of ['input', 'output', 'diff', 'at', 'part']) assert.equal(s[k], undefined, `${s.label}: no ${k}`);
  assert.equal(steps.find((s) => s.kind === 'thought').detail.length, STEP_TEXT.detail);
}

test('a turn you stop folds its steps, as one that finishes does', async () => {
  const run = heldTurn();
  await run.started();
  assert.ok(
    run.reply().activity.steps.some((s) => s.input),
    'the live view’s detail while it runs',
  );
  run.rt.stop(run.se().id);
  for (let i = 0; i < 200 && run.rt.turns.size; i++) await new Promise((r) => setTimeout(r, 5));
  assertFolded(run.reply().activity.steps);
});

test('a turn a restart cut off folds its steps when Postbox starts again', async () => {
  const run = heldTurn();
  await run.started();
  // A second runtime on the same store, as a restart makes one, with the restart’s sweep run.
  const rt = new Runtime({
    store: run.store,
    adapters: new AdapterRegistry().register(run.adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  settleInterrupted(rt);
  assertFolded(run.reply().activity.steps);
});
