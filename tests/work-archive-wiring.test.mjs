// The archive pass wired into the runtime (#305; designs/305-archive-turns.md, “When the pass runs”, “Existing data”):
// after a turn’s work is recorded, the pass runs for its conversation through one chain per conversation, out of the
// turn’s path; a failure is logged once and the chain goes on; a closed store is skipped; shutdown waits a bounded
// time; and only `config.archiveTurns === true`, through the config server/index.mjs passes to new Runtime, turns it on
// (T-22).

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { start } from '../server/index.mjs';
import { assertNoServerFailures, captureServerLog } from './server-log.mjs';
import { setup as plainSetup, settle, sleep } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

// Its Postbox runs in this process: a test fails on an error or a warning it logs (tests/server-log.mjs).
captureServerLog();
afterEach(assertNoServerFailures);

process.env.POSTBOX_BACKENDS = 'mock';

/** A runtime with the passes on, as config.archiveTurns would turn them on. */
function setup() {
  const ctx = plainSetup();
  ctx.rt.turnArchive.enabled = true;
  return ctx;
}

/** `n` turns for @alpha in the conversation, one after another. @param {any} ctx */
async function turns(ctx, n, from = 1) {
  for (let k = from; k < from + n; k++) {
    ctx.rt.sendMessage(ctx.t.id, { text: `@alpha turn ${k}` });
    await settle(ctx.rt);
  }
  await ctx.rt.turnArchive.idle(ctx.t.id);
  return ctx;
}
const summaries = (/** @type {any} */ store, /** @type {string} */ convId) =>
  (store.state.work[convId] ?? []).filter((/** @type {any} */ e) => e.kind === 'turn-archive');

/** Captures console.error and console.warn lines while `fn` runs. @param {() => Promise<void>} fn */
async function logged(fn) {
  const lines = [];
  const { error, warn } = console;
  console.error = console.warn = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, { error, warn });
  }
  return lines;
}

test('ending a third turn archives the first, through the runtime', async () => {
  const { store, t } = await turns(setup(), 3);
  assert.equal(summaries(store, t.id).length, 1);
  assert.equal(store.state.work[t.id].filter((/** @type {any} */ e) => e.kind === 'turn').length, 2, 'the last two turns stay hot');
});

test('a rejected commit is logged once, the chain settles, and the next turn’s end archives', async () => {
  const ctx = setup();
  const { store, t } = ctx;
  const commit = store.commit.bind(store);
  let fail = true;
  store.commit = (/** @type {any[]} */ ...a) => (fail ? Promise.reject(Object.assign(new Error('disk said no'), { code: 'EIO' })) : commit(...a));
  const unhandled = [];
  const onUnhandled = (/** @type {unknown} */ e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const lines = await logged(() => turns(ctx, 3).then(() => {}));
    assert.equal(lines.filter((l) => /archived/.test(l)).length, 1, 'one line for the failed pass');
    assert.match(lines.find((l) => /archived/.test(l)) ?? '', /disk said no/);
    assert.equal(summaries(store, t.id).length, 0);
    fail = false;
    await turns(ctx, 1, 4);
    assert.equal(summaries(store, t.id).length, 2, 'the next turn’s end archives both older turns');
    await sleep(5);
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('with the store closed to writes, the pass puts nothing and logs nothing', async () => {
  const ctx = await turns(setup(), 2);
  const { rt, store, t } = ctx;
  let puts = 0;
  const put = rt.ledger.blobs.put.bind(rt.ledger.blobs);
  rt.ledger.blobs.put = (/** @type {Buffer} */ b) => {
    puts++;
    return put(b);
  };
  store.writable = false;
  const lines = await logged(async () => {
    assert.equal(await rt.turnArchive.conversation(t.id), 0);
  });
  store.writable = true;
  assert.equal(puts, 0);
  assert.deepEqual(lines, []);
});

test('back-to-back passes for one conversation join one chain and archive each turn once', async () => {
  const ctx = setup();
  const { rt, store, t } = ctx;
  const enabled = rt.turnArchive.enabled;
  rt.turnArchive.enabled = false; // four turns hot, then three passes at once
  await turns(ctx, 4);
  rt.turnArchive.enabled = enabled;
  const runs = await Promise.all([rt.turnArchive.conversation(t.id), rt.turnArchive.conversation(t.id), rt.turnArchive.conversation(t.id)]);
  assert.deepEqual(runs, [2, 0, 0], 'the first archives both; the others, queued behind it, find nothing');
  assert.equal(new Set(summaries(store, t.id).map((/** @type {any} */ e) => e.turnId)).size, 2);
});

test('after start, all() archives every conversation’s older turns, one conversation at a time', async () => {
  const { rt, store } = setup();
  const convs = ['A', 'B'].map((n) => rt.createThread({ projectId: 'p1', title: `Existing ${n}`, personaIds: [] }));
  for (const c of convs)
    for (const [k, turnId] of ['t1', 't2', 't3'].entries())
      store.emit('work.add', { convId: c.id, entry: { id: `w_${c.id}_${turnId}`, turnId, kind: 'command', command: 'ls', state: 'done', at: k + 1 } });
  await rt.turnArchive.all();
  for (const c of convs)
    assert.deepEqual(
      summaries(store, c.id).map((/** @type {any} */ e) => e.turnId),
      ['t1'],
    );
});

test('the pass after start yields between chunks, so what waits on the event loop runs before it ends', async () => {
  const { rt, store, t } = setup();
  for (let k = 1; k <= 45; k++)
    store.emit('work.add', { convId: t.id, entry: { id: `w${k}`, turnId: `t${k}`, kind: 'command', command: 'ls', state: 'done', at: k } });
  let seen = -1;
  setImmediate(() => (seen = summaries(store, t.id).length));
  await rt.turnArchive.all();
  assert.equal(summaries(store, t.id).length, 43);
  assert.ok(seen > 0 && seen < 43, `an immediate ran mid-pass, at ${seen} archived`);
});

/** Two turns, then a third whose pass holds at its put until released. */
async function heldPut() {
  const ctx = await turns(setup(), 2);
  const { rt, t } = ctx;
  const put = rt.ledger.blobs.put.bind(rt.ledger.blobs);
  /** @type {(v?: any) => void} */
  let release = () => {};
  const gate = new Promise((r) => (release = r));
  let puts = 0;
  rt.ledger.blobs.put = async (/** @type {Buffer} */ b) => {
    puts++;
    await gate;
    return put(b);
  };
  rt.sendMessage(t.id, { text: '@alpha turn 3' });
  await settle(rt);
  return { ...ctx, release, puts: () => puts };
}

test('shutdown ends the chains before the store closes: no put after, and nothing logged', async () => {
  const { rt, store, release, puts } = await heldPut();
  assert.equal(puts(), 1, 'a pass is holding at its put');
  const lines = await logged(async () => {
    const stopping = rt.turnArchive.stop();
    release();
    await stopping;
    const before = puts();
    await store.close();
    assert.equal(await rt.turnArchive.conversation(Object.keys(store.state.threads)[0]), 0);
    await sleep(10);
    assert.equal(puts(), before, 'nothing is put after the store closed');
  });
  assert.deepEqual(lines, [], 'shutdown is not a failure to report');
});

test('a put that hangs doesn’t hold shutdown: stop gives up at its bound with one line', async () => {
  const { rt, puts } = await heldPut();
  assert.equal(puts(), 1);
  const started = Date.now();
  const lines = await logged(() => rt.turnArchive.stop(50));
  assert.ok(Date.now() - started < 1000, 'shutdown went on');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /archive pass was still running after 50 ms/);
});

test('T-22: off by default, a third turn’s end archives nothing and puts no file, and the start pass reads no thread', async () => {
  const { rt, store, t } = plainSetup();
  assert.equal(rt.turnArchive.enabled, false);
  let puts = 0;
  const put = rt.ledger.blobs.put.bind(rt.ledger.blobs);
  rt.ledger.blobs.put = (/** @type {Buffer} */ b) => {
    puts++;
    return put(b);
  };
  await turns({ rt, t }, 3);
  let reads = 0;
  const threads = rt.s.threads;
  Object.defineProperty(rt.s, 'threads', {
    get: () => {
      reads++;
      return threads;
    },
    configurable: true,
  });
  await rt.turnArchive.all();
  assert.equal(reads, 0, 'it returned before reading a thread');
  assert.equal(summaries(store, t.id).length, 0);
  assert.equal(puts, 0);
});

test('T-22: start({ archiveTurns: true }) turns the passes on through the runtime’s config, and nothing else does', async () => {
  for (const [given, on] of [
    [true, true],
    [undefined, false],
    ['true', false],
    [1, false],
  ]) {
    const dir = tempDir('pb-archive-switch-');
    const app = await start({ port: 0, dataDir: join(dir, 'data'), fresh: true, quiet: true, claudeHome: dir, listen: false, archiveTurns: given });
    try {
      assert.equal(app.rt.config.archiveTurns, on, `archiveTurns: ${given}`);
      assert.equal(app.rt.turnArchive.enabled, on, `archiveTurns: ${given}`);
    } finally {
      await app.close();
    }
  }
});

test('T-22: no production source sets archiveTurns to true until step 4 switches it on', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const hits = [];
  for (const dir of ['server', 'bin', 'tools', 'app/js', 'shared'])
    for (const f of await readdir(join(root, dir), { recursive: true }).catch(() => [])) {
      if (!String(f).endsWith('.mjs')) continue;
      const text = await readFile(join(root, dir, String(f)), 'utf8').catch(() => '');
      if (/\barchiveTurns\s*[:=]\s*true\b/.test(text)) hits.push(`${dir}/${f}`);
    }
  assert.deepEqual(hits, [], 'archiveTurns is switched on in production code before its readers are in');
});
