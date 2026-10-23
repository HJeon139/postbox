// The daemon’s broker (server/remote/host/broker.mjs, #120), driven in-process: a shim is a pair of functions that
// speak shared/remote-protocol.mjs’s shim-to-daemon and daemon-to-shim lines, Postbox is a list of what the broker sent
// it, and the turn folders are in a temp home. Nothing is spawned; the real daemon, runner and shim are in
// tests/integration/remote-broker.test.mjs.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  CODEX_DECLINE,
  codexDeclineLine,
  codexPromptId,
  createBroker,
  inlineAppFiles,
  readConversation,
  readMessage,
  STOPPED_TEXT,
} from '../server/remote/host/broker.mjs';
import { createDaemon } from '../server/remote/host/daemon.mjs';
import { Runtime } from '../server/runtime.mjs';
import { READING } from '../shared/limits.mjs';
import {
  encode,
  HOST_DEFAULTS,
  hostPaths,
  MESSAGE_FILE,
  message,
  PROTOCOL_VERSION,
  parseLine,
  TURN_FILES,
  validateMessage,
} from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';

const TOKEN = 'b'.repeat(64);
const VERSION = '0.10.0';
const BOOT = '0f1e2d3c-4b5a-4968-8776-655443322110';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** check()’s first truthy value, looked at every 5 ms, within ms. */
async function until(check, what, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** A fake clock whose timers run only when tick() passes them. */
function fakeClock(t0 = 1_760_000_000_000) {
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

/** A temp home with turn folders written as the daemon writes them. */
function makeHome() {
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
    return dir;
  };
  return { home, p, work, turn, done: () => rmSync(home, { recursive: true, force: true }) };
}

/**
 * A broker over a home, with Postbox as a list. `attached` says whether Postbox is there.
 * @param {ReturnType<typeof makeHome>} h @param {object} [over]  createBroker options
 */
function makeBroker(h, over = {}) {
  /** @type {any[]} */
  const sent = [];
  const logs = [];
  const writes = [];
  const state = { attached: true };
  const b = createBroker({
    paths: h.p,
    tokenMatches: (t) => t === TOKEN,
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
      await appendFile(h.p.turn(turn, TURN_FILES.in), `${line}\n`);
      return statSync(h.p.turn(turn, TURN_FILES.in)).size;
    },
    ...over,
  });
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
function connectShim(b, turn, token = TOKEN) {
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

const lines = (path) => {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const BLOCK = { id: 'pick', type: 'choice', version: 1, fallback: 'Pick one', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] };
const REQUEST = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu_1' };

// ── Shim connections ──

test('a shim’s hello: the token, then the turn; unknown, ended and stopping turns are refused', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    h.turn('t2');
    writeFileSync(h.p.turn('t2', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
    const k = makeBroker(h, { settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: 120_000 }) });
    const ok = connectShim(k.b, 't1');
    assert.deepEqual(await ok.next('welcome'), { type: 'welcome', turn: 't1', permissionWaitMax: 120_000 });
    const bad = connectShim(k.b, 't1', 'c'.repeat(64));
    assert.equal((await bad.next('error')).code, 'bad-token');
    assert.ok(bad.ended, 'a refused shim’s connection is closed');
    assert.equal((await connectShim(k.b, 'nope').next('error')).code, 'no-turn');
    const over = await connectShim(k.b, 't2').next('error');
    assert.deepEqual([over.code, over.message], ['turn-ended', STOPPED_TEXT]);
    await k.b.stopping('t1');
    assert.equal((await ok.next('error')).code, 'turn-ended', 'a connected shim hears its turn is stopping');
    assert.equal((await connectShim(k.b, 't1').next('error')).code, 'turn-ended');
    // A call after Stop is refused, as the laptop refuses one (#126), and nothing reaches Postbox.
    const r = await ok.call('c1', 'show_block', { block: BLOCK });
    assert.deepEqual([r.ok, r.text], [false, STOPPED_TEXT]);
    assert.deepEqual(k.sent, []);
    assert.deepEqual(
      lines(h.p.turn('t1', TURN_FILES.tools)).map((x) => x.op),
      ['stopping'],
      'stopping is recorded, and the call isn’t',
    );
    // It outlives a restart.
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    assert.equal((await connectShim(again.b, 't1').next('error')).code, 'turn-ended');
  } finally {
    h.done();
  }
});

// ── Queued calls ──

test('a queued call is recorded, answered at once, sent to Postbox, and dropped when Postbox replies', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const r = await s.call('c1', 'show_block', { block: BLOCK });
    assert.equal(r.ok, true);
    assert.deepEqual(
      lines(h.p.turn('t1', TURN_FILES.tools)).map((x) => [x.op, x.id, x.name]),
      [['call', 'c1', 'show_block']],
      'on disk before the shim heard',
    );
    assert.equal(statSync(h.p.turn('t1', TURN_FILES.tools)).mode & 0o777, 0o600);
    assert.deepEqual(k.sent, [{ type: 'tool', turn: 't1', id: 'c1', name: 'show_block', args: { block: BLOCK } }]);
    // Resent after a reconnect, with the same ID: answered again, never queued twice.
    const s2 = connectShim(k.b, 't1');
    await s2.next('welcome');
    assert.equal((await s2.call('c1', 'show_block', { block: BLOCK })).ok, true);
    assert.equal(k.sent.length, 1);
    // Another turn may use the same ID: (turn, id) is the identity.
    h.turn('t2');
    const o = connectShim(k.b, 't2');
    await o.next('welcome');
    await o.call('c1', 'define_term', { term: 'x', definition: 'y' });
    assert.equal(k.sent.length, 2);
    // Each hello sends what Postbox hasn’t replied to.
    assert.deepEqual(
      (await k.hello()).map((m) => [m.turn, m.id]),
      [
        ['t1', 'c1'],
        ['t2', 'c1'],
      ],
    );
    assert.deepEqual((await k.post('reply', { turn: 't1', id: 'c1', ok: false, text: 'Block pick is already shown.' })).errors, []);
    assert.match(k.logs.join('\n'), /refused turn t1’s show_block \(c1\): Block pick is already shown/);
    assert.deepEqual(
      (await k.hello()).map((m) => [m.turn, m.id]),
      [['t2', 'c1']],
    );
    assert.equal((await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: 'x' })).errors[0].code, 'no-tool', 'a reply goes once');
    assert.equal((await k.post('reply', { turn: 't1', id: 'zz', ok: true, text: 'x' })).errors[0].code, 'no-tool');
    assert.equal(s.got.filter((m) => m.type === 'result').length, 1, 'nothing more reached the shim');
  } finally {
    h.done();
  }
});

test('a queued call while Postbox is away waits, and crosses at its hello; it outlives a daemon restart', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    k.state.attached = false;
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    assert.equal((await s.call('c1', 'schedule_wake', { in_minutes: 5 })).ok, true, 'the shim is answered while Postbox is away');
    assert.equal((await s.call('c2', 'wake_agent', { handle: 'reviewer', message: 'hi' })).ok, true);
    assert.deepEqual(k.sent, []);
    k.state.attached = true;
    await k.post('reply', { turn: 't1', id: 'c2', ok: true, text: 'Woken.' }); // a reply before the hello is still a reply
    // A new daemon, from the records on disk.
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(
      (await again.hello()).map((m) => [m.type, m.id, m.name, m.args]),
      [['tool', 'c1', 'schedule_wake', { in_minutes: 5 }]],
    );
    // The shim, reconnecting, sends c1 again: recognized from the records, so it isn’t sent a second time.
    const s2 = connectShim(again.b, 't1');
    await s2.next('welcome');
    assert.equal((await s2.call('c1', 'schedule_wake', { in_minutes: 5 })).ok, true);
    assert.deepEqual(again.sent, []);
    // A torn last line, as a crash mid-append leaves, is skipped.
    await appendFile(h.p.turn('t1', TURN_FILES.tools), '{"op":"call","id":"c3"');
    const third = makeBroker(h);
    await third.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(
      (await third.hello()).map((m) => m.id),
      ['c1'],
    );
  } finally {
    h.done();
  }
});

test('update_block is checked with the catalog first; an invalid show_block still goes, since the laptop shows its fallback', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const bad = await s.call('c1', 'update_block', { block: { id: 'pick', type: 'choice', version: 1 } });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /^The update was invalid and wasn’t applied: /);
    assert.match(k.logs.join('\n'), /update_block \(c1\) was refused/);
    assert.equal((await s.call('c2', 'show_block', { block: { type: 'nope' } })).ok, true);
    assert.deepEqual(
      k.sent.map((m) => m.id),
      ['c2'],
    );
  } finally {
    h.done();
  }
});

// ── Asked calls ──

test('an asked call: refused at once with no Postbox, else Postbox’s reply is the result; add_dataset isn’t supported yet', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    k.state.attached = false;
    const away = await s.call('c1', 'corpus_search', { query: 'x' });
    assert.equal(away.ok, false);
    assert.match(away.text, /^Postbox isn’t connected to this host right now, so corpus_search can’t run/);
    assert.equal((await k.hello()).length, 0, 'a refused call isn’t queued');
    k.state.attached = true;
    s.send('call', { id: 'c2', name: 'corpus_search', args: { query: 'y' } });
    await until(() => k.sent.length, 'the tool');
    assert.deepEqual(k.sent[0], { type: 'tool', turn: 't1', id: 'c2', name: 'corpus_search', args: { query: 'y' } });
    await k.post('reply', { turn: 't1', id: 'c2', ok: true, text: '[{"id":"b:1"}]' });
    assert.deepEqual(await s.next('result', (m) => m.id === 'c2'), { type: 'result', id: 'c2', ok: true, text: '[{"id":"b:1"}]' });
    // A shim that missed it gets it when it asks again.
    const s2 = connectShim(k.b, 't1');
    await s2.next('welcome');
    assert.equal((await s2.call('c2', 'corpus_search', { query: 'y' })).text, '[{"id":"b:1"}]');
    assert.equal(k.sent.length, 1);
    const ds = await s.call('c3', 'add_dataset', { id: 'd', path: 'd.jsonl' });
    assert.equal(ds.ok, false);
    assert.match(ds.text, /^Loading a dataset isn’t supported yet for an agent on a remote host/);
    assert.equal(k.sent.length, 1);
  } finally {
    h.done();
  }
});

test('an asked call’s answer outlives a daemon restart: the shim resending it gets Postbox’s reply, not silence', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('call', { id: 'c1', name: 'corpus_search', args: { query: 'y' } });
    await until(() => k.sent.length, 'the tool');
    // The reply comes while the shim is away, then the daemon restarts before it reconnects.
    s.close();
    await k.post('reply', { turn: 't1', id: 'c1', ok: false, text: 'No book is called “x”.' });
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    const s2 = connectShim(again.b, 't1');
    await s2.next('welcome');
    assert.deepEqual(await s2.call('c1', 'corpus_search', { query: 'y' }), { type: 'result', id: 'c1', ok: false, text: 'No book is called “x”.' });
    assert.deepEqual([again.sent, await again.hello()], [[], []], 'an answered call isn’t sent to Postbox again');
  } finally {
    h.done();
  }
});

test('a call or prompt the broker can’t write down isn’t acknowledged: the shim hears why, and nothing crosses to Postbox', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    // tools.jsonl and prompts.jsonl can’t be appended to: each is a folder.
    mkdirSync(h.p.turn('t1', TURN_FILES.tools));
    mkdirSync(h.p.turn('t1', TURN_FILES.prompts));
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    const queued = await s.call('c1', 'show_block', { block: BLOCK });
    assert.equal(queued.ok, false, 'a queued call that isn’t on disk isn’t acknowledged');
    assert.match(queued.text, /^Postbox’s daemon on this host couldn’t write down show_block, so it wasn’t sent to Postbox: /);
    const asked = await s.call('c2', 'corpus_search', { query: 'y' });
    assert.equal(asked.ok, false);
    assert.match(asked.text, /^Postbox’s daemon on this host couldn’t write down corpus_search, so it wasn’t sent to Postbox: /);
    s.send('permission', { id: 'p1', request: REQUEST });
    const denied = await s.next('permission-answer');
    assert.equal(denied.result.behavior, 'deny', 'a prompt that isn’t on disk is denied, never left waiting or allowed');
    assert.match(denied.result.message, /^Postbox’s daemon on this host couldn’t write down this permission request, so it wasn’t shown: /);
    assert.deepEqual(k.sent, [], 'nothing reached Postbox');
    assert.deepEqual(await k.hello(), [], 'and nothing waits for its next hello');
    assert.deepEqual(k.b.pending.tools, []);
    assert.deepEqual(k.b.pending.prompts, []);
    const logged = k.logs.join('\n');
    assert.match(logged, /Couldn’t record call in .*tools\.jsonl/);
    assert.match(logged, /Couldn’t record prompt in .*prompts\.jsonl/);
    // Once the file can be written, the same call goes: the failure left nothing behind that stops it.
    rmSync(h.p.turn('t1', TURN_FILES.tools), { recursive: true });
    assert.equal((await s.call('c1', 'show_block', { block: BLOCK })).ok, true);
    assert.deepEqual(
      k.sent.map((m) => [m.type, m.id]),
      [['tool', 'c1']],
    );
  } finally {
    h.done();
  }
});

/** Makes a turn file unappendable, as a folder. @param {string} path */
const blockFile = (path) => {
  rmSync(path, { force: true });
  mkdirSync(path);
};

test('an answer the broker can’t write down doesn’t reach the shim: Postbox hears an error, the prompt waits, and a later answer goes', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const file = h.p.turn('t1', TURN_FILES.prompts);
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    await until(() => k.sent.length, 'the prompt');
    // prompts.jsonl can’t be appended to from here on: it’s a folder.
    blockFile(file);
    const allow = { behavior: 'allow', updatedInput: { command: 'ls' } };
    const failed = await k.post('answer', { turn: 't1', prompt: 'p1', result: allow });
    assert.equal(failed.errors.length, 1, 'Postbox hears the answer wasn’t taken');
    assert.equal(failed.errors[0].code, 'internal');
    assert.match(failed.errors[0].text, /^Postbox’s daemon on this host couldn’t write down the answer to prompt p1 in turn t1, so the agent didn’t get it: /);
    await sleep(20);
    assert.deepEqual(
      s.got.filter((m) => m.type === 'permission-answer'),
      [],
      'the shim hears nothing',
    );
    assert.deepEqual(
      k.b.pending.prompts.map((q) => [q.id, q.answer]),
      [['p1', null]],
      'the prompt still waits',
    );
    assert.deepEqual(
      (await k.hello()).map((m) => [m.type, m.id]),
      [['prompt', 'p1']],
      'and is sent again at the next hello',
    );
    // A shim that sends the prompt again hears nothing either: there’s no answer yet.
    s.send('permission', { id: 'p1', request: REQUEST });
    await sleep(20);
    assert.equal(s.got.filter((m) => m.type === 'permission-answer').length, 0);
    // Once the file can be written, the next answer goes.
    rmSync(file, { recursive: true });
    assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: allow })).errors, []);
    assert.deepEqual(await s.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: allow });
    assert.deepEqual(
      lines(file).map((x) => x.op),
      ['answer'],
    );
  } finally {
    h.done();
  }
});

test('an answer is on disk before the shim hears it, and an expiry before Postbox hears it', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const file = h.p.turn('t1', TURN_FILES.prompts);
    /** @type {any[]} what Postbox got, with what prompts.jsonl held as it did */
    const sent = [];
    const k = makeBroker(h, {
      toPostbox: (type, body) => {
        sent.push({ type, ...body, onDisk: lines(file).map((x) => x.op) });
        return true;
      },
    });
    /** @type {string[][]} what prompts.jsonl held as the shim heard each answer */
    const heard = [];
    const c = k.b.shim({
      first: JSON.stringify({ type: 'hello', token: TOKEN, turn: 't1' }),
      write: (line) => {
        if (line.includes('"permission-answer"')) heard.push(lines(file).map((x) => x.op));
        return true;
      },
      end: () => {},
    });
    const send = (type, body) => c.line(encode(message('shim-to-daemon', type, body)).trimEnd());
    send('permission', { id: 'p1', request: REQUEST });
    send('permission', { id: 'p2', request: REQUEST });
    await until(() => sent.length === 2, 'the prompts');
    await k.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'no' } });
    await until(() => heard.length, 'the answer');
    assert.deepEqual(heard, [['prompt', 'prompt', 'answer']], 'written down before the shim heard');
    send('permission-expired', { id: 'p2', at: 5 });
    await until(() => sent.length === 3, 'the expiry');
    assert.equal(sent[2].type, 'prompt-expired');
    assert.deepEqual(sent[2].onDisk, ['prompt', 'prompt', 'answer', 'expired'], 'written down before Postbox heard');
  } finally {
    h.done();
  }
});

test('a reply the broker can’t write down doesn’t reach the shim: Postbox hears an error, the call waits, and a later reply goes', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const file = h.p.turn('t1', TURN_FILES.tools);
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('call', { id: 'c1', name: 'corpus_search', args: { query: 'y' } });
    assert.equal((await s.call('c2', 'show_block', { block: BLOCK })).ok, true);
    await until(() => k.sent.length === 2, 'the tools');
    // tools.jsonl can’t be appended to from here on: it’s a folder.
    blockFile(file);
    for (const id of ['c1', 'c2']) {
      const failed = await k.post('reply', { turn: 't1', id, ok: true, text: `answer ${id}` });
      assert.equal(failed.errors.length, 1, `Postbox hears ${id}’s reply wasn’t taken`);
      assert.equal(failed.errors[0].code, 'internal');
      assert.match(
        failed.errors[0].text,
        new RegExp(`^Postbox’s daemon on this host couldn’t write down the reply to call ${id} in turn t1, so it wasn’t taken: `),
      );
    }
    await sleep(20);
    assert.deepEqual(
      s.got.filter((m) => m.type === 'result' && m.id === 'c1'),
      [],
      'the shim hears nothing',
    );
    assert.deepEqual(
      k.b.pending.tools.map((t) => t.id),
      ['c1', 'c2'],
      'both calls still wait',
    );
    assert.deepEqual(
      (await k.hello()).map((m) => [m.type, m.id, m.args]),
      [
        ['tool', 'c1', { query: 'y' }],
        ['tool', 'c2', { block: BLOCK }],
      ],
      'and are sent again, whole, at the next hello',
    );
    // Once the file can be written, the next replies go, written down before the shim hears.
    rmSync(file, { recursive: true });
    assert.deepEqual((await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: 'answer c1' })).errors, []);
    assert.deepEqual(await s.next('result', (m) => m.id === 'c1'), { type: 'result', id: 'c1', ok: true, text: 'answer c1' });
    assert.deepEqual((await k.post('reply', { turn: 't1', id: 'c2', ok: true, text: 'Shown.' })).errors, []);
    assert.deepEqual(
      lines(file).map((x) => [x.op, x.id]),
      [
        ['reply', 'c1'],
        ['reply', 'c2'],
      ],
    );
    assert.deepEqual(k.b.pending.tools, []);
    assert.equal((await k.post('reply', { turn: 't1', id: 'c1', ok: true, text: 'again' })).errors[0].code, 'no-tool', 'a reply goes once');
  } finally {
    h.done();
  }
});

// ── The snapshot and its reading tools ──

/** A snapshot thread of n items, with every 4th one empty (an item read_conversation leaves out). */
const itemsOf = (th, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${th}_${i}`,
    line: i % 4 === 3 ? '' : `line ${i} of ${th}`,
    text: i === 5 ? 'L'.repeat(READING.part * 2 + 17) : i % 4 === 3 ? '' : `full ${i} of ${th}`,
    ...(i === 2 ? { blockId: `blk_${th}` } : {}),
  }));

test('read_conversation and read_message from a snapshot match server/runtime.mjs’s, case for case', () => {
  const snap = {
    home: 'th_home',
    threads: [
      { id: 'th_home', items: itemsOf('th_home', 260) },
      { id: 'th_side', items: itemsOf('th_side', 3) },
      { id: 'th_empty', items: [] },
    ],
  };
  // runtime.mjs’s own methods, over a store that holds the same items, so the paging and the words are its.
  const store = {
    items: (th) =>
      snap.threads.find((t) => t.id === th)?.items.map((i) => ({ ...i, ...(i.blockId ? { kind: 'block', valid: true, block: { id: i.blockId } } : {}) })) ?? [],
    item: (th, id) => store.items(th).find((i) => i.id === id),
  };
  const rt = {
    store,
    conversationThreads: () => snap.threads.map((t) => t.id),
    readLine: (i, _se, n = READING.item) => (n === Number.POSITIVE_INFINITY ? i.text : i.line) || null,
  };
  const se = { threadId: 'th_home', id: 's1', handle: 'dev' };
  const laptopConversation = (args) => {
    try {
      return { ok: true, text: Runtime.prototype.readConversation.call(rt, se, args) };
    } catch (e) {
      return { ok: false, text: e.message };
    }
  };
  const laptopMessage = (args) => {
    const r = Runtime.prototype.readMessage.call(rt, se, args);
    return { ok: r.ok, text: r.message };
  };
  const conversations = [
    {},
    { limit: 10 },
    { limit: 0 },
    { limit: 500 },
    { limit: -3 },
    { limit: 'x' },
    { skip: 30 },
    { skip: 255, limit: 10 },
    { skip: 1000 },
    { skip: -5 },
    { thread: 'th_side' },
    { thread: '  th_side  ' },
    { thread: 'th_empty' },
    { thread: 'th_nope' },
    { thread: '' },
    { thread: 7 },
    { limit: null, skip: null },
  ];
  for (const args of conversations) assert.deepEqual(readConversation(snap, args), laptopConversation(args), JSON.stringify(args));
  const messages = [
    { id: 'th_home_0' },
    { id: ' th_side_1 ' },
    { id: 'th_home_3' },
    { id: 'th_home_5' },
    { id: 'th_home_5', from: READING.part },
    { id: 'th_home_5', from: READING.part * 2 },
    { id: 'th_home_5', from: READING.part * 3 },
    { id: 'th_home_5', from: -10 },
    { id: 'th_home_5', from: 'x' },
    { id: 'blk_th_side' },
    { id: 'nope' },
    { id: '' },
    {},
  ];
  for (const args of messages) assert.deepEqual(readMessage(snap, args), laptopMessage(args), JSON.stringify(args));
  // Two blocks with one ID: the laptop names their agents, which the snapshot doesn’t carry, so it names the items.
  const twice = {
    home: 'a',
    threads: [
      {
        id: 'a',
        items: [
          { id: 'i1', line: 'x', text: 'x', blockId: 'b' },
          { id: 'i2', line: 'y', text: 'y', blockId: 'b' },
        ],
      },
    ],
  };
  assert.deepEqual(readMessage(twice, { id: 'b' }), { ok: false, text: 'More than one block is called “b”: they’re the items i1, i2. Read one by that id.' });
});

test('the snapshot: kept until start, written 0600 into the folder, updated by snapshot-items, and read by the shim’s calls', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const snap = { turn: 't1', home: 'th', threads: [{ id: 'th', items: [{ id: 'i1', line: 'You: hi', text: 'You: hi' }] }] };
    assert.equal((await k.post('snapshot', snap)).took, true);
    assert.equal((await k.post('snapshot-items', { turn: 't1', thread: 'th', items: [{ id: 'i2', line: '@dev: yo', text: '@dev: yo' }] })).errors.length, 0);
    h.turn('t1');
    await k.b.starting('t1');
    const path = h.p.turn('t1', TURN_FILES.snapshot);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(path, 'utf8')).threads[0].items.map((i) => i.id),
      ['i1', 'i2'],
    );
    // An existing ID is replaced in place; a new thread is added.
    await k.post('snapshot-items', { turn: 't1', thread: 'th', items: [{ id: 'i1', line: 'You: hello', text: 'You: hello' }] });
    await k.post('snapshot-items', { turn: 't1', thread: 'th_side', items: [{ id: 's1', line: 'aside', text: 'aside' }] });
    // A new broker reads the file: the daemon restarted.
    const again = makeBroker(h);
    const s = connectShim(again.b, 't1');
    await s.next('welcome');
    assert.deepEqual(await s.call('c1', 'read_conversation', {}), { type: 'result', id: 'c1', ok: true, text: 'You: hello\n\n@dev: yo' });
    assert.equal((await s.call('c2', 'read_conversation', { thread: 'th_side' })).text, 'aside');
    assert.deepEqual(await s.call('c3', 'read_message', { id: 'nope' }), {
      type: 'result',
      id: 'c3',
      ok: false,
      text: 'There’s no item “nope” in this conversation. Your history and read_conversation give the id of each item they cut.',
    });
    assert.deepEqual(again.sent, [], 'reading tools never cross to Postbox');
    // No snapshot yet: the call says so, and snapshot-items is refused.
    h.turn('t2');
    const s2 = connectShim(again.b, 't2');
    await s2.next('welcome');
    const none = await s2.call('c1', 'read_message', { id: 'i1' });
    assert.equal(none.ok, false);
    assert.match(none.text, /^Postbox hasn’t sent this host the conversation yet/);
    assert.equal((await again.post('snapshot-items', { turn: 't2', thread: 'th', items: [] })).errors[0].code, 'no-turn');
  } finally {
    h.done();
  }
});

// ── Files in the agent’s folder ──

test('show_app’s codePath and files are read from the turn’s folder, never outside it, under the laptop’s limits', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    writeFileSync(join(h.work, 'app.html'), '<p>hi</p>');
    writeFileSync(join(h.work, 'data.csv'), 'a,b\n1,2\n');
    mkdirSync(join(h.work, 'sub'));
    writeFileSync(join(h.home, 'secret.txt'), 'no');
    symlinkSync(join(h.home, 'secret.txt'), join(h.work, 'link.txt'));
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    assert.equal(
      (await s.call('c1', 'show_app', { id: 'app_1', title: 'Hi', codePath: 'app.html', files: [{ path: 'data.csv' }, { name: 'n.txt', path: './data.csv' }] }))
        .ok,
      true,
    );
    assert.deepEqual(k.sent[0].args, {
      id: 'app_1',
      title: 'Hi',
      code: '<p>hi</p>',
      files: [
        { name: 'data.csv', base64: Buffer.from('a,b\n1,2\n').toString('base64') },
        { name: 'n.txt', base64: Buffer.from('a,b\n1,2\n').toString('base64') },
      ],
    });
    const refused = async (id, args) => {
      const r = await s.call(id, 'update_app', { id: 'app_1', ...args });
      assert.equal(r.ok, false, JSON.stringify(args));
      return r.text;
    };
    assert.equal(await refused('c2', { codePath: '../secret.txt' }), '../secret.txt is outside your folder, so Postbox didn’t read it (codePath).');
    assert.equal(await refused('c3', { codePath: 'link.txt' }), 'link.txt is outside your folder, so Postbox didn’t read it (codePath).');
    assert.equal(await refused('c4', { codePath: 'nope.html' }), 'There’s no file at nope.html (codePath).');
    assert.equal(await refused('c5', { codePath: 'sub' }), 'sub isn’t a file (codePath).');
    assert.equal(await refused('c6', { code: '<p>x</p>', codePath: 'app.html' }), 'Send code or codePath, not both.');
    assert.equal(
      await refused('c7', { code: 'x', files: [{ name: 'a b', path: 'data.csv' }] }),
      '“a b” can’t name a file: use letters, digits and - _ . (up to 64).',
    );
    assert.equal(await refused('c8', { code: 'x', files: [{ path: 'data.csv' }, { path: 'sub/../data.csv' }] }), 'Two files are named “data.csv”.');
    // A file Postbox made itself can’t be named by the call.
    assert.equal(
      await refused('c9', { code: 'x', files: [{ name: 'f', base64: 'eA==' }] }),
      'the file “f” (up to 20 MB) needs a path to a file in your folder.',
    );
    assert.equal(k.sent.length, 1, 'nothing refused crossed');
    // Over what one message from the host can carry, once read: refused, saying so.
    writeFileSync(join(h.work, 'big.bin'), Buffer.alloc(13 * 1024 * 1024));
    assert.match(await refused('c10', { code: 'x', files: [{ path: 'big.bin' }] }), /^update_app comes to 17\.\d MiB once its files are read, over the 16 MiB/);
    const direct = await inlineAppFiles(h.work, { code: 'x' });
    assert.deepEqual(direct, { ok: true, args: { code: 'x' } }, 'without codePath and files, the call is unchanged');
  } finally {
    h.done();
  }
});

test('a file swapped for a link after it was checked isn’t read: the file opened is checked, not the path', async () => {
  const h = makeHome();
  try {
    const secret = join(h.home, 'secret');
    mkdirSync(secret);
    writeFileSync(join(secret, 'app.html'), 'credential');
    writeFileSync(join(h.work, 'app.html'), '<p>hi</p>');
    mkdirSync(join(h.work, 'sub'));
    writeFileSync(join(h.work, 'sub', 'app.html'), '<p>hi</p>');
    /** Runs once, between the containment check and the open, as an agent racing the broker would. */
    const between = (swap) => {
      let done = false;
      return {
        beforeOpen: (real) => {
          if (done) return;
          done = true;
          swap(real);
        },
      };
    };
    // The file itself becomes a link to one outside.
    const file = await inlineAppFiles(
      h.work,
      { codePath: 'app.html' },
      between((real) => {
        rmSync(real);
        symlinkSync(join(secret, 'app.html'), real);
      }),
    );
    assert.deepEqual(file, { ok: false, text: 'app.html is outside your folder, so Postbox didn’t read it (codePath).' });
    // A folder on its path becomes a link to one outside.
    const dir = await inlineAppFiles(
      h.work,
      { code: 'x', files: [{ path: 'sub/app.html' }] },
      between(() => {
        rmSync(join(h.work, 'sub'), { recursive: true });
        symlinkSync(secret, join(h.work, 'sub'));
      }),
    );
    assert.deepEqual(dir, { ok: false, text: 'sub/app.html is outside your folder, so Postbox didn’t read it (the file “app.html” (up to 20 MB)).' });
    // Without a swap, the same calls read the files.
    rmSync(join(h.work, 'app.html'));
    writeFileSync(join(h.work, 'app.html'), '<p>hi</p>');
    assert.deepEqual(
      await inlineAppFiles(
        h.work,
        { codePath: 'app.html' },
        between(() => {}),
      ),
      { ok: true, args: { code: '<p>hi</p>' } },
    );
  } finally {
    h.done();
  }
});

// ── Permission prompts ──

test('a prompt crosses to Postbox, its answer reaches the shim, and again when the shim resends it after a reconnect', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    await until(() => k.sent.length, 'the prompt');
    assert.deepEqual(k.sent[0], { type: 'prompt', id: 'p1', turn: 't1', request: REQUEST });
    assert.deepEqual(
      lines(h.p.turn('t1', TURN_FILES.prompts)).map((x) => x.op),
      ['prompt'],
    );
    assert.equal((await k.post('answer', { turn: 't1', prompt: 'nope', result: { behavior: 'deny', message: 'no' } })).errors[0].code, 'no-prompt');
    // The shim went away; the answer waits for it.
    s.close();
    const allow = { behavior: 'allow', updatedInput: { command: 'ls' } };
    assert.deepEqual((await k.post('answer', { turn: 't1', prompt: 'p1', result: allow })).errors, []);
    assert.equal(s.got.filter((m) => m.type === 'permission-answer').length, 0);
    assert.deepEqual(
      (await k.hello()).filter((m) => m.type === 'prompt'),
      [],
      'an answered prompt isn’t sent again',
    );
    // A restarted daemon still has the answer.
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    const s2 = connectShim(again.b, 't1');
    await s2.next('welcome');
    s2.send('permission', { id: 'p1', request: REQUEST });
    assert.deepEqual(await s2.next('permission-answer'), { type: 'permission-answer', id: 'p1', result: allow });
    assert.deepEqual(again.sent, [], 'a resent prompt isn’t a new one');
  } finally {
    h.done();
  }
});

test('a prompt the shim expired or the harness canceled ends: Postbox hears prompt-expired, now or at its next hello', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    s.send('permission', { id: 'p2', request: REQUEST });
    s.send('permission', { id: 'p3', request: REQUEST });
    await until(() => k.sent.length === 3, 'three prompts');
    s.send('permission-expired', { id: 'p1', at: 111 });
    await until(() => k.sent.length === 4, 'the expiry');
    assert.deepEqual(k.sent[3], { type: 'prompt-expired', id: 'p1', turn: 't1', at: 111, reason: 'expired' });
    k.state.attached = false;
    s.send('permission-canceled', { id: 'p2', at: 222 });
    await until(() => k.b.pending.expiries.length, 'the held expiry');
    // Across a restart, the unsent expiry and the prompt still waiting are sent at the next hello.
    const again = makeBroker(h);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(await again.hello(), [
      { type: 'prompt', id: 'p3', turn: 't1', request: REQUEST },
      { type: 'prompt-expired', id: 'p2', turn: 't1', at: 222, reason: 'canceled' },
    ]);
    assert.deepEqual(
      (await again.hello()).map((m) => m.type),
      ['prompt'],
      'an expiry is sent once',
    );
    assert.equal((await again.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'late' } })).errors[0].code, 'no-prompt');
    // Once the turn has ended, a prompt still waiting can’t be answered: the hello ends it instead.
    writeFileSync(h.p.turn('t1', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
    const after = await again.hello();
    assert.deepEqual(
      after.map((m) => [m.type, m.id]),
      [['prompt-expired', 'p3']],
    );
    assert.equal(after[0].reason, 'canceled');
  } finally {
    h.done();
  }
});

test('Stop ends a turn’s waiting prompts, and an answer for them is refused', async () => {
  const h = makeHome();
  try {
    h.turn('t1');
    const k = makeBroker(h);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    await until(() => k.sent.length, 'the prompt');
    await k.b.stopping('t1');
    assert.deepEqual(k.sent.at(-1), { type: 'prompt-expired', id: 'p1', turn: 't1', at: k.sent.at(-1).at, reason: 'canceled' });
    assert.equal((await k.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'x' } })).errors[0].code, 'no-prompt');
    s.send('permission', { id: 'p2', request: REQUEST });
    assert.equal((await s.next('error', (m) => m.code === 'turn-ended')).message, STOPPED_TEXT);
  } finally {
    h.done();
  }
});

test('an expiry the broker can’t write down still ends the prompt, unanswerable, and Postbox hears an error, not prompt-expired', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('t1');
    const file = h.p.turn('t1', TURN_FILES.prompts);
    const wait = 60_000;
    const opts = { now: clock.now, timers: clock.timers, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) };
    const k = makeBroker(h, opts);
    const s = connectShim(k.b, 't1');
    await s.next('welcome');
    s.send('permission', { id: 'p1', request: REQUEST });
    s.send('permission', { id: 'p2', request: REQUEST });
    await until(() => k.sent.length === 2, 'the prompts');
    // prompts.jsonl can’t be appended to while the harness cancels p1; what it held before is put back after.
    const before = readFileSync(file, 'utf8');
    blockFile(file);
    s.send('permission-canceled', { id: 'p1', at: clock.now() });
    await until(() => k.sent.length === 3, 'the error');
    assert.deepEqual(
      k.sent.slice(2).map((m) => [m.type, m.code, m.re, m.turn]),
      [['error', 'internal', 'prompt-expired', 't1']],
      'no prompt-expired, as if it were on disk',
    );
    assert.match(k.sent[2].message, /couldn’t write down that prompt p1 in turn t1 was canceled/);
    // The shim gave up on it all the same: it can’t be answered, and isn’t sent again.
    const late = await k.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'late' } });
    assert.equal(late.errors[0]?.code, 'no-prompt');
    assert.deepEqual(
      (await k.hello()).map((m) => [m.type, m.id]),
      [['prompt', 'p2']],
    );
    assert.deepEqual(
      s.got.filter((m) => m.type === 'permission-answer'),
      [],
    );
    rmSync(file, { recursive: true });
    writeFileSync(file, before);
    k.b.close();
    // A restart from those records: nothing said p1 ended, so it waits again, and Postbox is shown it. No shim waits for
    // it (the shim sent its notice, and resends only p2), so at permissionWaitMax from when it was asked, when any shim
    // would have given up, it ends.
    const again = makeBroker(h, opts);
    await again.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(
      (await again.hello()).map((m) => [m.type, m.id]),
      [
        ['prompt', 'p1'],
        ['prompt', 'p2'],
      ],
    );
    const s2 = connectShim(again.b, 't1');
    await s2.next('welcome');
    s2.send('permission', { id: 'p2', request: REQUEST });
    await sleep(20);
    await clock.tick(wait);
    await until(() => again.sent.length, 'p1’s expiry');
    assert.deepEqual(
      again.sent.map((m) => [m.type, m.id, m.reason]),
      [['prompt-expired', 'p1', 'expired']],
      'p2’s shim still waits on it, and ends it itself',
    );
    assert.deepEqual(
      again.b.pending.prompts.map((q) => q.id),
      ['p2'],
    );
    assert.equal((await again.post('answer', { turn: 't1', prompt: 'p1', result: { behavior: 'deny', message: 'late' } })).errors[0]?.code, 'no-prompt');
    again.b.close();
    // Restarted past that point, the prompts nobody has sent again are ended at the hello, not shown.
    const third = makeBroker(h, opts);
    writeFileSync(file, `${JSON.stringify({ op: 'prompt', id: 'p3', request: REQUEST, at: clock.now() - wait })}\n`, { flag: 'a' });
    await third.b.load([{ turn: 't1', state: 'running' }]);
    assert.deepEqual(
      (await third.hello()).map((m) => [m.type, m.id]),
      [
        ['prompt-expired', 'p2'],
        ['prompt-expired', 'p3'],
      ],
    );
    third.b.close();
  } finally {
    h.done();
  }
});

// ── Codex approvals ──

test('Codex: a request nobody answers is declined on the held stdin at permissionWaitMax, and Postbox hears it expired', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('cx', { harness: 'codex', stdin: 'held' });
    const out = h.p.turn('cx', TURN_FILES.out);
    const inn = h.p.turn('cx', TURN_FILES.in);
    const wait = 60_000;
    const k = makeBroker(h, { now: clock.now, timers: clock.timers, codexPollMs: 1000, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) });
    // Recorded shapes: the requests server/adapters/codex.mjs answers in codexApproval.
    writeFileSync(
      out,
      [
        '{"method":"turn/started","params":{"turn":{"id":"u1"}}}',
        '{"id":7,"method":"item/commandExecution/requestApproval","params":{"itemId":"i1","command":"rm -rf build"}}',
        '{"id":8,"method":"item/fileChange/requestApproval","params":{"itemId":"i2"}}',
        '{"id":"e9","method":"mcpServer/elicitation/request","params":{"serverName":"github","message":"Allow?"}}',
        '{"id":3,"result":{}}',
        '',
      ].join('\n'),
    );
    await k.b.started('cx');
    assert.deepEqual(k.b.pending.watches, ['cx']);
    // Postbox answers 8 through the daemon’s write; the runner appends it to in.jsonl.
    const check = k.b.checkWrite('cx', '{"id":8,"result":{"decision":"accept"}}');
    assert.ok('done' in check);
    check.done(true);
    writeFileSync(inn, '{"id":8,"result":{"decision":"accept"}}\n');
    // Noted, so a restart doesn’t take a denial of Postbox’s in in.jsonl for the daemon’s own decline.
    await until(() => lines(h.p.turn('cx', TURN_FILES.prompts)).some((x) => x.op === 'codex-answered' && x.id === 'codex:8'), 'Postbox’s answer’s note');
    await clock.tick(wait - 1000);
    assert.deepEqual(k.writes, [], 'not yet');
    // Half a line now, the rest later: a request is read only once it’s whole.
    await appendFile(out, '{"id":10,"method":"item/commandExecution/req');
    await clock.tick(1000);
    assert.deepEqual(
      k.writes.map((w) => w.line).sort(),
      [codexDeclineLine('item/commandExecution/requestApproval', 7), codexDeclineLine('mcpServer/elicitation/request', 'e9')].sort(),
    );
    assert.deepEqual(JSON.parse(codexDeclineLine('mcpServer/elicitation/request', 'e9')), { id: 'e9', result: { action: 'decline' } });
    assert.deepEqual(JSON.parse(codexDeclineLine('item/fileChange/requestApproval', 1)).result, CODEX_DECLINE['item/fileChange/requestApproval']);
    assert.deepEqual(
      k.sent.map((m) => [m.type, m.id, m.reason]).sort(),
      [
        ['prompt-expired', 'codex:e9', 'expired'],
        ['prompt-expired', 'codex:7', 'expired'],
      ].sort(),
    );
    // A late answer to a declined request is refused: Codex gets one answer to each.
    const late = k.b.checkWrite('cx', '{"id":7,"result":{"decision":"accept"}}');
    assert.ok('refused' in late);
    assert.match(late.refused, /was declined at the host’s permissionWaitMax/);
    // The request finished writing, and turn/completed ends it without a decline.
    await appendFile(out, 'uestApproval","params":{}}\n');
    await clock.tick(1000);
    await appendFile(out, '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n');
    await clock.tick(wait);
    assert.equal(k.writes.length, 2);
    // A restarted daemon knows when it first saw a request, and what it declined.
    await appendFile(out, '{"id":11,"method":"item/commandExecution/requestApproval","params":{}}\n');
    await clock.tick(1000);
    await clock.tick(30_000);
    k.b.close();
    const again = makeBroker(h, { now: clock.now, timers: clock.timers, codexPollMs: 1000, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) });
    await again.b.load([{ turn: 'cx', state: 'running' }]);
    assert.deepEqual(again.writes, [], 'requests 7 and e9 were declined already, and 11 is new');
    await clock.tick(wait - 30_000 - 1);
    assert.deepEqual(again.writes, []);
    // The fake clock runs a timer at the end of its tick, so the next look is a poll interval on, still well before
    // permissionWaitMax from this daemon’s start.
    await clock.tick(1000);
    assert.deepEqual(
      again.writes.map((w) => JSON.parse(w.line).id),
      [11],
      'declined permissionWaitMax after the first daemon saw it',
    );
    // A turn that has ended isn’t watched any more.
    writeFileSync(h.p.turn('cx', TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 1 }));
    await clock.tick(1000);
    assert.deepEqual(again.b.pending.watches, []);
    // Only held Codex turns are watched.
    h.turn('cc');
    await again.b.started('cc');
    assert.deepEqual(again.b.pending.watches, []);
    again.b.close();
    assert.equal(codexPromptId(7), 'codex:7');
    assert.equal(codexPromptId('x'.repeat(200)), null);
  } finally {
    h.done();
  }
});

const ACCEPT_7 = '{"id":7,"result":{"decision":"accept"}}';
const REQUEST_7 = '{"id":7,"method":"item/commandExecution/requestApproval","params":{"command":"ls"}}';

test('Codex: a daemon that dies before its decline reaches the held stdin leaves the request waiting, and the next one declines it', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('cx', { harness: 'codex', stdin: 'held' });
    const wait = 60_000;
    const opts = { now: clock.now, timers: clock.timers, codexPollMs: 1000, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) };
    writeFileSync(h.p.turn('cx', TURN_FILES.out), `${REQUEST_7}\n`);
    let tries = 0;
    // The daemon dies as it hands the decline to the runner: nothing reaches in.jsonl, so Codex never got it.
    const k = makeBroker(h, {
      ...opts,
      writeStdin: () => {
        tries++;
        return new Promise(() => {});
      },
    });
    await k.b.started('cx');
    void clock.tick(wait);
    await until(() => tries, 'the decline to start');
    assert.deepEqual(k.sent, [], 'Postbox hears nothing before Codex has the decline');
    k.b.close();
    // The next daemon finds the request unanswered in in.jsonl, so it still waits, and it’s past permissionWaitMax
    // from when the first daemon saw it: declined as the turn is watched again.
    const again = makeBroker(h, opts);
    await again.b.load([{ turn: 'cx', state: 'running' }]);
    assert.deepEqual(
      again.writes.map((w) => w.line),
      [codexDeclineLine('item/commandExecution/requestApproval', 7)],
    );
    assert.deepEqual(
      again.sent.map((m) => [m.type, m.id, m.reason]),
      [['prompt-expired', 'codex:7', 'expired']],
    );
    const late = again.b.checkWrite('cx', ACCEPT_7);
    assert.ok('refused' in late, 'Codex gets one answer to it');
    assert.match(late.refused, /was declined at the host’s permissionWaitMax/);
    await clock.tick(wait);
    assert.equal(again.writes.length, 1, 'declined once');
    again.b.close();
  } finally {
    h.done();
  }
});

test('Codex: a decline the runner doesn’t take leaves the request waiting, with nothing sent to Postbox, and the next look declines it', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('cx', { harness: 'codex', stdin: 'held' });
    const inn = h.p.turn('cx', TURN_FILES.in);
    const wait = 60_000;
    let down = true;
    /** @type {string[]} */
    const went = [];
    const k = makeBroker(h, {
      now: clock.now,
      timers: clock.timers,
      codexPollMs: 1000,
      settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }),
      writeStdin: async (_turn, line) => {
        if (down) throw new Error('the runner went away');
        went.push(line);
        await appendFile(inn, `${line}\n`);
        return statSync(inn).size;
      },
    });
    writeFileSync(h.p.turn('cx', TURN_FILES.out), `${REQUEST_7}\n`);
    await k.b.started('cx');
    await clock.tick(wait);
    assert.deepEqual(k.sent, [], 'no expiry: Codex didn’t get the decline');
    assert.match(k.logs.join('\n'), /Couldn’t decline Codex’s request 7 in turn cx: the runner went away/);
    // It waits again: Postbox may still answer it (this write didn’t go either).
    const check = k.b.checkWrite('cx', ACCEPT_7);
    assert.ok('done' in check, 'Postbox may still answer it');
    check.done(false);
    down = false;
    await clock.tick(1000);
    assert.deepEqual(went, [codexDeclineLine('item/commandExecution/requestApproval', 7)], 'declined at the next look');
    assert.deepEqual(
      k.sent.map((m) => [m.type, m.id, m.reason]),
      [['prompt-expired', 'codex:7', 'expired']],
    );
    assert.ok('refused' in k.b.checkWrite('cx', ACCEPT_7));
    await until(() => lines(h.p.turn('cx', TURN_FILES.prompts)).some((x) => x.op === 'expiry-sent'), 'the expiry’s record');
    k.b.close();
    // A restarted daemon refuses a late answer to it, and has nothing more to tell Postbox.
    const again = makeBroker(h, { now: clock.now, timers: clock.timers, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) });
    await again.b.load([{ turn: 'cx', state: 'running' }]);
    assert.ok('refused' in again.b.checkWrite('cx', ACCEPT_7));
    assert.deepEqual(await again.hello(), []);
    assert.deepEqual(again.writes, []);
    again.b.close();
  } finally {
    h.done();
  }
});

test('Codex: in.jsonl says what Codex got: after a restart a decline there still owes Postbox its expiry, and no request answered there takes another answer', async () => {
  const h = makeHome();
  const clock = fakeClock();
  try {
    h.turn('cx', { harness: 'codex', stdin: 'held' });
    const wait = 60_000;
    const opts = { now: clock.now, timers: clock.timers, codexPollMs: 1000, settings: () => ({ ...HOST_DEFAULTS, permissionWaitMax: wait }) };
    const request = (id) => JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } });
    writeFileSync(h.p.turn('cx', TURN_FILES.out), `${[7, 8, 9].map(request).join('\n')}\n`);
    // A daemon declined 7 and died before Postbox heard; Postbox denied 8 itself (codexApproval’s same line) and 9 it allowed.
    const decline = (id) => codexDeclineLine('item/commandExecution/requestApproval', id);
    writeFileSync(h.p.turn('cx', TURN_FILES.in), `${decline(7)}\n${decline(8)}\n{"id":9,"result":{"decision":"accept"}}\n`);
    writeFileSync(h.p.turn('cx', TURN_FILES.prompts), `${JSON.stringify({ op: 'codex-answered', id: 'codex:8', at: 1 })}\n`);
    const k = makeBroker(h, opts);
    k.state.attached = false;
    await k.b.load([{ turn: 'cx', state: 'running' }]);
    k.state.attached = true;
    const hello = await k.hello();
    assert.deepEqual(
      hello.map((m) => [m.type, m.id, m.reason]),
      [['prompt-expired', 'codex:7', 'expired']],
      'only the host’s own decline was unsent',
    );
    for (const id of [7, 8, 9]) assert.ok('refused' in k.b.checkWrite('cx', JSON.stringify({ id, result: { decision: 'accept' } })), `a later answer to ${id}`);
    await clock.tick(wait);
    assert.deepEqual(k.writes, [], 'nothing is declined again');
    assert.deepEqual(await k.hello(), [], 'an expiry is sent once');
    await until(() => lines(h.p.turn('cx', TURN_FILES.prompts)).some((x) => x.op === 'expiry-sent'), 'the expiry’s record');
    k.b.close();
    const again = makeBroker(h, opts);
    await again.b.load([{ turn: 'cx', state: 'running' }]);
    assert.deepEqual(await again.hello(), [], 'and not after the next restart');
    again.b.close();
  } finally {
    h.done();
  }
});

// ── Through the daemon ──

test('the daemon: a shim on its socket reaches the broker, Stop refuses the turn’s calls, and a held-stdin write still goes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pbbd-'));
  const p = hostPaths(home, VERSION);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  writeFileSync(p.token, TOKEN, { mode: 0o600 });
  const work = join(home, 'work');
  mkdirSync(work);
  const alive = new Set();
  const writes = [];
  let pid = 4000;
  const daemon = createDaemon({
    home,
    version: VERSION,
    async launchRunner(o) {
      writeFileSync(o.paths.turn(o.turn, TURN_FILES.runner), JSON.stringify({ turn: o.turn, version: VERSION, pid: ++pid, bootId: BOOT, startTime: 1 }), {
        mode: 0o600,
      });
      alive.add(o.turn);
      return { pid, scoped: false, lingerOff: false };
    },
    askRunner: async (_path, turn) => alive.has(turn),
    proc: { sameProcess: async () => true, toolGroups: () => [], liveGroups: () => [] },
    async writeRunner(o) {
      writes.push(o.line);
      return 10;
    },
    findPrograms: async () => ({
      node: { path: '/usr/bin/node', version: 'v22.12.0' },
      harnesses: [
        { name: 'claude-code', path: '/usr/bin/claude', version: '2.1.300', looked: [] },
        { name: 'codex', path: '/usr/bin/codex', version: '0.50.0', looked: [] },
      ],
      problems: [],
    }),
    kill: () => {},
    log: () => {},
    pollMs: 10,
    stopGraceMs: 60_000,
  });
  try {
    await daemon.start();
    const input = new PassThrough();
    const output = new PassThrough();
    daemon.connect({ input, output });
    const msgs = readMessages(output);
    const send = (type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
    send('hello', { version: PROTOCOL_VERSION, token: TOKEN, settings: { permissionWaitMax: 60_000 } });
    await msgs.next('welcome');
    send('snapshot', { turn: 't1', home: 'th', threads: [{ id: 'th', items: [{ id: 'i1', line: 'You: hi', text: 'You: hi' }] }] });
    send('start', { turn: 't1', harness: 'claude-code', folder: work, argv: [], env: {}, stdin: 'file', files: [{ name: MESSAGE_FILE, text: '{}\n' }] });
    await msgs.next('started');
    // A shim, over a socket-shaped pair, as accept() sees one.
    const toDaemon = new PassThrough();
    const fromDaemon = new PassThrough();
    daemon.accept(/** @type {any} */ (Duplex.from({ readable: toDaemon, writable: fromDaemon })));
    const got = [];
    let buf = '';
    fromDaemon.on('data', (d) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        got.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    });
    const shimSend = (type, body) => toDaemon.write(encode(message('shim-to-daemon', type, body)));
    shimSend('hello', { token: TOKEN, turn: 't1' });
    await until(() => got.find((m) => m.type === 'welcome'), 'the welcome');
    assert.equal(got[0].permissionWaitMax, 60_000, 'the setting from Postbox’s hello');
    shimSend('call', { id: 'c1', name: 'read_conversation', args: {} });
    assert.equal((await until(() => got.find((m) => m.id === 'c1'), 'c1’s result')).text, 'You: hi', 'the snapshot sent before start');
    shimSend('call', { id: 'c2', name: 'show_block', args: { block: BLOCK } });
    assert.equal((await msgs.next('tool')).id, 'c2');
    send('stop', { turn: 't1' });
    await until(() => got.find((m) => m.type === 'error' && m.code === 'turn-ended'), 'the shim to hear Stop');
    shimSend('call', { id: 'c3', name: 'show_block', args: { block: { ...BLOCK, id: 'other' } } });
    assert.equal((await until(() => got.find((m) => m.id === 'c3'), 'c3’s result')).ok, false);
    await sleep(30);
    assert.equal(msgs.messages.filter((m) => m.type === 'tool').length, 1, 'nothing after Stop reached Postbox');
    // A held Codex turn’s write passes the broker’s check (a declined request’s answer is refused: the Codex test).
    send('start', { turn: 'cx', harness: 'codex', folder: work, argv: [], env: {}, stdin: 'held', files: [] });
    await msgs.next('started');
    send('write', { turn: 'cx', line: '{"id":1,"result":{"decision":"accept"}}' });
    assert.equal((await msgs.next('written')).upTo, 10);
    assert.deepEqual(writes, ['{"id":1,"result":{"decision":"accept"}}']);
  } finally {
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
