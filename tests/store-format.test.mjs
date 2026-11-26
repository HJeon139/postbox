// #683: an older Postbox loaded a data folder a newer one wrote, couldn’t replay the event types it didn’t know, and
// started without them; its next snapshot made the loss permanent. The folder now records the data format of the last
// Postbox to load it, with its version (server/store-format.mjs), and a Postbox whose format is older refuses the
// folder, changing nothing in it. The format goes up only when an older Postbox can’t replay what a newer one keeps, so
// a release that doesn’t, which is most of them, opens the folder its newer sibling did (the owner’s decision on #1803).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { openDataFolder } from '../server/data-folder.mjs';
import { Store } from '../server/store.mjs';
import { DATA_FORMAT, FORMAT_FILE } from '../server/store-format.mjs';
import { EVENTS } from '../shared/state.mjs';
import { tempDir } from './temp-dirs.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
/** What this Postbox records. */
const OURS = `${JSON.stringify({ format: DATA_FORMAT, version: VERSION })}\n`;
/** A record a Postbox of the next format would leave. */
const NEWER = `${JSON.stringify({ format: DATA_FORMAT + 1, version: '99.0.0' })}\n`;

/** Every file in the folder, by name, with a hash of its bytes. @param {string} dir */
const filesOf = (dir) =>
  Object.fromEntries(
    readdirSync(dir).map((n) => [
      n,
      createHash('sha256')
        .update(readFileSync(join(dir, n)))
        .digest('hex'),
    ]),
  );
const record = (dir) => readFileSync(join(dir, FORMAT_FILE), 'utf8');
const recordAs = (dir, text) => writeFileSync(join(dir, FORMAT_FILE), text);

/** A folder this Postbox has written to and closed: a conversation in its log, and its format record. */
async function written() {
  const dir = tempDir('pb-format-');
  const store = await new Store(dir).load();
  store.emit('thread', { id: 'th_1', title: 'Kept', members: [] });
  await store.close();
  return dir;
}

/** Loads the folder, with the warnings it printed. @param {string} dir @param {any} [opts] */
async function loaded(dir, opts) {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const store = await new Store(dir, opts).load();
    const state = store.state;
    await store.close();
    return { state, warned: warn.mock.calls.map((c) => String(c.arguments[0])) };
  } finally {
    warn.mock.restore();
  }
}

test('#683 a folder this Postbox loads records its data format and version', async () => {
  assert.equal(record(await written()), OURS);
});

/**
 * Each released format’s list, by the SHA-256 of the list as JSON, in its order, which is sorted. Never change a released
 * format’s list: a new event type goes in the next format’s, with DATA_FORMAT raised, and its hash added here.
 */
const RELEASED = { 1: 'f14fcd144b66da406cd71342390e7b4a8f62c117de85275135930ca25767343f' };

test('#683 DATA_FORMAT goes up with the event types: every type in EVENTS is in the newest format’s list', () => {
  const formats = JSON.parse(readFileSync(new URL('./store-format-events.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    Object.keys(formats).map(Number),
    Array.from({ length: DATA_FORMAT }, (_, i) => i + 1),
    'one list for each format up to DATA_FORMAT',
  );
  // A type EVENTS adds, which an older Postbox can’t replay: the next format’s list, and DATA_FORMAT raised. A type it
  // drops needs nothing: an older Postbox still replays what a newer one logs.
  const missing = Object.keys(EVENTS).filter((t) => !formats[DATA_FORMAT].includes(t));
  assert.deepEqual(missing, [], 'EVENTS gained a type with DATA_FORMAT where it was');
  assert.deepEqual(Object.keys(RELEASED), Object.keys(formats), 'every format’s list is pinned');
  for (const [f, hash] of Object.entries(RELEASED))
    assert.equal(createHash('sha256').update(JSON.stringify(formats[f])).digest('hex'), hash, `format ${f}’s list changed after it was released`);
});

test('#683 a folder a newer format opened is refused, naming the version to run, with every file in it unchanged', async () => {
  const dir = await written();
  recordAs(dir, NEWER);
  // A lock a crashed Postbox left stays too: the refusal comes before the lock, which would take a stale one over.
  writeFileSync(join(dir, 'store.lock'), JSON.stringify({ pid: 2147483646, started: 1, token: 'stale' }));
  const before = filesOf(dir);
  await assert.rejects(new Store(dir).load(), (e) => {
    assert.equal(/** @type {any} */ (e).code, 'NEWER_FORMAT');
    assert.equal(
      e.message,
      `This data folder was last opened by Postbox 99.0.0, which keeps what this older Postbox (${VERSION}) can’t read. Run Postbox 99.0.0 or newer on it, or start this one with --data <another folder>. Postbox left the folder as it was.`,
    );
    return true;
  });
  assert.deepEqual(filesOf(dir), before, 'byte for byte, the stale lock included');
});

test('#683 a newer format that opened the folder between the first read and the lock is refused under it, and the lock released', async () => {
  const dir = await written();
  let reads = 0;
  const readFile = (/** @type {any} */ p, /** @type {any[]} */ ...rest) =>
    String(p).endsWith(FORMAT_FILE) && ++reads === 2 ? Promise.resolve(NEWER) : fs.readFile(p, ...rest);
  await assert.rejects(new Store(dir, { io: { ...fs, readFile } }).load(), { code: 'NEWER_FORMAT' });
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.includes('lock')),
    [],
    'no lock left',
  );
});

test('#683 a folder of the same or an older format loads with its state and records this one, whatever version wrote it', async () => {
  const records = [
    // This format, by a newer release that added nothing an older one can’t read: most releases.
    { format: DATA_FORMAT, version: '99.0.0' },
    { format: DATA_FORMAT, version: '0.1.0' },
    // #683’s first head recorded only a version: that’s format 1.
    { version: '99.0.0' },
    { version: '0.1.0' },
  ];
  for (const rec of records) {
    const dir = await written();
    recordAs(dir, `${JSON.stringify(rec)}\n`);
    const { state, warned } = await loaded(dir);
    assert.equal(state.threads.th_1?.title, 'Kept', JSON.stringify(rec));
    assert.deepEqual(warned, [], JSON.stringify(rec));
    assert.equal(record(dir), OURS, JSON.stringify(rec));
  }
});

test('#683 a folder with no record, as every folder is before its first load since #683, loads with no warning and is recorded', async () => {
  const dir = await written();
  await fs.rm(join(dir, FORMAT_FILE));
  const { state, warned } = await loaded(dir);
  assert.equal(state.threads.th_1?.title, 'Kept');
  assert.deepEqual(warned, []);
  assert.equal(record(dir), OURS);
});

test('#683 a record cut off by a crash, or naming no format, is read as none, with one warning, and the folder loads', async () => {
  for (const text of ['', '{"format":', '{"format":"next"}\n', '{"format":"2"}\n', '{"format":0}\n', '{"format":2.5}\n', 'null\n', '[]\n']) {
    const dir = await written();
    recordAs(dir, text);
    const { state, warned } = await loaded(dir);
    assert.equal(state.threads.th_1?.title, 'Kept', JSON.stringify(text));
    assert.equal(warned.filter((l) => l.includes('couldn’t read which data format this folder holds')).length, 1, `${JSON.stringify(text)}: warned once`);
    assert.equal(record(dir), OURS, 'recorded again');
  }
});

test('#683 a record that can’t be written is a warning, not a failed start', async () => {
  const dir = await written();
  recordAs(dir, `${JSON.stringify({ version: '0.1.0' })}\n`);
  const full = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  const io = { ...fs, open: (/** @type {string} */ p, ...rest) => (p.includes(FORMAT_FILE) ? Promise.reject(full) : fs.open(p, ...rest)) };
  const { state, warned } = await loaded(dir, { io });
  assert.equal(state.threads.th_1?.title, 'Kept');
  assert.ok(warned.some((l) => l.includes('couldn’t record its data format') && l.includes('no space left on device')));
});

test('#683 a load removes the record’s temporary file a crash left behind', async () => {
  const dir = await written();
  writeFileSync(join(dir, `${FORMAT_FILE}.4242.tmp`), '{"form');
  await loaded(dir);
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
  );
});

test('#683 a fresh start empties a folder a newer format opened, as it empties any, and records this one', async () => {
  const dir = await written();
  recordAs(dir, NEWER);
  const store = await new Store(dir).load({ fresh: true });
  assert.equal(store.state.threads.th_1, undefined, 'emptied');
  await store.close();
  assert.equal(record(dir), OURS);
});

test('#683 Postbox’s start refuses the same folder before it makes its media folder', async () => {
  const dir = await written();
  recordAs(dir, NEWER);
  const before = filesOf(dir);
  await assert.rejects(openDataFolder(dir), { code: 'NEWER_FORMAT' });
  assert.deepEqual(filesOf(dir), before, 'no media folder, no lock');
});

test('#683 the command prints the refusal alone, with no stack, and exits 1', async () => {
  const dir = await written();
  recordAs(dir, NEWER);
  const { main } = await import('../bin/postbox.mjs');
  const said = mock.method(console, 'error', () => {});
  const exit = mock.method(process, 'exit', (/** @type {number} */ code) => {
    throw new Error(`exit ${code}`);
  });
  try {
    await assert.rejects(
      main(['--port', '4599', '--data', dir], (/** @type {any} */ o) => new Store(o.dataDir).load()),
      /^Error: exit 1$/,
    );
    assert.equal(said.mock.calls.length, 1);
    assert.match(String(said.mock.calls[0].arguments[0]), /^This data folder was last opened by Postbox 99\.0\.0, .* left the folder as it was\.$/);
  } finally {
    exit.mock.restore();
    said.mock.restore();
    process.removeAllListeners('unhandledRejection');
  }
});

test('#683 a load that finds its own record leaves it as it is, with no write', async () => {
  const dir = await written();
  const ino = statSync(join(dir, FORMAT_FILE)).ino;
  await loaded(dir);
  assert.equal(statSync(join(dir, FORMAT_FILE)).ino, ino, 'not written again');
});

test('#683 a newer format’s record with no version names no version, and still refuses', async () => {
  const dir = await written();
  recordAs(dir, `${JSON.stringify({ format: DATA_FORMAT + 1 })}\n`);
  await assert.rejects(new Store(dir).load(), (e) => {
    assert.equal(
      e.message,
      `This data folder was last opened by a newer Postbox, which keeps what this older Postbox (${VERSION}) can’t read. Run a newer Postbox on it, or start this one with --data <another folder>. Postbox left the folder as it was.`,
    );
    return true;
  });
});
