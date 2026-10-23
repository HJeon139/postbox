// The host’s stdio MCP shim (server/remote/host/shim.mjs, #120), driven as the harness drives it: `node shim.mjs <turn>`
// as a child process, JSON-RPC lines on its stdin and stdout, with a fake daemon on a real Unix socket in a temporary
// POSTBOX_REMOTE_HOME (0700 folders, a 0600 socket and token), so nothing touches the real ~/.postbox-remote.
// POSTBOX_SHIM_TIMINGS shortens the shim’s waits (its header says how), so no test waits a minute.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleMcp } from '../../server/mcp.mjs';
import { PROGRAMS, paths } from '../../server/remote/host/paths.mjs';
import { TOOL_DEFS } from '../../shared/mcp-tools.mjs';
import { createMessageReader, DIR_MODE, encode, FILE_MODE, message } from '../../shared/remote-protocol.mjs';

const TOKEN = 'shim-test-token-0123456789abcdefghijklmn';
const TURN = 'turn-shim-1';
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
  /** @type {{ type: string, [k: string]: any }[]} */
  const received = [];
  const errors = [];
  /** @type {Set<import('node:net').Socket>} */
  const conns = new Set();
  /** @type {import('node:net').Socket | null} */
  let current = null;
  /** @type {import('node:net').Server | null} */
  let server = null;
  const waiters = new Set();
  let closes = 0;
  const notify = () => {
    for (const w of [...waiters]) w();
  };
  const d = {
    received,
    errors,
    get closes() {
      return closes;
    },
    start() {
      if (existsSync(socket)) unlinkSync(socket);
      server = createServer((c) => {
        conns.add(c);
        const reader = createMessageReader('shim-to-daemon', {
          onMessage(m) {
            received.push(m);
            if (m.type === 'hello') {
              assert.equal(m.token, TOKEN);
              current = c;
              c.write(encode(message('daemon-to-shim', 'welcome', { turn: m.turn, permissionWaitMax })));
            }
            notify();
          },
          onError: (e) => errors.push(e),
        });
        c.on('data', (b) => reader.push(b));
        c.on('error', () => {});
        c.on('close', () => {
          conns.delete(c);
          closes++;
          if (current === c) current = null;
          notify();
        });
      });
      return new Promise((resolve) =>
        server?.listen(socket, () => {
          chmodSync(socket, FILE_MODE);
          resolve(undefined);
        }),
      );
    },
    /** Ends every connection and stops listening. */
    async stop() {
      for (const c of conns) c.destroy();
      await new Promise((resolve) => (server ? server.close(() => resolve(undefined)) : resolve(undefined)));
      server = null;
    },
    /** @param {string} type @param {Record<string, unknown>} body */
    send(type, body) {
      assert.ok(current, 'no shim is connected');
      current.write(encode(message('daemon-to-shim', type, body)));
    },
    /** The nth (from 0) message of a type the shim has sent, once it has. @param {string} type @param {number} [nth] */
    next(type, nth = 0) {
      return until(() => received.filter((m) => m.type === type)[nth], waiters, `the daemon to receive ${type} #${nth + 1}`);
    },
    connected: () => until(() => current, waiters, 'the shim to connect'),
  };
  return d;
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
  const env = { ...process.env, POSTBOX_REMOTE_HOME: home };
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
async function setup(t, { timings, daemon: daemonOpts, startDaemon = true, args = [] } = /** @type {any} */ ({})) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (res) => res.result.content[0].text;
const REQUEST = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' };

test('initialize and tools/list match the laptop’s server/mcp.mjs, byte for byte', async (t) => {
  const { shim } = await setup(t);
  const init = await shim.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const laptopInit = await handleMcp(/** @type {any} */ (null), null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(JSON.stringify(init.result), JSON.stringify(/** @type {any} */ (laptopInit).result));
  shim.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await shim.call('tools/list');
  // A laptop with no turn running: a list for no turn of a side or topic thread.
  const laptopList = await handleMcp(/** @type {any} */ ({ turns: new Map() }), null, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(JSON.stringify(list.result), JSON.stringify(/** @type {any} */ (laptopList).result));
  // Outside a side or topic thread, as on the laptop, every tool but bring_to_conversation.
  assert.deepEqual(
    list.result.tools.map((x) => x.name),
    TOOL_DEFS.map((x) => x.name).filter((n) => n !== 'bring_to_conversation'),
  );
  assert.deepEqual((await shim.call('ping')).result, {});
});

test('with --bring, a turn the person started in a side or topic thread, tools/list has every tool, as the laptop’s does there', async (t) => {
  const { shim } = await setup(t, { args: ['--bring'] });
  await shim.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const list = await shim.call('tools/list');
  assert.equal(JSON.stringify(list.result), JSON.stringify({ tools: TOOL_DEFS }));
});

test('server/discover and any other unknown method get method not found (-32601)', async (t) => {
  const { shim } = await setup(t);
  const discover = await shim.call('server/discover');
  assert.equal(discover.error.code, -32601);
  assert.equal((await shim.call('resources/list')).error.code, -32601);
  // A notification it doesn’t know gets no answer, and the next request still does.
  shim.write({ jsonrpc: '2.0', method: 'notifications/whatever' });
  assert.ok((await shim.call('ping')).result);
  assert.equal((await shim.call('tools/call', { name: 'no_such_tool', arguments: {} })).error.code, -32602);
});

test('a queued tool returns at once, and the daemon receives its call', async (t) => {
  const { shim, daemon } = await setup(t);
  await daemon.connected();
  const id = shim.tool('show_block', { block: { id: 'pick', type: 'choice', version: 1, fallback: 'Pick one' } });
  const res = await shim.response(id);
  assert.match(textOf(res), /Sent block pick to Postbox/);
  assert.equal(res.result.isError, undefined);
  const call = await daemon.next('call');
  assert.equal(call.name, 'show_block');
  assert.equal(call.args.block.id, 'pick');
});

test('a queued tool returns at once with no daemon, and is sent with the same ID when the daemon comes up', async (t) => {
  const { shim, daemon } = await setup(t, { startDaemon: false, timings: { backoff: 20, backoffMax: 50 } });
  const res = await shim.response(shim.tool('define_term', { term: 'shim', definition: 'The host’s MCP server.' }));
  assert.match(textOf(res), /Sent “shim” to the glossary/);
  await daemon.start();
  const call = await daemon.next('call');
  assert.equal(call.name, 'define_term');
  // It stays queued until the daemon answers it, so a reconnect sends it again with the same ID.
  await daemon.stop();
  await daemon.start();
  const again = await daemon.next('call', 1);
  assert.equal(again.id, call.id);
  daemon.send('result', { id: call.id, ok: true, text: 'Queued.' });
  await daemon.stop();
  await daemon.start();
  await daemon.next('hello', 2);
  await sleep(50);
  assert.equal(daemon.received.filter((m) => m.type === 'call').length, 2, 'an answered call isn’t sent again');
});

test('an asked tool waits for the daemon’s result, and an error result is isError', async (t) => {
  const { shim, daemon } = await setup(t);
  const id = shim.tool('corpus_search', { query: 'remote hosts' });
  const call = await daemon.next('call');
  assert.equal(call.name, 'corpus_search');
  await sleep(50);
  assert.equal(
    shim.out.find((m) => m.id === id),
    undefined,
    'it doesn’t answer before the daemon does',
  );
  daemon.send('result', { id: call.id, ok: true, text: '[{"id":"a"}]' });
  const res = await shim.response(id);
  assert.equal(textOf(res), '[{"id":"a"}]');
  assert.equal(res.result.isError, undefined);

  const id2 = shim.tool('read_conversation', { limit: 5 });
  const call2 = await daemon.next('call', 1);
  assert.notEqual(call2.id, call.id);
  daemon.send('result', { id: call2.id, ok: false, text: 'There’s no snapshot for this turn.' });
  const res2 = await shim.response(id2);
  assert.equal(res2.result.isError, true);
  assert.equal(textOf(res2), 'There’s no snapshot for this turn.');
});

test('an asked tool fails with a clear error when the daemon stays unreachable', async (t) => {
  const { shim } = await setup(t, { startDaemon: false, timings: { unreachable: 100, backoff: 20, backoffMax: 50 } });
  const res = await shim.response(shim.tool('corpus_search', { query: 'x' }));
  assert.equal(res.result.isError, true);
  assert.match(textOf(res), /daemon on this host isn’t reachable, so corpus_search couldn’t run/);
});

test('permission_prompt waits for the person, and returns the laptop’s allow and deny shapes', async (t) => {
  const { shim, daemon } = await setup(t);
  const allowId = shim.tool('permission_prompt', REQUEST);
  const asked = await daemon.next('permission');
  assert.deepEqual(asked.request, REQUEST);
  await sleep(50);
  assert.equal(
    shim.out.find((m) => m.id === allowId),
    undefined,
    'it blocks until the answer',
  );
  daemon.send('permission-answer', { id: asked.id, result: { behavior: 'allow', updatedInput: { command: 'ls -la' } } });
  const allowed = await shim.response(allowId);
  assert.equal(textOf(allowed), JSON.stringify({ behavior: 'allow', updatedInput: { command: 'ls -la' } }));

  const denyId = shim.tool('permission_prompt', REQUEST);
  const asked2 = await daemon.next('permission', 1);
  daemon.send('permission-answer', { id: asked2.id, result: { behavior: 'deny', message: 'Not now.' } });
  assert.equal(textOf(await shim.response(denyId)), JSON.stringify({ behavior: 'deny', message: 'Not now.' }));
});

test('a waiting prompt sends progress with a value that increases each time, and stops once answered', async (t) => {
  const { shim, daemon } = await setup(t, { timings: { progress: 25 } });
  const id = shim.tool('permission_prompt', REQUEST, { progressToken: 'tok-1' });
  const asked = await daemon.next('permission');
  const progress = () => shim.out.filter((m) => m.method === 'notifications/progress');
  await shim.waitFor(() => progress().length >= 4, 'four progress notifications');
  const values = progress().map((m) => m.params.progress);
  for (const m of progress()) assert.equal(m.params.progressToken, 'tok-1');
  for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1], `progress went ${values[i - 1]} then ${values[i]}`);
  daemon.send('permission-answer', { id: asked.id, result: { behavior: 'deny', message: 'No.' } });
  await shim.response(id);
  const after = progress().length;
  await sleep(100);
  assert.equal(progress().length, after, 'no progress after the answer');
});

test('a prompt nobody answers is denied at permissionWaitMax, and the daemon gets permission-expired', async (t) => {
  const { shim, daemon } = await setup(t, { timings: { waitMax: 150 } });
  const id = shim.tool('permission_prompt', REQUEST);
  const asked = await daemon.next('permission');
  const res = await shim.response(id);
  const decision = JSON.parse(textOf(res));
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.message, /Nobody answered this permission request/);
  const expired = await daemon.next('permission-expired');
  assert.equal(expired.id, asked.id);
  // An answer after the expiry changes nothing.
  daemon.send('permission-answer', { id: asked.id, result: { behavior: 'allow', updatedInput: {} } });
  await sleep(50);
  assert.equal(shim.out.filter((m) => m.id === id).length, 1);
});

test('after a daemon restart, the waiting prompt is sent again with the same ID, and its answer arrives', async (t) => {
  const { shim, daemon } = await setup(t, { timings: { backoff: 20, backoffMax: 50 } });
  const id = shim.tool('permission_prompt', REQUEST);
  const asked = await daemon.next('permission');
  await daemon.stop();
  await sleep(60);
  await daemon.start();
  const hello = await daemon.next('hello', 1);
  assert.equal(hello.turn, TURN);
  const again = await daemon.next('permission', 1);
  assert.equal(again.id, asked.id);
  assert.deepEqual(again.request, REQUEST);
  daemon.send('permission-answer', { id: again.id, result: { behavior: 'allow', updatedInput: REQUEST.input } });
  assert.equal(JSON.parse(textOf(await shim.response(id))).behavior, 'allow');
  assert.equal(daemon.errors.length, 0);
});

test('stdin ending closes the daemon link and exits 0', async (t) => {
  const { shim, daemon } = await setup(t);
  await daemon.connected();
  shim.tool('permission_prompt', REQUEST);
  await daemon.next('permission');
  const closes = daemon.closes;
  shim.end();
  assert.equal(await shim.exited, 0);
  await sleep(50);
  assert.ok(daemon.closes > closes, 'the shim closed its connection');
});
