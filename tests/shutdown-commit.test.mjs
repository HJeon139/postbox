// A planned restart loses nothing (designs/architecture/live-progress.md, “A restart mid-turn”): a reply stopped by a
// graceful shutdown keeps every word it had said, and its turn’s ledger record is written before the store closes, even
// when a read it waits on answers after the ledger’s grace. Both through the real start() and close(), on one folder.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HarnessEvents } from '../server/harness-events.mjs';
import * as arrange from './arrange.mjs';
import { captureServerLog, takeServerFailures } from './server-log.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');
captureServerLog();

/** Postbox on `dir`, with a backend whose turn runs `script` and then waits for its Stop. @param {string} dir @param {(emit: any) => Promise<void> | void} [script] */
async function postbox(dir, script) {
  const a = await start({ port: 4467, dataDir: dir, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
  if (script)
    arrange.withAdapter(a.rt, {
      name: 'scripted',
      async deliver(/** @type {any} */ _se, /** @type {any} */ message, /** @type {any} */ ctx) {
        if (message.kind === 'lint') return;
        await script(new HarnessEvents(ctx).event);
        await new Promise((r) => ctx.signal.addEventListener('abort', () => r(undefined), { once: true }));
      },
    });
  return a;
}

/** A conversation with one agent on the scripted backend, its turn started and running. @param {any} a @param {string} folder */
async function running(a, folder) {
  a.store.emit('project', { id: 'p1', name: 'P', folder });
  const p = a.rt.createPersona({ handle: 'writer', backend: 'scripted' });
  const t = a.rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const [se] = arrange.sessionsIn(a.rt, t.id);
  a.rt.sendMessage(t.id, { text: '@writer go' });
  for (let i = 0; i < 200 && !arrange.running(a.rt, se.id); i++) await sleep(10);
  assert.ok(arrange.running(a.rt, se.id), 'the turn runs');
  return t;
}

test('a reply stopped by a graceful shutdown keeps every word it had said, after Postbox starts again', async () => {
  const dir = tempDir('pb-shutdown-words-');
  /** @type {() => void} */
  let said = () => {};
  const saying = new Promise((r) => {
    said = () => r(undefined);
  });
  const a = await postbox(dir, (emit) => {
    emit({ kind: 'text', text: 'Reading the shelf.' });
    emit({ kind: 'text', text: ' Found three' });
    said();
  });
  const t = await running(a, dir);
  await saying;
  // Within the words’ window: the last are still held, not stored.
  await a.close();
  const b = await postbox(dir);
  try {
    const reply = b.store.state.items[t.id].find((/** @type {any} */ i) => i.kind === 'agent');
    assert.equal(reply?.text, 'Reading the shelf. Found three');
  } finally {
    await b.close();
  }
  assert.deepEqual(takeServerFailures(), []);
});

test('a turn’s ledger record that ends after the grace is written before the store closes, with what it has', async () => {
  const dir = tempDir('pb-shutdown-ledger-');
  const file = `${dir}/notes.txt`;
  const a = await postbox(dir, (emit) => {
    emit({ kind: 'tool_call', id: 'e1', name: 'Write', input: { file_path: file, content: 'x' }, final: true });
    emit({ kind: 'tool_result', id: 'e1', text: 'ok' });
  });
  arrange.withDelays(a.rt, { ledgerGraceMs: 30 });
  const t = await running(a, dir);
  await sleep(20);
  // A read of the file the turn changed that answers late, as a slow disk’s does: well past the grace.
  const read = a.rt.ledger.io.read;
  a.rt.ledger.io.read = async (/** @type {string} */ p) => {
    await sleep(150);
    return read(p);
  };
  await a.close();
  await sleep(200); // past the read, so a record written then would show in the log
  const b = await postbox(dir);
  try {
    const turn = b.store.state.work[t.id]?.find((/** @type {any} */ e) => e.kind === 'turn');
    assert.equal(turn?.status, 'stopped', 'the turn’s end was written, not left running for the restart to call interrupted');
    assert.equal(typeof turn?.endedAt, 'number');
  } finally {
    await b.close();
  }
  assert.deepEqual(takeServerFailures(), [], 'nothing was written after the store closed');
});
