// #585: the conformance probe’s codex app-server client. It refuses every request the app-server makes of it (the
// probe approves nothing), and waits for a notice on events, failing at once when the app-server exits first. The
// child is a stand-in EventEmitter here; tests/process/conformance-app-server.test.mjs runs a real process.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { onLine, waitFor } from '../tools/conformance/app-server.mjs';

/** A stand-in for a running child: exit is emitted by the test. */
const child = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
const io = () => {
  /** @type {any[]} */
  const written = [];
  /** @type {any[]} */
  const notified = [];
  return {
    pending: new Map(),
    notices: [],
    write: (/** @type {any} */ m) => written.push(m),
    notify: (/** @type {any} */ m) => notified.push(m),
    written,
    notified,
  };
};

test('a request from the app-server is refused, never approved, and kept as no notice', () => {
  const at = io();
  onLine(JSON.stringify({ id: 7, method: 'item/commandExecution/requestApproval', params: {} }), at);
  assert.deepEqual(at.written, [{ id: 7, error: { code: -32601, message: 'The conformance probe approves nothing.' } }]);
  assert.deepEqual(at.notices, []);
});

test('a notice is kept and announced, and a log line that isn’t JSON is neither', () => {
  const at = io();
  onLine('2026-11-28 INFO starting', at);
  onLine(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }), at);
  assert.equal(at.notices.length, 1);
  assert.deepEqual(at.notified, at.notices);
  assert.deepEqual(at.written, []);
});

test('waitFor resolves on the notice when it arrives, and leaves no listener or timer behind', async () => {
  const c = child();
  const arrived = new EventEmitter();
  const waiting = waitFor(c, arrived, [], 'turn/completed', 60_000);
  arrived.emit('notice', { method: 'turn/started' });
  arrived.emit('notice', { method: 'turn/completed', params: { n: 1 } });
  assert.deepEqual(await waiting, { method: 'turn/completed', params: { n: 1 } });
  assert.equal(arrived.listenerCount('notice'), 0);
  assert.equal(c.listenerCount('close'), 0);
});

test('waitFor fails at once when the app-server closes first, not after its wait', async () => {
  const c = child();
  const arrived = new EventEmitter();
  const started = Date.now();
  const waiting = waitFor(c, arrived, [], 'turn/completed', 60_000);
  c.emit('close', 1);
  await assert.rejects(waiting, /exited before turn\/completed/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(arrived.listenerCount('notice'), 0);
});

test('waitFor returns a notice already kept, refuses a child already gone, and gives up after its wait', async () => {
  const kept = { method: 'turn/completed' };
  assert.equal(await waitFor(child(), new EventEmitter(), [kept], 'turn/completed', 10), kept);
  await assert.rejects(waitFor(Object.assign(child(), { exitCode: 0 }), new EventEmitter(), [], 'turn/completed', 60_000), /exited before/);
  await assert.rejects(waitFor(child(), new EventEmitter(), [], 'turn/completed', 20), /No turn\/completed from codex app-server/);
});

test('a notice read after the app-server’s exit, but before its output closes, still counts', async () => {
  const c = child();
  const arrived = new EventEmitter();
  const waiting = waitFor(c, arrived, [], 'turn/completed', 60_000);
  c.exitCode = 0;
  c.emit('exit', 0);
  arrived.emit('notice', { method: 'turn/completed' });
  c.emit('close', 0);
  assert.deepEqual(await waiting, { method: 'turn/completed' });
});

test('an app-server that has exited with output still unread is waited on, not refused', async () => {
  const c = Object.assign(child(), { exitCode: 0, stdout: { readableEnded: false } });
  const arrived = new EventEmitter();
  const waiting = waitFor(c, arrived, [], 'turn/completed', 60_000);
  arrived.emit('notice', { method: 'turn/completed' });
  assert.deepEqual(await waiting, { method: 'turn/completed' });
});
