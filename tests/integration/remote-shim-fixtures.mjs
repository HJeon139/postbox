// Fixtures for the host shim’s integration tests (tests/integration/remote-shim.test.mjs, #120): a temporary
// temp HOME (0700 folders, a 0600 socket and token), a fake daemon on a real Unix socket in it, and the shim
// as a child process, `node shim.mjs <turn>`, with JSON-RPC lines on its stdin and stdout.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROGRAMS, paths } from '../../server/remote/host/paths.mjs';
import { createMessageReader, DIR_MODE, encode, FILE_MODE, message } from '../../shared/remote-protocol.mjs';

const TOKEN = 'shim-test-token-0123456789abcdefghijklmn';
export const TURN = 'turn-shim-1';
const MINUTE = 60_000;

/** A temporary home with the daemon’s folders and the token, as L2’s install leaves them. */
function makeHome() {
  // macOS limits a socket path to 104 bytes, and its per-user temp folder is long, so prefer /tmp.
  const home = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'pb-shim-'));
  const P = paths({ home });
  mkdirSync(P.code, { recursive: true, mode: DIR_MODE });
  chmodSync(P.root, DIR_MODE);
  writeFileSync(P.token, `${TOKEN}\n`, { mode: FILE_MODE });
  return { home, P };
}
/**
 * A daemon that speaks the shim’s side of shared/remote-protocol.mjs: it validates what the shim sends, welcomes a
 * good hello, and lets the test answer. stop() ends it as a restarting daemon does; start() brings it back.
 * @param {string} socket
 */
function fakeDaemon(socket, { permissionWaitMax = MINUTE } = {}) {
  const st = daemonState();
  /** @type {import('node:net').Server | null} */
  let server = null;
  const d = {
    received: st.received,
    errors: st.errors,
    get closes() {
      return st.closes;
    },
    start() {
      if (existsSync(socket)) unlinkSync(socket);
      server = createServer((c) => acceptShim(st, c, permissionWaitMax));
      return new Promise((resolve) =>
        server?.listen(socket, () => {
          chmodSync(socket, FILE_MODE);
          resolve(undefined);
        }),
      );
    },
    /** Ends every connection and stops listening. */
    async stop() {
      for (const c of st.conns) c.destroy();
      await new Promise((resolve) => (server ? server.close(() => resolve(undefined)) : resolve(undefined)));
      server = null;
    },
    /** @param {string} type @param {Record<string, unknown>} body */
    send(type, body) {
      assert.ok(st.current, 'no shim is connected');
      st.current.write(encode(message('daemon-to-shim', type, body)));
    },
    /** The nth (from 0) message of a type the shim has sent, once it has. @param {string} type @param {number} [nth] */
    next(type, nth = 0) {
      return until(() => st.received.filter((m) => m.type === type)[nth], st.waiters, `the daemon to receive ${type} #${nth + 1}`);
    },
    connected: () => until(() => st.current, st.waiters, 'the shim to connect'),
  };
  return d;
}

/** What the fake daemon has seen: the shim’s messages, its connections, and the waiters to wake on each. */
function daemonState() {
  const waiters = new Set();
  return {
    /** @type {{ type: string, [k: string]: any }[]} */
    received: [],
    errors: [],
    /** @type {Set<import('node:net').Socket>} */
    conns: new Set(),
    /** @type {import('node:net').Socket | null} */
    current: null,
    closes: 0,
    waiters,
    notify: () => {
      for (const w of [...waiters]) w();
    },
  };
}

/** One shim’s connection to the fake daemon. @param {ReturnType<typeof daemonState>} st @param {import('node:net').Socket} c @param {number} permissionWaitMax */
function acceptShim(st, c, permissionWaitMax) {
  st.conns.add(c);
  const reader = createMessageReader('shim-to-daemon', {
    onMessage(m) {
      st.received.push(m);
      if (m.type === 'hello') {
        assert.equal(m.token, TOKEN);
        st.current = c;
        c.write(encode(message('daemon-to-shim', 'welcome', { turn: m.turn, permissionWaitMax })));
      }
      st.notify();
    },
    onError: (e) => st.errors.push(e),
  });
  c.on('data', (b) => reader.push(b));
  c.on('error', () => {});
  c.on('close', () => {
    st.conns.delete(c);
    st.closes++;
    if (st.current === c) st.current = null;
    st.notify();
  });
}

/**
 * Resolves with check()’s first truthy value, checked again on each notify, within two seconds.
 * @template T @param {() => T} check @param {Set<() => void>} waiters @param {string} what @returns {Promise<NonNullable<T>>}
 */
function until(check, waiters, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      waiters.delete(w);
      reject(new Error(`Timed out waiting for ${what}.`));
    }, 2000);
    const w = () => {
      const v = check();
      if (!v) return;
      clearTimeout(t);
      waiters.delete(w);
      resolve(/** @type {NonNullable<T>} */ (v));
    };
    waiters.add(w);
    w();
  });
}

/** The shim, as the harness runs it: `node shim.mjs <turn>`, its stdio ours. @param {string} home @param {object} [timings] */
function startShim(home, timings, extra = []) {
  const env = { ...process.env, HOME: home };
  if (timings) env.POSTBOX_SHIM_TIMINGS = JSON.stringify(timings);
  const w = spawn(process.execPath, [PROGRAMS.shim, TURN, ...extra], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  w.stdin.on('error', () => {}); // a write after the shim exited
  /** @type {any[]} */
  const out = [];
  let stderr = '';
  let buf = '';
  const waiters = new Set();
  const notify = () => {
    for (const fn of [...waiters]) fn();
  };
  w.stdout.on('data', (b) => {
    buf += b;
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      out.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
    notify();
  });
  w.stderr.on('data', (b) => {
    stderr += b;
  });
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => w.on('exit', (code) => resolve(code)));
  let rpc = 0;
  const shim = {
    out,
    get stderr() {
      return stderr;
    },
    exited,
    /** @param {object} msg */
    write: (msg) => w.stdin?.write(`${JSON.stringify(msg)}\n`),
    /** Sends a request and returns its ID. @param {string} method @param {object} [params] */
    request(method, params) {
      const id = ++rpc;
      shim.write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      return id;
    },
    /** @param {number} id */
    response: (id) => until(() => out.find((m) => m.id === id && !m.method), waiters, `the response to request ${id}`),
    /** @param {string} method @param {object} [params] */
    call: (method, params) => shim.response(shim.request(method, params)),
    /** @param {string} name @param {object} args @param {object} [meta] */
    tool: (name, args, meta) => shim.request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) }),
    /** @param {(m: any) => boolean} pred @param {string} what */
    waitFor: (pred, what) => until(() => out.find(pred), waiters, what),
    end: () => w.stdin?.end(),
    /** Kills it, if it’s still running, and waits for it to go. */
    kill: async () => {
      if (w.exitCode === null && w.signalCode === null) w.kill('SIGKILL');
      await exited;
    },
  };
  return shim;
}

/** A shim with a running fake daemon, cleaned up when the test ends. */
export async function setup(t, { timings, daemon: daemonOpts, startDaemon = true, args = [] } = /** @type {any} */ ({})) {
  const { home, P } = makeHome();
  const daemon = fakeDaemon(P.socket, daemonOpts);
  if (startDaemon) await daemon.start();
  const shim = startShim(home, timings, args);
  t.after(async () => {
    await shim.kill();
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, P, daemon, shim };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const textOf = (res) => res.result.content[0].text;
export const REQUEST = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' };
