// The fake host the #759 relay tests share (tests/remote-relay*.test.mjs): two daemons of different versions on one
// host home, in-process, sharing the host’s token, turn folders and runners. The older one has its own socket, as on a
// host, and the newer one relays that version’s running turns to it. The tests open no connection (tests/guard.mjs),
// so the relay reaches A’s socket server through a pair of streams.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { createLineReader, encode, hostPaths, MESSAGE_FILE, message, PROTOCOL_VERSION, TURN_FILES } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';
import { inProcessDaemon, socketShim } from './remote-broker-daemon-setup.mjs';
import { TOKEN, until, VERSION } from './remote-broker-fixtures.mjs';
import { hostHome } from './socket-base.mjs';

/** The version the turn started under, before VERSION was installed. */
export const OLD = '0.9.0';
export const ALLOW = { behavior: 'allow', updatedInput: {} };

/** Postbox on a pair of streams to `daemon`: what it got, a send, and its hang-up, once the daemon has closed its end. @param {any} daemon */
export function postbox(daemon) {
  const input = new PassThrough();
  const output = new PassThrough();
  daemon.connect({ input, output });
  const msgs = readMessages(output);
  const send = (/** @type {string} */ type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
  const hangUp = async () => {
    input.end();
    await msgs.ended;
  };
  return { msgs, send, hangUp };
}

/**
 * relay.mjs’s connectSocket, in-process: the relay’s end of a pair whose other end `serve` takes, as A’s socket server
 * would. Each pair goes in `sockets`, for a test that drops them.
 * @param {string} socket  A’s @param {(side: any) => void} serve @param {Set<any>} sockets
 */
export function inProcess(socket, serve, sockets) {
  return (/** @type {string} */ path, /** @type {{ onLine: (l: string) => void, onClose: () => void }} */ on) => {
    assert.equal(path, socket, 'A’s own socket');
    const toA = new PassThrough();
    const fromA = new PassThrough();
    const side = Duplex.from({ readable: toA, writable: fromA });
    sockets.add(side);
    // Destroying a pair says AbortError, as a dropped socket says its error.
    side.on('error', () => {});
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      on.onClose();
    };
    const reader = createLineReader({ onLine: on.onLine, onError: close });
    fromA.on('data', (bytes) => reader.push(bytes));
    fromA.on('end', close);
    side.on('close', close);
    serve(side);
    return { write: (/** @type {string} */ line) => toA.write(line), end: () => toA.end() };
  };
}

/**
 * One host: daemon A (OLD) on its real socket, and a turn `ta` it started for a Postbox that has since gone, with its
 * shim attached. Daemon B (VERSION) is made and started, with nobody attached yet. `serveA` replaces A’s socket server.
 * `beforeB` runs before B starts, with A’s Postbox gone, for records B finds at its start. relayCheckMs and
 * relayWelcomeMs: B’s. `placeSocket` puts something at A’s socket path in place of a listening socket, and may return its cleanup.
 * @param {import('node:test').TestContext} t
 * @param {{ serveA?: (socket: any) => void, beforeB?: (h: { first: any, shim: any, home: string }) => Promise<void>, relayCheckMs?: number,
 *   relayWelcomeMs?: number, placeSocket?: (path: string, home: string) => (() => void) | void }} [o]
 */
export async function host(t, o = {}) {
  const home = hostHome('pbrl-');
  const pA = hostPaths(home, OLD);
  mkdirSync(pA.root, { recursive: true, mode: 0o700 });
  writeFileSync(pA.token, TOKEN, { mode: 0o600 });
  const work = join(home, 'work');
  mkdirSync(work);
  const alive = new Set();
  const logs = /** @type {string[]} */ ([]);
  const log = (/** @type {string} */ l) => logs.push(l);
  const sockets = new Set();
  const a = inProcessDaemon(home, { version: OLD, alive, log }).daemon;
  const serve = o.serveA ?? ((/** @type {any} */ x) => a.accept(x));
  const connectRelay = inProcess(pA.socket, serve, sockets);
  const b = inProcessDaemon(home, { version: VERSION, alive, log, connectRelay, relayCheckMs: o.relayCheckMs, relayWelcomeMs: o.relayWelcomeMs }).daemon;
  await a.start();
  const first = postbox(a);
  first.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, instance: 'laptop-before'.padEnd(32, '0') });
  await first.msgs.next('welcome');
  first.send('start', { turn: 'ta', harness: 'claude-code', folder: work, argv: [], env: {}, stdin: 'file', files: [{ name: MESSAGE_FILE, text: '{}\n' }] });
  await first.msgs.next('started');
  const shim = socketShim(a);
  shim.shimSend('hello', { token: readFileSync(pA.turn('ta', TURN_FILES.shimToken), 'utf8'), turn: 'ta', shim: 'k'.repeat(32) });
  await until(() => shim.got.find((m) => m.type === 'welcome'), 'the shim’s welcome');
  // A’s socket is there, as relay.mjs checks before it connects.
  mkdirSync(dirname(pA.socket), { recursive: true });
  const server = createServer((s) => s.destroy());
  /** @type {(() => void) | void} */
  let placed;
  // Before anything here can fail, so a failing step leaves no daemon or server open.
  t.after(async () => {
    for (const s of sockets) s.destroy();
    placed?.();
    if (server.listening) await new Promise((resolve) => server.close(() => resolve(undefined)));
    a.close();
    b.close();
    await rm(home, { recursive: true, force: true });
  });
  placed = o.placeSocket?.(pA.socket, home);
  if (!o.placeSocket) await new Promise((resolve) => server.listen(pA.socket, () => resolve(undefined)));
  await o.beforeB?.({ first, shim, home });
  await b.start();
  return { home, work, alive, logs, a, b, first, shim, sockets };
}

/** B’s driver, said hello and welcomed. @param {any} b @param {string} [instance] */
export async function drive(b, instance = 'laptop-after'.padEnd(32, '0')) {
  const pb = postbox(b);
  pb.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, instance });
  await pb.msgs.next('welcome');
  return pb;
}

/** A welcome as a daemon sends it, for the fake older daemon. @param {string} home */
export function welcomeOf(home) {
  return { version: PROTOCOL_VERSION, home, node: { path: '/usr/bin/node', version: 'v22.12.0' }, harnesses: [], problems: [], turns: [] };
}
