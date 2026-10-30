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
