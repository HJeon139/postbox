// Running’s interface (designs/architecture/services.md, “Running”): the live turn per session, the stopped turns still
// exiting (#126), the sessions whose host turn waits to be attached again after a restart (#1135), and whether Postbox
// is closing. Its invariants: at most one live turn per session; a busy session (running, exiting or awaiting attach)
// starts no new turn; once closing, nothing starts. Turns are small plain objects; it never builds Runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Running } from '../server/running.mjs';

/** A live turn as Running holds it: only its session and id matter here. @param {string} sessionId @param {string} [id] */
const turn = (sessionId, id = `turn-${sessionId}`) => ({ id, sessionId });

/** A Running with a turn running for `se_1`. */
function withTurn() {
  const running = new Running();
  const t = turn('se_1');
  running.begin(t);
  return { running, t };
}

/** Stops `se_1`’s turn as Stop does: exiting first, then it leaves the live turns. */
function stopped() {
  const { running, t } = withTurn();
  const entry = { turn: t, held: [], silent: false };
  running.exit('se_1', entry);
  running.end('se_1');
  return { running, t, entry };
}

// ── Reading ──────────────────────────────────────────────────────────────────────────

test('a new Running has no turns, nothing busy and isn’t closing', () => {
  const running = new Running();
  assert.equal(running.turnOf('se_1'), undefined);
  assert.equal(running.busy('se_1'), false);
  assert.deepEqual(running.all(), []);
  assert.equal(running.closing, false);
});

test('a turn that begins is the session’s live turn, mid-turn and busy, and listed in all()', () => {
  const { running, t } = withTurn();
  assert.equal(running.turnOf('se_1'), t);
  assert.equal(running.midTurn('se_1'), true);
  assert.equal(running.busy('se_1'), true);
  assert.deepEqual(running.all(), [t]);
  assert.equal(running.busy('se_2'), false, 'another session stays free');
});

test('all() lists every session’s live turn, and a copy, so ending one while iterating skips none', () => {
  const running = new Running();
  const a = turn('se_1');
  const b = turn('se_2');
  running.begin(a);
  running.begin(b);
  const seen = [];
  for (const t of running.all()) {
    running.end(t.sessionId);
    seen.push(t);
  }
  assert.deepEqual(seen, [a, b]);
  assert.deepEqual(running.all(), []);
});

test('a stopped turn still exiting isn’t live, but keeps its session mid-turn and busy until it exits', () => {
  const { running, entry } = stopped();
  assert.equal(running.turnOf('se_1'), undefined, 'no longer the live turn');
  assert.equal(running.exitOf('se_1'), entry);
  assert.equal(running.midTurn('se_1'), true);
  assert.equal(running.busy('se_1'), true);
  running.exited('se_1');
  assert.equal(running.exitOf('se_1'), undefined);
  assert.equal(running.midTurn('se_1'), false);
  assert.equal(running.busy('se_1'), false);
});

test('a turn that ends frees its session', () => {
  const { running } = withTurn();
  running.end('se_1');
  assert.equal(running.turnOf('se_1'), undefined);
  assert.equal(running.busy('se_1'), false);
});

// ── Awaiting attach (#1135) ──────────────────────────────────────────────────────────

test('a session awaiting attach is busy, but not mid-turn', () => {
  const running = new Running();
  running.awaitAttach('se_1', 'h1');
  assert.equal(running.awaitsAttach('se_1'), true);
  assert.equal(running.busy('se_1'), true);
  assert.equal(running.midTurn('se_1'), false, 'Placement may still move the agent off a silent host');
});

test('a session attached again is no longer awaiting, nor busy', () => {
  const running = new Running();
  running.awaitAttach('se_1', 'h1');
  running.attached('se_1');
  assert.equal(running.awaitsAttach('se_1'), false);
  assert.equal(running.busy('se_1'), false);
});

// ── Invariants ───────────────────────────────────────────────────────────────────────

test('a second turn for a session with a live turn doesn’t begin, and the first stays', () => {
  const { running, t } = withTurn();
  assert.throws(() => running.begin(turn('se_1', 'turn-2')), /already has a turn running/);
  assert.equal(running.turnOf('se_1'), t);
});

test('no turn begins for a session whose stopped turn is still exiting', () => {
  const { running } = stopped();
  assert.throws(() => running.begin(turn('se_1', 'turn-2')), /stopped turn is still exiting/);
  assert.equal(running.turnOf('se_1'), undefined);
});

test('no turn begins for a session awaiting attach, except the attach itself', () => {
  const running = new Running();
  running.awaitAttach('se_1', 'h1');
  assert.throws(() => running.begin(turn('se_1')), /waits to be attached/);
  assert.equal(running.turnOf('se_1'), undefined);
  const attach = turn('se_1', 'turn-attach');
  running.begin(attach, { attach: true });
  assert.equal(running.turnOf('se_1'), attach);
});

test('once closing, no turn begins, and closing stays set', () => {
  const running = new Running();
  running.close();
  assert.equal(running.closing, true);
  assert.throws(() => running.begin(turn('se_1')), /closing/);
  assert.equal(running.turnOf('se_1'), undefined);
  running.close();
  assert.equal(running.closing, true);
});

test('only the session’s live turn can exit', () => {
  const { running } = withTurn();
  assert.throws(() => running.exit('se_1', { turn: turn('se_1', 'other'), held: [], silent: false }), /isn’t its live turn/);
  assert.throws(() => running.exit('se_2', { turn: turn('se_2'), held: [], silent: false }), /isn’t its live turn/);
  assert.equal(running.exitOf('se_1'), undefined);
  assert.equal(running.exitOf('se_2'), undefined);
});

test('a turn that begins after its session’s exiting turn exited is the live one', () => {
  const { running } = stopped();
  running.exited('se_1');
  const next = turn('se_1', 'turn-2');
  running.begin(next);
  assert.equal(running.turnOf('se_1'), next);
});
