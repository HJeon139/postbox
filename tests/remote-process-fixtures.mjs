// What the remote process’s tests share (tests/remote-process*.test.mjs): the recorded stream, a minimal stand-in for
// L1’s connection to the fake daemon, a watcher for a child’s output and events, and waiting until something holds.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { createMessageReader, encode, message, PROTOCOL_VERSION } from '../shared/remote-protocol.mjs';
import { FAKE_TOKEN, fixtureLines } from './fake-daemon.mjs';

export const LINES = fixtureLines();
export const FOLDER = '/home/user/postbox-work/ada';
export const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(fn(), `Timed out waiting for ${label}`);
};

/** L1’s connection, as far as the remote process needs it, over the fake daemon’s streams. */
export function connectTo(d) {
  const conn = new EventEmitter();
  conn.setMaxListeners(0);
  let ready = false;
  let stdin;
  const wire = ({ stdin: i, stdout }) => {
    stdin = i;
    ready = false;
    const reader = createMessageReader('daemon-to-postbox', {
      onMessage(m) {
        // What a dropped channel had on its way never arrives.
        if (stdin !== i) return;
        if (m.type === 'welcome') {
          ready = true;
          conn.emit('connected');
        } else conn.emit('message', m);
      },
      onError: (e) => assert.fail(`The fake daemon sent a bad line: ${e.message}`),
    });
    // A turn later, as from a real channel: the fake answers within the write that reached it.
    stdout.on('data', (b) => setImmediate(() => reader.push(b)));
    stdout.on('end', () =>
      setImmediate(() => {
        if (stdin === i) ready = false;
      }),
    );
    i.write(encode(message('postbox-to-daemon', 'hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN })));
  };
  wire({ stdin: d.stdin, stdout: d.stdout });
  return Object.assign(conn, {
    send(msg) {
      if (!ready) return false;
      stdin.write(encode(msg));
      return true;
    },
    /** The SSH session drops: nothing more arrives on it, and sends fail until reconnect(). */
    drop() {
      stdin = null;
      ready = false;
      d.drop();
    },
    reconnect() {
      wire(d.connect());
    },
  });
}

/** Everything a child writes to stdout, as lines through readline, as the adapters read it; and how it ended. */
export function watch(child) {
  const out = [];
  let err = '';
  const cuts = [];
  createInterface({ input: child.stdout }).on('line', (l) => out.push(l));
  child.stderr.on('data', (d) => {
    err += d;
  });
  child.on('cut', (c) => cuts.push(c));
  const exit = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const close = new Promise((r) => child.once('close', (code, signal) => r({ code, signal, lines: out.length })));
  return {
    out,
    cuts,
    exit,
    close,
    get err() {
      return err;
    },
  };
}

export const sent = (d, type) => d.received.filter((m) => m.type === type);
