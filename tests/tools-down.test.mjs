// Postbox’s tools didn’t load last turn (#1161, #1162, #489): whatever the backend, the agent is told at its next turn
// that can carry it, once, among its Postbox notices. The runtime adds the note (server/adapters/tools-down.mjs,
// toolsDownNote), so no adapter takes it itself. Each backend’s detection is tested in its own file.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

const told = /^\[Postbox\] In your last turn, Postbox’s tool server didn’t start/;
/** The note among a turn’s notices, or ''. @param {any} message */
const noteIn = (message) => (message.context ?? []).find((/** @type {string} */ x) => told.test(x)) ?? '';

/** A runtime with one agent whose turns record what they were sent, and end at once. */
function room() {
  const store = new Store(null);
  /** @type {any[]} */
  const sent = [];
  const fail = { next: false, downAgain: /** @type {string | null} */ (null) };
  const adapter = {
    name: 'mock',
    async folderFor() {
      return null;
    },
    async deliver(/** @type {any} */ _se, /** @type {any} */ message, /** @type {any} */ ctx) {
      sent.push(message);
      // A CLI that couldn’t start: the turn never reached the agent.
      if (fail.next) {
        fail.next = false;
        // As a backend whose tools failed to load again before it failed: a newer note than the one this turn took.
        if (fail.downAgain) ctx.saveState({ postboxToolsDown: fail.downAgain });
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
