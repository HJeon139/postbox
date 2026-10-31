// A completed turn can still be recording its work when shutdown starts. Close the store only after its final writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

test('shutdown drains the work ledger and final reply annotation before closing Redis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-close-ledger-'));
  const app = await start({ port: 4438, dataDir: dir, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
  const { rt, store } = app;
  store.emit('thread', { id: 'th_close', members: [] });
  store.emit('item.add', { threadId: 'th_close', item: { id: 'it_close', turnId: 'tu_close', kind: 'agent', text: 'Done.' } });
  const turn = { id: 'tu_close', threadId: 'th_close' };
  rt.ledger.startTurn(turn, { se: { id: 'se_close', handle: 'closer' } });
  rt.ledger.add('th_close', { id: 'read_close', kind: 'read', turnId: turn.id, tool: 'Read', path: 'design.md' });
  let release;
  const pending = new Promise((ok) => {
    release = ok;
  });
  turn.work.pending.push(pending);
  const ended = rt.endWork(turn, 'done');
  const idle = rt.ledger.idle.bind(rt.ledger);
  rt.ledger.idle = () => {
    release();
    return idle();
  };
  const close = store.close.bind(store);
  store.close = async () => {
    assert.equal(rt.ledger.pending.size, 0, 'work has finished');
    assert.equal(store.item('th_close', 'it_close').workTurn, 'tu_close', 'the reply has its final work annotation');
    await close();
  };
  try {
    await app.close();
  } finally {
    release();
    await ended;
    store.close = close;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('#553: a stop that fails while the store is down (a kept job’s end is refused with ESTOREDOWN) still reaches store.close()', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-close-outage-'));
  const app = await start({ port: 4439, dataDir: dir, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
  const { rt, store } = app;
  // stopKeptJobs → endJob → emit throws ESTOREDOWN while writes are closed; the first Ctrl-C’s close() must go on.
  rt.stopTurns = async () => {
    throw Object.assign(new Error('Postbox can’t save changes right now, so it didn’t make this one.'), { code: 'ESTOREDOWN' });
  };
  let closed = false;
  const close = store.close.bind(store);
  store.close = async () => {
    closed = true;
    await close();
  };
  const logged = [];
  const { error } = console;
  console.error = (m) => logged.push(String(m));
  try {
    await app.close();
  } finally {
    console.error = error;
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(closed, true, 'the store was closed, and its Redis let go of');
  assert.match(logged.join('\n'), /couldn’t stop its turns cleanly.*can’t save changes/);
});

// The integrator’s re-review of #553, not blocking: during an outage, shutdown stopped at the first emit that threw
// ESTOREDOWN in each step, and closed the HTTP server before the store, so the store’s flush could run on an empty event
// loop and the process exit before it logged what was lost.

test('#553: close() closes the store while the server still listens, so the flush runs on a live event loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-close-order-'));
  const app = await start({ port: 4440, dataDir: dir, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const order = [];
  const closeStore = app.store.close.bind(app.store);
  app.store.close = async () => {
    order.push(`store (server listening: ${app.server.listening})`);
    await closeStore();
  };
  const closeServer = app.server.close.bind(app.server);
  app.server.close = (cb) => {
    order.push('server');
    return closeServer(cb);
  };
  try {
    await app.close();
    assert.deepEqual(order, ['store (server listening: true)', 'server']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#553: a turn whose stop throws while the store is down doesn’t keep the other turns, the hosts’ link or the kept jobs from being stopped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-close-turns-'));
  const app = await start({ port: 4441, dataDir: dir, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
  const { rt } = app;
  const down = () => Object.assign(new Error('Postbox can’t save changes right now, so it didn’t make this one.'), { code: 'ESTOREDOWN' });
  const stopped = [];
  rt.turns.set('se_a', /** @type {any} */ ({ remote: false }));
  rt.turns.set('se_b', /** @type {any} */ ({ remote: false }));
  rt.stop = (id) => {
    stopped.push(id);
    if (id === 'se_a') throw down();
    return true;
  };
  let linkClosed = false;
  rt.remote.close = () => {
    linkClosed = true;
  };
  let keptStopped = false;
  rt.stopKeptJobs = async () => {
    keptStopped = true;
  };
  const logged = [];
  const { error } = console;
  console.error = (m) => logged.push(String(m));
  const outcome = await rt.stopTurns({ graceMs: 0 }).then(
    () => null,
    (e) => e,
  );
  console.error = error;
  rt.turns.clear();
  try {
    assert.equal(outcome, null, `stopTurns threw at the first turn: ${outcome?.message}`);
    assert.deepEqual(stopped, ['se_a', 'se_b'], 'every turn is stopped');
    assert.ok(linkClosed, 'the hosts’ link is closed');
    assert.ok(keptStopped, 'the kept jobs are stopped');
    assert.ok(
      logged.some((m) => /se_a.*can’t save changes/.test(m)),
      `the failed stop is logged: ${logged.join(' | ')}`,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('#553: a kept job whose end is refused while the store is down doesn’t keep the other kept jobs from being stopped', async () => {
  const { stopKeptJobs } = await import('../server/kept-jobs.mjs');
  const ended = [];
  const rt = /** @type {any} */ ({
    keptJobs: () => [
      { sessionId: 'se_1', id: 'j1', label: 'one', kept: true, pgid: 1001 },
      { sessionId: 'se_1', id: 'j2', label: 'two', kept: true, pgid: 1002 },
    ],
    listProcesses: async () => [],
    signalProcess: () => {},
    endJob: (_se, id) => {
      ended.push(id);
      if (id === 'j1') throw Object.assign(new Error('Postbox can’t save changes right now, so it didn’t make this one.'), { code: 'ESTOREDOWN' });
    },
  });
  const logged = [];
  const { error } = console;
  console.error = (m) => logged.push(String(m));
  try {
    await stopKeptJobs(rt, ['se_1'], 'Postbox stopped it as it shut down.');
  } finally {
    console.error = error;
  }
  assert.deepEqual(ended, ['j1', 'j2']);
  assert.ok(
    logged.some((m) => /“one”.*can’t save changes/.test(m)),
    `the failed end is logged: ${logged.join(' | ')}`,
  );
});
