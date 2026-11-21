// A retried turn on a host goes back as the failed turn would have (#1541): a reply that names no one reaches the agent
// whose @-mention started the turn (#1518), once, after a Retry of a turn that took no entries, as a continued host
// turn did (#1538). tests/remote-turns-retry.test.mjs has the rest of Retry on a host.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { rig, settled, starts, until } from './remote-turns-helpers.mjs';

/** Another agent, on this computer, in the conversation: what it’s sent is what its mock got. @param {any} r @param {any[]} [got] */
function lead(r, got = []) {
  r.rt.adapters.register({ name: 'mock', deliver: async (/** @type {any} */ _se, /** @type {any} */ m) => void got.push(m) });
  const p = arrange.persona(r.rt, 'lead') ?? r.rt.createPersona({ handle: 'lead', backend: 'mock' });
  return { se: r.rt.ensureSession(r.t.id, p.id), got };
}

const all = (/** @type {any} */ r) => Object.values(r.store.state.items).flat();
const threadOf = (/** @type {any} */ r, /** @type {any} */ it) => Object.keys(r.store.state.items).find((k) => r.store.state.items[k].includes(it));
const reads = (/** @type {any} */ d, /** @type {string} */ turn) => d.received.filter((/** @type {any} */ m) => m.type === 'read' && m.turn === turn);
const reply = (/** @type {any} */ r) => all(r).find((i) => i.kind === 'agent' && i.handle === 'coder' && i.status === 'done' && i.text);

/** Waits for the newest start’s turn to run on the host, and returns its ID. @param {any} r @param {number} n */
async function onHost(r, n) {
  await until(() => starts(r.d).length === n && r.d.turns.has(starts(r.d)[n - 1].turn), `start ${n} on the host`);
  const turn = starts(r.d)[n - 1].turn;
  await until(() => reads(r.d, turn).length > 0, 'its read');
  return turn;
}

test('#1541: a retried wake Interrupted on the host and resumed on its own still goes back once', async () => {
  const r = rig();
  const { se: a, got } = lead(r);
  assert.equal(r.rt.agentWake(a.id, 'coder', 'Is hello.txt there?').ok, true);
  r.hosts.state = 'reconnecting'; // so it waits to resume
  r.d.interrupt(await onHost(r, 1));
  await until(() => r.se().remoteTurn.state === 'interrupted', 'Interrupted');
  // The resume fails: Postbox doesn’t know its own version.
  const build = r.rt.config.build;
  r.rt.config.build = {};
  r.hosts.state = null;
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await until(() => all(r).some((i) => i.status === 'failed' && /its own version/.test(i.error ?? '')), 'the resume to fail');
  const failed = all(r).find((i) => i.status === 'failed' && /its own version/.test(i.error ?? ''));
  await settled(r);
  r.rt.config.build = build;
  r.rt.retry(threadOf(r, failed), failed.id);
  // The retried turn is Interrupted too, and resumed on its own: its record keeps whom it goes back to (#1538).
  r.d.interrupt(await onHost(r, 2));
  r.d.end(await onHost(r, 3));
  await settled(r);
  assert.equal(got.filter((m) => m.from === '@coder').length, 1, 'lead hears the answer once');
  assert.deepEqual(reply(r).wentBack, ['lead']);
});
