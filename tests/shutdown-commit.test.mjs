// A planned restart loses nothing (designs/architecture/live-progress.md, “A restart mid-turn”): a reply stopped by a
// graceful shutdown keeps every word it had said, and its turn’s ledger record is written before the store closes, even
// when a read it waits on answers after the ledger’s grace. Both through the real start() and close(), on one folder.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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

/** A promise the test resolves, and its resolver. */
function gate() {
  /** @type {() => void} */
  let open = () => {};
  const shut = new Promise((r) => {
    open = () => r(undefined);
  });
  return { shut, open };
}

/** The turn’s ledger entries in `t`, after Postbox starts again on `dir`. @param {string} dir @param {any} t */
async function workAfterRestart(dir, t) {
  const b = await postbox(dir);
  try {
    return b.store.state.work[t.id] ?? [];
  } finally {
    await b.close();
  }
}

test('a turn’s ledger end that waits past the grace on a read is written before the store closes, and the read keeps nothing', async () => {
  const dir = tempDir('pb-shutdown-ledger-');
  const file = `${dir}/notes.txt`;
  const a = await postbox(dir, (emit) => {
    emit({ kind: 'tool_call', id: 'e1', name: 'Write', input: { file_path: file, content: 'x' }, final: true });
    writeFileSync(file, 'x'); // the agent’s write, so the read after has something to copy
    emit({ kind: 'tool_result', id: 'e1', text: 'ok' });
  });
  arrange.withDelays(a.rt, { ledgerGraceMs: 30 });
  const t = await running(a, dir);
  await a.rt.ledger.idle(); // the file’s copy before, read as the call started
  // A read of the file the turn changed that answers only after close(), as a slow disk’s does.
  const late = gate();
  const read = a.rt.ledger.io.read;
  a.rt.ledger.io.read = async (/** @type {string} */ p) => {
    await late.shut;
    return read(p);
  };
  let kept = 0;
  const put = a.rt.ledger.blobs.put.bind(a.rt.ledger.blobs);
  a.rt.ledger.blobs.put = (/** @type {Buffer} */ b) => {
    kept++;
    return put(b);
  };
  await a.close();
  late.open();
  await a.rt.ledger.idle(); // the read answered, and its turn’s end saw it had been written
  assert.equal(kept, 0, 'nothing was copied after the ledger closed');
  const work = await workAfterRestart(dir, t);
  const turn = work.find((/** @type {any} */ e) => e.kind === 'turn');
  assert.equal(turn?.status, 'stopped', 'the turn’s end was written, not left running for the restart to call interrupted');
  assert.equal(typeof turn?.endedAt, 'number');
  assert.equal(work.filter((/** @type {any} */ e) => e.kind === 'file').length, 0, 'the change still being read isn’t recorded');
  assert.deepEqual(takeServerFailures(), [], 'nothing was written after the store closed');
});

test('a command’s result the ledger is still recording at close is dropped once it has closed, not written to the closed store', async () => {
  const dir = tempDir('pb-shutdown-command-');
  const late = gate();
  const a = await postbox(dir, (emit) => {
    emit({ kind: 'text', text: 'Running it.' });
    emit({ kind: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'echo hi' }, final: true });
    emit({ kind: 'tool_result', id: 'c1', text: 'hi' });
  });
  arrange.withDelays(a.rt, { ledgerGraceMs: 30 });
  // The command’s output is kept only after close(): its result is in flight as the ledger closes.
  const put = a.rt.ledger.blobs.put.bind(a.rt.ledger.blobs);
  a.rt.ledger.blobs.put = async (/** @type {Buffer} */ b) => {
    await late.shut;
    return put(b);
  };
  const t = await running(a, dir);
  await a.close();
  late.open();
  await a.rt.ledger.idle();
  const b = await postbox(dir);
  try {
    const work = b.store.state.work[t.id] ?? [];
    assert.equal(work.find((/** @type {any} */ e) => e.kind === 'command')?.state, 'stopped', 'as its turn’s end wrote it');
    assert.equal(work.find((/** @type {any} */ e) => e.kind === 'turn')?.status, 'stopped');
    const reply = b.store.state.items[t.id].find((/** @type {any} */ i) => i.kind === 'agent');
    assert.equal(reply?.work, '1 command', 'the reply’s line of its work, written with the end');
  } finally {
    await b.close();
  }
  assert.deepEqual(takeServerFailures(), [], 'its late result wasn’t written to the closed store');
});

test('a background command’s output still being read at close isn’t kept once the ledger has closed', async () => {
  const dir = tempDir('pb-shutdown-output-');
  const out = `${dir}/job.out`;
  writeFileSync(out, 'job output');
  const a = await postbox(dir, (emit) => {
    emit({ kind: 'tool_call', id: 'j1', name: 'Bash', input: { command: 'sleep 9', run_in_background: true }, final: true });
    emit({ kind: 'tool_result', id: 'j1', text: 'started', result: { backgroundTaskId: 'b1' } });
    emit({ kind: 'tool_end', id: 'j1', status: 'completed', summary: 'exit code 0', outputFile: out });
  });
  arrange.withDelays(a.rt, { ledgerGraceMs: 30 });
  // The job’s output file answers only after close(): its end is in flight as the ledger closes.
  const late = gate();
  const reading = gate();
  const tail = a.rt.ledger.io.readTail;
  a.rt.ledger.io.readTail = async (/** @type {string} */ p, /** @type {number} */ n) => {
    reading.open();
    await late.shut;
    return tail(p, n);
  };
  let kept = 0;
  const put = a.rt.ledger.blobs.put.bind(a.rt.ledger.blobs);
  a.rt.ledger.blobs.put = (/** @type {Buffer} */ b) => {
    kept++;
    return put(b);
  };
  await running(a, dir);
  await reading.shut; // the job’s end is reading its output
  const before = kept;
  await a.close();
  late.open();
  await a.rt.ledger.idle();
  assert.equal(kept, before, 'the output read after close isn’t copied');
  const b = await postbox(dir);
  await b.close();
  assert.deepEqual(takeServerFailures(), []);
});

test('a turn’s end that throws as the ledger closes is logged, and the store still closes and releases the folder', async () => {
  const dir = tempDir('pb-shutdown-throws-');
  const file = `${dir}/notes.txt`;
  const a = await postbox(dir, (emit) => {
    emit({ kind: 'tool_call', id: 'e1', name: 'Write', input: { file_path: file, content: 'x' }, final: true });
    emit({ kind: 'tool_result', id: 'e1', text: 'ok' });
  });
  arrange.withDelays(a.rt, { ledgerGraceMs: 30 });
  await running(a, dir);
  await a.rt.ledger.idle();
  const late = gate();
  a.rt.ledger.io.read = async () => {
    await late.shut;
    return { exists: false };
  };
  const patch = a.rt.ledger.patch.bind(a.rt.ledger);
  a.rt.ledger.patch = (/** @type {string} */ convId, /** @type {string} */ id, /** @type {any} */ change) => {
    if (change.status === 'stopped') throw new Error('the entry can’t be patched');
    return patch(convId, id, change);
  };
  await a.close();
  late.open();
  await a.rt.ledger.idle();
  const logged = takeServerFailures();
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0], /couldn’t record a turn’s end as Postbox shut down: the entry can’t be patched/);
  const b = await postbox(dir); // the folder was released
  await b.close();
  assert.deepEqual(takeServerFailures(), []);
});
