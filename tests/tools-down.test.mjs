// Postbox’s tools didn’t load last turn (#1161, #1162, #489): whatever the backend, the agent is told at its next turn
// that can carry it, once, among its Postbox notices. The runtime adds the note (server/adapters/tools-down.mjs,
// toolsDownNote), so no adapter takes it itself. Each backend’s detection is tested in its own file.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { saveBackendState, takenBack } from '../server/store-outage.mjs';
import * as arrange from './arrange.mjs';

const told = /^\[Postbox\] In your last turn, Postbox’s tool server didn’t start/;
/** The note among a turn’s notices, or ''. @param {any} message */
const noteIn = (message) => (message.context ?? []).find((/** @type {string} */ x) => told.test(x)) ?? '';

/** A runtime with one agent whose turns record what they were sent, and end at once. */
function room() {
  const store = new Store(null);
  /** @type {any[]} */
  const sent = [];
  const fail = { next: false, downAgain: /** @type {string | null} */ (null), afterWords: false, silent: false, hang: false, refused: false };
  const adapter = {
    name: 'mock',
    async folderFor() {
      return null;
    },
    async deliver(/** @type {any} */ _se, /** @type {any} */ message, /** @type {any} */ ctx) {
      sent.push(message);
      // A turn whose backend has emitted nothing yet, stopped there.
      if (fail.hang) {
        fail.hang = false;
        // Stopped after it reached the agent: it wrote words first.
        if (fail.afterWords) ctx.text('Working on it.');
        await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
      }
      // A CLI that ran to its end and wrote nothing: an empty reply.
      if (fail.silent) {
        fail.silent = false;
        return;
      }
      // A backend that refused to open the turn, after a step saying so: Codex when Postbox’s tools didn’t start
      // (codexRefusal), whose error says it never reached the agent.
      if (fail.refused) {
        fail.refused = false;
        ctx.activity({ id: 'postbox-tools-down', label: 'Postbox’s tools didn’t load', state: 'failed', ms: 0 });
        throw Object.assign(new Error('Postbox’s tools didn’t load.'), { notReached: true });
      }
      // A CLI that couldn’t start: the turn never reached the agent.
      if (fail.next) {
        fail.next = false;
        // As a backend whose tools failed to load again before it failed: a newer note than the one this turn took.
        if (fail.downAgain) ctx.saveState({ postboxToolsDown: fail.downAgain });
        // A turn that reached the agent and then failed: it wrote words first.
        if (fail.afterWords) ctx.text('Working on it.');
        throw Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' });
      }
      ctx.text('Done.');
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'developer' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = arrange.agentIn(rt, t.id);
  const turn = async (/** @type {string} */ text) => {
    rt.sendMessage(t.id, { text });
    for (let i = 0; i < 200 && (arrange.liveTurns(rt) || arrange.exitingTurns(rt)); i++) await new Promise((r) => setTimeout(r, 5));
  };
  const down = (/** @type {string|null} */ how) =>
    arrange.setSession(rt, se.id, { backendState: { ...store.state.sessions[se.id].backendState, postboxToolsDown: how } });
  return { rt, store, se, sent, turn, down, t, fail };
}

test('the next turn is told among its notices that Postbox’s tools didn’t load, and only once', async () => {
  const r = room();
  r.down('ran');
  await r.turn('Try again.');
  assert.match(noteIn(r.sent[0]), /you had none of Postbox’s tools/, 'worded for a turn that ran without them');
  assert.equal(r.store.state.sessions[r.se.id].backendState.postboxToolsDown, null, 'and the note is taken');
  await r.turn('Once more.');
  assert.equal(noteIn(r.sent[1]), '', 'only once');
});

test('a turn that never ran is told so, and where its message is', async () => {
  const r = room();
  r.down('refused');
  await r.turn('Try again.');
  assert.match(noteIn(r.sent[0]), /the turn didn’t run and you never got its message: read_conversation has it/);
});

test('a slash command doesn’t carry the note, which waits for the next turn', async () => {
  const r = room();
  r.down('ran');
  r.rt.runAgentCommand(r.t.id, { sessionId: r.se.id, text: '/compact' });
  for (let i = 0; i < 200 && arrange.liveTurns(r.rt); i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(noteIn(r.sent[0]), '', 'a command is the whole prompt');
  assert.equal(r.store.state.sessions[r.se.id].backendState.postboxToolsDown, 'ran', 'the note is still owed');
  await r.turn('Try again.');
  assert.match(noteIn(r.sent[1]), told);
});

// #1171: the note was taken as the turn’s message was built, so a turn that then failed to start lost it, and the agent
// was told at most once, not exactly once.
test('#1171 a turn that fails before it runs keeps the note for the next', async () => {
  const r = room();
  r.down('ran');
  r.fail.next = true;
  await r.turn('Try again.');
  assert.equal(r.store.state.sessions[r.se.id].backendState.postboxToolsDown, 'ran', 'still owed after the failed turn');
  await r.turn('Once more.');
  assert.match(noteIn(r.sent[1]), told, 'and the next turn is told');
  assert.equal(r.store.state.sessions[r.se.id].backendState.postboxToolsDown, null, 'then taken');
});

test('#1171 a failed turn that set a newer note keeps that one, not the one it took', async () => {
  const r = room();
  r.down('ran');
  r.fail.next = true;
  r.fail.downAgain = 'refused';
  await r.turn('Try again.');
  assert.equal(r.store.state.sessions[r.se.id].backendState.postboxToolsDown, 'refused');
});

test('#1171 a turn that reached the agent and then failed doesn’t give the note back, so it isn’t told twice', async () => {
  const r = room();
  r.down('ran');
  r.fail.next = true;
  r.fail.afterWords = true;
  await r.turn('Try again.');
  assert.equal(r.store.state.sessions[r.se.id].backendState.postboxToolsDown, null, 'the agent read it in the turn that ran');
});

test('#1171 a turn that ran to its end with no reply doesn’t give the note back: its agent had it', async () => {
  const r = room();
  r.down('ran');
  r.fail.silent = true;
  await r.turn('Try again.');
  assert.equal(r.store.state.sessions[r.se.id].backendState.postboxToolsDown, null);
});

test('#1171 a turn stopped before its backend emitted anything keeps the note for the next', async () => {
  const r = room();
  r.down('ran');
  r.fail.hang = true;
  r.rt.sendMessage(r.t.id, { text: 'Try again.' });
  for (let i = 0; i < 200 && r.sent.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
  r.rt.stop(r.se.id, { by: 'you' });
  for (let i = 0; i < 200 && (arrange.liveTurns(r.rt) || arrange.exitingTurns(r.rt)); i++) await new Promise((x) => setTimeout(x, 5));
  assert.equal(r.store.state.sessions[r.se.id].backendState.postboxToolsDown, 'ran');
});

test('#1171 a turn stopped after it reached the agent doesn’t give the note back', async () => {
  const r = room();
  r.down('ran');
  r.fail.hang = true;
  r.fail.afterWords = true;
  r.rt.sendMessage(r.t.id, { text: 'Try again.' });
  for (let i = 0; i < 200 && r.sent.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
  r.rt.stop(r.se.id, { by: 'you' });
  for (let i = 0; i < 200 && (arrange.liveTurns(r.rt) || arrange.exitingTurns(r.rt)); i++) await new Promise((x) => setTimeout(x, 5));
  assert.equal(r.store.state.sessions[r.se.id].backendState.postboxToolsDown, null);
});

test('#1171 a turn the store’s outage stopped before its backend emitted anything keeps the note for the next', async () => {
  const r = room();
  r.down('ran');
  r.fail.hang = true;
  r.rt.sendMessage(r.t.id, { text: 'Try again.' });
  for (let i = 0; i < 200 && r.sent.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
  r.store.writable = false;
  r.store.tellStatus();
  assert.equal(r.rt.backendWait.get(r.se.id)?.postboxToolsDown, 'ran', 'given back, waiting for writes to reopen');
});

test('#1171 a newer note still waiting for writes to reopen stands against the one a turn gives back', () => {
  const r = room();
  r.store.writable = false;
  saveBackendState(r.rt, r.se.id, { postboxToolsDown: 'refused' });
  takenBack(r.rt, r.se.id, { toolsDownTaken: 'ran' });
  assert.equal(r.rt.backendWait.get(r.se.id)?.postboxToolsDown, 'refused');
});

test('#1171 a turn the store’s outage stopped after it reached the agent doesn’t give the note back', async () => {
  const r = room();
  r.down('ran');
  r.fail.hang = true;
  r.fail.afterWords = true;
  r.rt.sendMessage(r.t.id, { text: 'Try again.' });
  for (let i = 0; i < 200 && r.sent.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
  r.store.writable = false;
  r.store.tellStatus();
  assert.equal(r.rt.backendWait.get(r.se.id)?.postboxToolsDown, undefined, 'the agent read it in the turn that ran');
});

// #1904: what a turn takes from the session besides the tools-down note goes back the same way: Postbox’s waiting
// notices (se.context) and the lint folded into it (foldLint).
const NOTICE = '[Postbox] Your message to @critic was delivered.';
/** A notice waiting for the agent’s next turn. @param {any} r */
const notice = (r) => arrange.setSession(r.rt, r.se.id, { context: [NOTICE] });
/** A lint turn settled and waiting, which the next turn folds in. @param {any} r */
const lintWaits = (r) => {
  const e = {
    sessionId: r.se.id,
    kind: null,
    ended: true,
    sent: false,
    problems: [{ code: 'x', message: 'A problem.', scope: { kind: 'reply' } }],
    timer: null,
    threadId: r.t.id,
    holds: 0,
  };
  r.rt.checks.lints.set('tu_earlier', e);
  return e;
};
const carries = (/** @type {any} */ m) => (m.context ?? []).includes(NOTICE);

test('#1904 a turn that fails before it runs gives back its waiting notice and folded lint, so the next turn has them', async () => {
  const r = room();
  notice(r);
  lintWaits(r);
  r.fail.next = true;
  await r.turn('Try again.');
  assert.ok(carries(r.sent[0]) && r.sent[0].lint, 'the failed turn took both');
  await r.turn('Once more.');
  assert.ok(carries(r.sent[1]), 'the notice comes with the next turn');
  assert.match(String(r.sent[1].lint ?? ''), /A problem\./, 'and so does the lint');
});

test('#1904 a turn that reached the agent and then failed doesn’t give them back, so they aren’t told twice', async () => {
  const r = room();
  notice(r);
  lintWaits(r);
  r.fail.next = true;
  r.fail.afterWords = true;
  await r.turn('Try again.');
  await r.turn('Once more.');
  assert.ok(!carries(r.sent[1]));
  assert.equal(r.sent[1].lint, undefined);
});

test('#1904 a turn stopped before its backend emitted anything gives back its waiting notice and folded lint', async () => {
  const r = room();
  notice(r);
  lintWaits(r);
  r.fail.hang = true;
  r.rt.sendMessage(r.t.id, { text: 'Try again.' });
  for (let i = 0; i < 200 && r.sent.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
  r.rt.stop(r.se.id, { by: 'you' });
  for (let i = 0; i < 200 && (arrange.liveTurns(r.rt) || arrange.exitingTurns(r.rt)); i++) await new Promise((x) => setTimeout(x, 5));
  await r.turn('Once more.');
  assert.ok(carries(r.sent[1]));
  assert.match(String(r.sent[1].lint ?? ''), /A problem\./);
});

test('#1904 a turn the store’s outage stopped gives back its waiting notice once writes reopen', async () => {
  const r = room();
  notice(r);
  r.fail.hang = true;
  r.rt.sendMessage(r.t.id, { text: 'Try again.' });
  for (let i = 0; i < 200 && r.sent.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
  r.store.writable = false;
  r.store.tellStatus();
  assert.deepEqual(r.store.state.sessions[r.se.id].context ?? [], [], 'nothing written while the store is closed');
  r.store.writable = true;
  r.store.tellStatus();
  for (let i = 0; i < 200 && !(r.store.state.sessions[r.se.id].context ?? []).length; i++) await new Promise((x) => setTimeout(x, 5));
  assert.deepEqual(r.store.state.sessions[r.se.id].context, [NOTICE]);
});

test('#1904 a turn its backend refused after a step saying so gives back what it took: it never reached its agent', async () => {
  const r = room();
  notice(r);
  lintWaits(r);
  r.fail.refused = true;
  await r.turn('Try again.');
  await r.turn('Once more.');
  assert.ok(carries(r.sent[1]));
  assert.match(String(r.sent[1].lint ?? ''), /A problem\./);
});

test('#1904 the notices go back ahead of one that came since, in the order they were told', async () => {
  const r = room();
  notice(r);
  r.fail.hang = true;
  r.rt.sendMessage(r.t.id, { text: 'Try again.' });
  for (let i = 0; i < 200 && r.sent.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
  // Told while the turn that took the first one still runs, then that turn is stopped before any output.
  r.rt.sessions.tell(r.se.id, 'A later notice.');
  r.rt.stop(r.se.id, { by: 'you' });
  for (let i = 0; i < 200 && (arrange.liveTurns(r.rt) || arrange.exitingTurns(r.rt)); i++) await new Promise((x) => setTimeout(x, 5));
  assert.deepEqual(r.store.state.sessions[r.se.id].context, [NOTICE, '[Postbox] A later notice.']);
});
