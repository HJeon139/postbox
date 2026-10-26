// The runtime’s remote turns (#120, the plan’s L5; tests/remote-turns.test.mjs says how): a Postbox restart during a
// turn on a host, the turns it gives up after one, and the offsets it keeps.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOrigin } from '../server/remote/turns-origin.mjs';
import { FIXTURE_PROMPT } from './fake-daemon.mjs';
import { messageOf, restarted, rig, running, settled, sleep, starts, startUp, until } from './remote-turns-helpers.mjs';

// ── 6. A Postbox restart ─────────────────────────────────────────────────────────────

test('#120 L5: after a restart a turn still running on the host is attached from offset 0, its card waits again, and the reply is rebuilt', async () => {
  const { store, d } = restarted();
  const r = rig({ store, d });
  startUp(r);
  // The card stays open: the host still has its prompt.
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.equal(card.status, 'open');
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach’s read');
  const read = d.received.find((m) => m.type === 'read' && m.turn === 'host-turn-1' && !m.log);
  assert.equal(read.from, 0);
  assert.equal(starts(d).length, 0, 'attached, not started again');
  const old = r.store.items(r.t.id).find((i) => i.turnId === 'turn_old' && i.kind === 'agent');
  assert.deepEqual({ status: old.status, text: old.text }, { status: 'replaced', text: '' });
  // The prompt the host sent again (held until the attach started) is waited on by its card from before.
  await until(() => r.rt.permissionWaits.has(card.id), 'the card to wait again');
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => d.answers.length === 1, 'the answer');
  assert.deepEqual(d.answers[0], { turn: 'host-turn-1', id: 'p-1', result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  d.end('host-turn-1');
  await settled(r);
  const reply = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'done' && i.text);
  assert.match(reply.text, /hello\.txt/);
  assert.equal(r.se().remoteTurn.state, 'done');
});

test('#120 L5: after a restart a turn the welcome says ended is applied by replaying it', async () => {
  const { store, d } = restarted({ welcome: 'ended' });
  const r = rig({ store, d });
  startUp(r);
  await settled(r);
  await until(() => r.se().remoteTurn.state === 'done', 'the turn to be applied');
  assert.equal(starts(d).length, 0);
  assert.match(r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'done' && i.text).text, /hello\.txt/);
  // Its card’s prompt never came back once the turn was over: it can’t be answered now.
  assert.equal(r.store.items(r.t.id).find((i) => i.kind === 'permission').status, 'expired');
});

test('#120 L5, #135: a turn another agent woke, attached again after a restart, keeps its sender line’s woke', async () => {
  const { store, d } = restarted({ welcome: 'ended' });
  const r = rig({ store, d });
  const origin = { kind: 'agent', movesOn: false, from: 'lead', replyTo: null, replyIn: null, summarizeTo: null, woke: { by: 'lead' }, message: null };
  r.rt.updateSession(r.se().id, { remoteTurn: { ...r.se().remoteTurn, origin } });
  startUp(r);
  await settled(r);
  await until(() => r.se().remoteTurn.state === 'done', 'the turn to be applied');
  const reply = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'done' && i.text);
  assert.notEqual(reply.turnId, 'turn_old');
  assert.deepEqual(reply.woke, { by: 'lead' });
  assert.deepEqual(r.se().remoteTurn.origin, origin, 'kept for a second restart');
});

test('#120 L5, #377: an agent woken by another, attached again after a restart, answers in the conversation and wakes no one by itself', async () => {
  // The waker runs on this computer; what it’s sent is what each Postbox’s mock got.
  const lead = (/** @type {any} */ r, /** @type {any[]} */ got) => {
    r.rt.adapters.register({ name: 'mock', deliver: async (/** @type {any} */ _se, /** @type {any} */ m) => void got.push(m) });
    const p = r.rt.personaByHandle('lead') ?? r.rt.createPersona({ handle: 'lead', backend: 'mock' });
    return r.rt.ensureSession(r.t.id, p.id);
  };
  const first = rig();
  const a = lead(first, []);
  assert.equal(first.rt.agentWake(a.id, 'coder', 'Is hello.txt there?').ok, true);
  await until(() => starts(first.d).length === 1, 'the woken turn to start on the host');
  const turn = starts(first.d)[0].turn;
  await first.rt.stopTurns({ graceMs: 0 });
  first.d.drop();
  first.d.connect();
  const next = rig({ store: first.store, d: first.d });
  const got = [];
  lead(next, got);
  startUp(next);
  await until(() => next.d.received.filter((m) => m.type === 'read' && m.turn === turn).length > 1, 'the attach’s read');
  next.d.end(turn);
  await settled(next);
  const answer = next.store.items(next.t.id).find((i) => i.kind === 'agent' && i.handle === 'coder' && i.status === 'done' && i.text);
  assert.match(answer.text, /hello\.txt/, 'its answer is in the conversation, where it was woken');
  assert.deepEqual(answer.woke, { by: 'lead' });
  assert.equal(got.length, 0, 'a reply wakes the waker only by an @-mention (#377)');
  assert.equal(starts(next.d).length, 1, 'attached, not started again');
});

test('#120 L5: a record on disk naming no thread, or a handle that isn’t one, is ignored when the turn is attached again', async () => {
  const { store, d } = restarted({ welcome: 'ended' });
  const r = rig({ store, d });
  const se = r.se();
  const origin = {
    kind: 'agent',
    from: 'Lead',
    summarizeTo: 'constructor',
    woke: { by: 'lead', reply: true, in: '__proto__' },
  };
  r.rt.updateSession(se.id, { remoteTurn: { ...se.remoteTurn, threadId: 'hasOwnProperty', origin: { ...origin, message: { kind: 'user', text: 7 } } } });
  startUp(r);
  await settled(r);
  await until(() => r.se().remoteTurn.state === 'done', 'the turn to be applied');
  const reply = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'done' && i.text);
  assert.match(reply.text, /hello\.txt/);
  assert.deepEqual(reply.woke, { by: 'lead', reply: true });
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'shared').length, 0, 'no summary posted anywhere');
  // An unknown kind is an ordinary turn.
  assert.equal(readOrigin(r.rt, { ...origin, kind: 'bogus' }), null);
  assert.deepEqual(readOrigin(r.rt, { ...origin, message: { kind: 'user', text: 'hi' } }), {
    kind: 'agent',
    movesOn: false,
    from: 'lead',
    summarizeTo: null,
    woke: { by: 'lead', reply: true },
    // A request of another kind than the record’s isn’t one Retry can send: it’s lost, so Retry refuses it.
    message: null,
    lost: true,
  });
});

test('#120 L5: after a restart a turn the welcome doesn’t list is Interrupted, and resumes once the host is back', async () => {
  const { store, d } = restarted({ welcome: 'missing' });
  const r = rig({ store, d });
  startUp(r);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'Interrupted');
  const failed = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.match(failed.error, /^Interrupted on host\.example\.com: the host has no record of it\.$/);
  await until(() => starts(d).length === 1, 'the resume');
  assert.equal(starts(d)[0].env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, '1');
  assert.match(messageOf(starts(d)[0]), /was interrupted before it finished/);
  d.end(starts(d)[0].turn);
  await settled(r);
});

/**
 * A restart whose attach waits: the host’s welcome is held until open() (ensureWelcome), so the turn is still waiting
 * to be attached again. @param {any} [o]
 */
function waitingAttach(o) {
  const { store, d } = restarted(o);
  const r = rig({ store, d });
  /** @type {() => void} */
  let open = () => {};
  const held = new Promise((res) => {
    open = () => res(undefined);
  });
  const ensure = r.hosts.ensureWelcome;
  r.hosts.ensureWelcome = async (id) => {
    await held;
    return ensure(id);
  };
  startUp(r);
  return { r, d, open };
}
const reads = (d, turn) => d.received.filter((m) => m.type === 'read' && m.turn === turn);

test('#120 G10: removing a host gives up a turn still waiting to be attached after a restart: asked to stop there, never attached', async () => {
  const { r, d, open } = waitingAttach();
  await until(() => r.link.connected, 'the link');
  const se = r.se();
  // Moved off the host since: only the session’s own record (sessionsOn) says its turn is there.
  r.store.emit('persona', { ...r.rt.persona(se.personaId), remote: null });
  assert.deepEqual(r.rt.remote.sessionsOn(r.host.id), [se.id]);
  assert.deepEqual(await r.rt.removeHost(r.host.id, { waitMs: 50 }), { ok: true, stopped: 1 });
  await until(() => d.stops.includes('host-turn-1'), 'the stop on the host');
  assert.equal(r.store.items(r.t.id).find((i) => i.kind === 'permission').status, 'expired', 'its card can’t be answered');
  assert.equal(r.se().remoteTurn.state, 'done');
  assert.equal(r.rt.remote.sessionsOn(r.host.id).length, 0);
  assert.deepEqual(r.hosts.calls.need, r.hosts.calls.release, 'every need released');
  open();
  await sleep(20);
  assert.equal(reads(d, 'host-turn-1').length, 0, 'never attached');
  assert.equal(r.rt.turns.size, 0);
});

test('#120: archiving a conversation gives up its turn still waiting to be attached after a restart', async () => {
  const { r, d, open } = waitingAttach();
  await until(() => r.link.connected, 'the link');
  r.rt.archive(r.se().id);
  await until(() => d.stops.includes('host-turn-1'), 'the stop on the host');
  open();
  await sleep(20);
  assert.equal(reads(d, 'host-turn-1').length, 0, 'never attached');
  assert.equal(r.rt.turns.size, 0);
  assert.equal(r.se().remoteTurn.state, 'done');
});

test('#120 G10: removing a host drops an Interrupted turn’s resume: nothing starts when the host is back', async () => {
  const { store, d } = restarted({ welcome: 'missing' });
  const r = rig({ store, d });
  r.hosts.state = 'reconnecting'; // so it doesn’t resume before the removal
  startUp(r);
  await until(() => r.se().remoteTurn.state === 'interrupted', 'Interrupted');
  assert.ok(r.se().remoteTurn.resume);
  await r.rt.removeHost(r.host.id, { waitMs: 50 });
  assert.equal(r.se().remoteTurn.resume, null);
  r.hosts.state = null;
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await sleep(20);
  assert.equal(starts(d).length, 0, 'no resume');
});

// ── 7. Offsets ───────────────────────────────────────────────────────────────────────

test('#120 L5: the last applied offset goes into the session as acks advance, and at the turn’s end', async () => {
  const r = rig();
  const turn = await running(r);
  await until(() => r.se().remoteTurn.offset > 0, 'an acked offset');
  const size = r.d.turns.get(turn).out.at(-1).next;
  r.d.append(turn, JSON.stringify({ type: 'system', subtype: 'status', status: 'ok' }));
  r.d.end(turn);
  await settled(r);
  assert.equal(r.se().remoteTurn.offset, r.d.turns.get(turn).out.at(-1).next);
  assert.ok(r.se().remoteTurn.offset > size);
});
