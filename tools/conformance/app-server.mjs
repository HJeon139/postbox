// A small JSON-RPC client for `codex app-server` over stdio, for the conformance probe (#585). One process per
// client, as Postbox starts one per turn, so a resume or a fork here crosses a process as it does in a real room.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

const REQUEST_MS = 30_000;
const STOP_MS = 3000;

/**
 * Starts `codex app-server` with the given environment, and initializes it. `requestMs`: how long a request or a
 * notice may take.
 * @param {{ bin: string, cwd: string, env: Record<string, string>, requestMs?: number }} opts
 */
export async function openAppServer({ bin, cwd, env, requestMs = REQUEST_MS }) {
  const child = spawn(bin, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  /** @type {any[]} */
  const notices = [];
  const arrived = new EventEmitter(); // each notice as it’s kept, for waitFor
  let stderr = '';
  let next = 0;
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  const failAll = (/** @type {Error} */ e) => {
    for (const { fail } of pending.values()) fail(e);
    pending.clear();
  };
  child.on('error', failAll);
  // 'close', not 'exit': it comes once stdout is drained, so an answer written just before the exit still settles.
  child.on('close', (code) => failAll(new Error(`codex app-server exited (${code}): ${stderr.trim().slice(-400)}`)));
  child.stdin.on('error', failAll); // a write after the app-server died: its exit says why
  const write = (/** @type {any} */ msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  createInterface({ input: child.stdout }).on('line', (line) => onLine(line, { pending, notices, write, notify: (m) => arrived.emit('notice', m) }));
  /** @param {string} method @param {any} [params] @returns {Promise<any>} */
  const request = (method, params) => {
    const id = ++next;
    const answered = settled(pending, id, method, requestMs);
    write({ id, method, params });
    return answered;
  };
  const server = {
    child,
    notices,
    request,
    notified: (/** @type {string} */ method) => waitFor(child, arrived, notices, method, requestMs),
    stop: () => stop(child),
  };
  try {
    await request('initialize', { clientInfo: { name: 'postbox-conformance', version: '0' } });
  } catch (e) {
    await stop(child); // no caller holds the server yet to stop it, and a live child keeps the tool from exiting
    throw e;
  }
  write({ method: 'initialized', params: {} });
  return server;
}

/**
 * A promise of request `id`’s answer, settled from `pending` by onLine, or failed after `ms`.
 * @param {Map<number, any>} pending @param {number} id @param {string} method @param {number} ms @returns {Promise<any>}
 */
function settled(pending, id, method, ms) {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`${method} got no answer in ${ms / 1000} s`)), ms);
    timer.unref();
    const done = () => clearTimeout(timer);
    pending.set(id, {
      ok: (/** @type {any} */ result) => {
        done();
        ok(result);
      },
      fail: (/** @type {any} */ error) => {
        done();
        fail(error);
      },
    });
  });
}

/**
 * One line from the app-server: an answer settles its request, a request from the server is refused (the probe
 * approves nothing), and a notice is kept and announced.
 * @param {string} line
 * @param {{ pending: Map<number, any>, notices: any[], write: (msg: any) => void, notify?: (msg: any) => void }} io
 */
export function onLine(line, { pending, notices, write, notify = () => {} }) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not a JSON-RPC message: the app-server’s own log line
  }
  if (msg.method && msg.id != null) write({ id: msg.id, error: { code: -32601, message: 'The conformance probe approves nothing.' } });
  else if (msg.method) {
    notices.push(msg);
    notify(msg);
  } else if (pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) fail(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    else ok(msg.result);
  }
}

/**
 * Whether the app-server has exited and its output has all been read, so no notice can still arrive.
 * @param {import('node:child_process').ChildProcess} child
 */
const gone = (child) => (child.exitCode !== null || child.signalCode !== null) && (child.stdout?.readableEnded ?? true);

/**
 * The first notice of `method`: one already kept, or the next to arrive, within `ms`. It fails at once if the
 * app-server has gone, or once it closes first: after its exit and the last of its output, so a notice written just
 * before it exits still counts. Whichever settles it removes both listeners and the timer.
 * @param {import('node:child_process').ChildProcess} child @param {EventEmitter} arrived @param {any[]} notices
 * @param {string} method @param {number} ms @returns {Promise<any>}
 */
export function waitFor(child, arrived, notices, method, ms) {
  const kept = notices.find((n) => n.method === method);
  if (kept) return Promise.resolve(kept);
  if (gone(child)) return Promise.reject(new Error(`codex app-server exited before ${method}`));
  return new Promise((ok, fail) => {
    const done = () => {
      clearTimeout(timer);
      arrived.off('notice', onNotice);
      child.off('close', onExit);
    };
    const onNotice = (/** @type {any} */ m) => {
      if (m.method !== method) return;
      done();
      ok(m);
    };
    const onExit = () => {
      done();
      fail(new Error(`codex app-server exited before ${method}`));
    };
    const timer = setTimeout(() => {
      done();
      fail(new Error(`No ${method} from codex app-server in ${ms / 1000} s`));
    }, ms);
    arrived.on('notice', onNotice);
    child.once('close', onExit);
  });
}

/** Stops the app-server by its PID: SIGINT, then SIGKILL if it hasn’t exited. @param {import('node:child_process').ChildProcess} child */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((ok) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      ok(undefined);
    });
    child.kill('SIGINT');
  });
}
