// Fixtures for the broker’s unit tests (tests/remote-broker*.test.mjs, #120): a temp home with turn folders as the
// daemon writes them, a broker over it with Postbox as a list, a shim as a pair of functions that speak
// shared/remote-protocol.mjs’s shim-to-daemon and daemon-to-shim lines, and a fake clock.

import assert from 'node:assert/strict';
import { promises as fsp, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker } from '../server/remote/host/broker.mjs';
import { encode, hostPaths, message, parseLine, TURN_FILES, validateMessage } from '../shared/remote-protocol.mjs';

export const TOKEN = 'b'.repeat(64);
export const VERSION = '0.10.0';
export const BOOT = '0f1e2d3c-4b5a-4968-8776-655443322110';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** check()’s first truthy value, looked at every 5 ms, within ms. */
export async function until(check, what, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** A fake clock whose timers run only when tick() passes them. */
export function fakeClock(t0 = 1_760_000_000_000) {
  let t = t0;
  /** @type {{ at: number, fn: () => any }[]} */
  const queue = [];
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) {
        const h = { at: t + ms, fn };
        queue.push(h);
        return h;
      },
      clearTimeout(h) {
        const i = queue.indexOf(h);
        if (i !== -1) queue.splice(i, 1);
      },
    },
    async tick(ms) {
      t += ms;
      for (;;) {
        const due = queue.filter((h) => h.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        queue.splice(queue.indexOf(due), 1);
        await due.fn();
      }
    },
  };
}

/** A test turn’s own token, which its shims prove (broker-shim.mjs). @param {string} turn */
export const turnToken = (turn) => `${TOKEN}-${turn}`;

/** A temp home with turn folders written as the daemon writes them. */
export function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'pbb-'));
  const p = hostPaths(home, VERSION);
  mkdirSync(p.turns, { recursive: true, mode: 0o700 });
  const work = join(home, 'work');
  mkdirSync(work);
  /** @param {string} turn @param {object} [start] */
  const turn = (turn, start = {}) => {
    const dir = p.turn(turn);
    mkdirSync(dir, { mode: 0o700 });
    const rec = { turn, harness: 'claude-code', program: '/usr/bin/claude', argv: [], env: {}, stdin: 'none', folder: work, ...start };
    writeFileSync(join(dir, TURN_FILES.start), JSON.stringify(rec), { mode: 0o600 });
    // The turn’s own token, as the daemon writes it before start.json (daemon-start.mjs).
    writeFileSync(join(dir, TURN_FILES.shimToken), turnToken(turn), { mode: 0o600 });
    return dir;
  };
  /** Brokers made over this home (makeBroker), and the appends they have in flight. */
  const brokers = [];
  const appending = new Set();
  /** @param {Promise<any>} write */
  const track = (write) => {
    appending.add(write);
    write.then(
      () => appending.delete(write),
      () => appending.delete(write),
    );
    return write;
  };
  /**
   * Closes this home’s brokers, waits for what they still have in flight, then removes the home. A broker writes some
   * records without waiting on them (an expiry sent, a reply after an offline answer), so a spec can end while one
   * lands in a turn folder: removing the folder under it fails with ENOTEMPTY. Both waits, under one deadline: the
   * close covers a claim that holds no append yet (a reply reading its snapshot), and `appending` covers the appends
   * no broker waits for (writeStdin) and any that start during the wait. A held write, as the settle specs make,
   * waits at most HELD_MS.
   */
  const done = async () => {
    const end = Date.now() + HELD_MS;
    await Promise.race([Promise.allSettled(brokers.map((b) => b.close())), sleep(HELD_MS)]);
    while (appending.size && Date.now() < end) await Promise.race([Promise.allSettled([...appending]), sleep(end - Date.now())]);
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  };
  return { home, p, work, turn, done, brokers, track, appending: () => [...appending] };
}

/** How long a home’s removal waits for an append a spec holds and never lets go (makeHome’s done). */
const HELD_MS = 1000;

/**
 * A broker over a home, with Postbox as a list. `attached` says whether Postbox is there.
 * @param {ReturnType<typeof makeHome>} h @param {object} [over]  createBroker options
 */
export function makeBroker(h, over = {}) {
  /** @type {any[]} */
  const sent = [];
  const logs = [];
  const writes = [];
  const state = { attached: true };
  // The broker’s appends go through the home, so its removal can wait for them (makeHome’s done).
  const io = over.io ?? { appendFile: fsp.appendFile, readFile: fsp.readFile, stat: fsp.stat };
  const b = createBroker({
    paths: h.p,
    toPostbox: (type, body) => {
      if (!state.attached) return false;
      // What the daemon would send, checked as Postbox checks it.
      const r = validateMessage('daemon-to-postbox', { type, ...body });
      assert.ok(r.ok, r.ok ? '' : r.error);
      sent.push({ type, ...body });
      return true;
    },
    attached: () => state.attached,
    log: (l) => logs.push(l),
    // As the runner does: the line goes into in.jsonl, then the pipe; it resolves with in.jsonl’s size.
    writeStdin: async (turn, line) => {
      writes.push({ turn, line });
      await h.track(appendFile(h.p.turn(turn, TURN_FILES.in), `${line}\n`));
      return statSync(h.p.turn(turn, TURN_FILES.in)).size;
    },
    ...over,
    io: { ...io, appendFile: (...a) => h.track(io.appendFile(...a)) },
  });
  h.brokers.push(b);
  /** Postbox says hello: what the broker sends after the welcome. */
  const hello = async () => {
    const got = [];
    await b.hello((type, body) => {
      const r = validateMessage('daemon-to-postbox', { type, ...body });
      assert.ok(r.ok, r.ok ? '' : r.error);
      got.push({ type, ...body });
    });
    return got;
  };
  /** A Postbox message, with its errors collected. */
  const post = async (type, body) => {
    const r = validateMessage('postbox-to-daemon', { type, ...body });
    assert.ok(r.ok, r.ok ? '' : r.error);
    const errors = [];
    const took = await b.message(r.msg, { send: () => {}, fail: (code, text) => errors.push({ code, text }) });
    return { took, errors };
  };
  return { b, sent, logs, writes, state, hello, post };
}

/**
 * A shim connected to the broker: its lines, checked as the shim checks them.
 * @param {ReturnType<typeof createBroker>} b @param {string} turn
 */
export function connectShim(b, turn, token = turnToken(turn)) {
  /** @type {any[]} */
  const got = [];
  const taken = new Set();
  let ended = false;
  const h = b.shim({
    first: JSON.stringify({ type: 'hello', token, turn }),
    write: (s) => {
      for (const l of s.split('\n').filter(Boolean)) {
        const r = parseLine('daemon-to-shim', l);
        assert.ok(r.ok, r.ok ? '' : r.error);
        got.push(r.msg);
      }
      return true;
    },
    end: () => {
      ended = true;
    },
  });
  const shim = {
    got,
    get ended() {
      return ended;
    },
    /** @param {string} type @param {object} body */
    send: (type, body) => h.line(encode(message('shim-to-daemon', type, body)).trimEnd()),
    close: h.close,
    /** The next message of a type (and matching pred) not taken yet. @param {string} type @param {(m: any) => boolean} [pred] */
    next: (type, pred = () => true) =>
      until(() => {
        const i = got.findIndex((m, j) => !taken.has(j) && m.type === type && pred(m));
        if (i === -1) return null;
        taken.add(i);
        return got[i];
      }, `the shim to get ${type}`),
    /** A call, and its result. */
    call: async (id, name, args) => {
      shim.send('call', { id, name, args });
      return shim.next('result', (m) => m.id === id);
    },
  };
  return shim;
}

export const lines = (path) => {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
export const BLOCK = { id: 'pick', type: 'choice', version: 1, fallback: 'Pick one', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] };
export const REQUEST = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu_1' };

/** Makes a turn file unappendable, as a folder. @param {string} path */
export const blockFile = (path) => {
  rmSync(path, { force: true });
  mkdirSync(path);
};
