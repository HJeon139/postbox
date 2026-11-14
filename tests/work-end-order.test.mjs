// Where a turn’s work is recorded among the steps of its end (designs/architecture/services.md, “The end of a turn” and
// “Risks”): after the turn leaves Running, and before its reply settles and a failed turn fails its session. Work is a
// service now, and Turns isn’t yet, so this holds the order through the facade until the end steps are named.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Ledger } from '../server/ledger.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { fakeGit, memIo } from './work-replay.mjs';

/** A runtime whose one agent runs each step it’s given, and whose ledger notes what stood when each turn ended. */
function setup() {
  const store = new Store(null);
  const ledger = new Ledger({ store, io: memIo(), git: fakeGit([]), now: Date.now });
  const adapter = {
    name: 'mock',
    /** @type {((c: any) => Promise<void>)[]} */
    next: [],
    async deliver(_se, _m, ctx) {
      await (this.next.shift() ?? (async (c) => c.text('ok')))(ctx);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    ledger,
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/proj' });
  const a = rt.createPersona({ handle: 'dev' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const se = arrange.agentIn(rt, t.id, 'dev');
  /** @type {any[]} what stood each time the ledger heard a turn end */
  const seen = [];
  const endTurn = ledger.endTurn.bind(ledger);
  ledger.endTurn = (turn, opts) => {
    const reply = store.pending.items(t.id).findLast((x) => x.kind === 'agent' && x.turnId === turn.id);
    seen.push({ status: opts.status, live: arrange.running(rt, se.id), reply: reply?.status, session: store.pending.session(se.id)?.state });
    return endTurn(turn, opts);
  };
  return { rt, store, adapter, t, se, seen, ledger };
}

const settle = async (rt, ledger) => {
  for (let i = 0; i < 100 && arrange.liveTurns(rt); i++) await new Promise((r) => setTimeout(r, 5));
  await ledger.idle();
  await new Promise((r) => setTimeout(r, 5));
};

test('a turn’s work is recorded after it leaves Running and before its reply settles, and the reply then carries its line', async () => {
  const { rt, store, adapter, t, se, seen, ledger } = setup();
  adapter.next.push(async (c) => {
    c.toolUse({ id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } });
    c.toolResult({ id: 'toolu_1', text: 'ok' });
    c.text('Tests pass');
  });
  await rt.deliver(se.id, { text: 'hi' });
  await settle(rt, ledger);
  assert.deepEqual(seen, [{ status: 'done', live: false, reply: 'streaming', session: 'gen' }], 'the session still generates: its state settles after');
  const reply = store.items(t.id).findLast((x) => x.kind === 'agent');
  assert.equal(reply.status, 'done');
  assert.notEqual(store.state.sessions[se.id].state, 'gen');
  assert.equal(reply.workTurn, reply.turnId, 'the line comes once the ledger has the turn’s end');
});

test('a failed turn’s work is recorded as failed before its session fails', async () => {
  const { rt, store, adapter, se, seen, ledger } = setup();
  adapter.next.push(async (c) => {
    c.text('Partly');
    throw new Error('the backend went away');
  });
  await rt.deliver(se.id, { text: 'hi' });
  await settle(rt, ledger);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 'failed');
  assert.equal(seen[0].live, false);
  assert.equal(seen[0].reply, 'streaming', 'the reply fails after the ledger hears the end');
  assert.equal(seen[0].session, 'gen', 'and so does the session');
  assert.equal(store.state.sessions[se.id].state, 'failed');
  assert.equal(store.items(se.threadId).findLast((x) => x.kind === 'agent').status, 'failed');
});
