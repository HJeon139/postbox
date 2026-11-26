// #683: an older Postbox loaded a data folder a newer one wrote, couldn’t replay the event types it didn’t know, and
// started without them; its next snapshot made the loss permanent. The folder now records the version of the last
// Postbox to load it (server/store-format.mjs), and an older Postbox refuses the folder, changing nothing in it. A
// build of the same version, or a newer one, loads it as before, and a record that can’t be read only advises.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { openDataFolder } from '../server/data-folder.mjs';
import { Store } from '../server/store.mjs';
import { FORMAT_FILE } from '../server/store-format.mjs';
import { tempDir } from './temp-dirs.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const [MAJOR, MINOR, PATCH] = VERSION.split('.').map(Number);
const NEWER = `${MAJOR + 1}.0.0`;

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

test('#683 a folder this Postbox loads records its version', async () => {
  assert.equal(record(await written()), `${JSON.stringify({ version: VERSION })}\n`);
});

test('#683 a folder a newer Postbox opened is refused, naming the version to run, with every file in it unchanged', async () => {
  const dir = await written();
  recordAs(dir, `${JSON.stringify({ version: NEWER })}\n`);
  const before = filesOf(dir);
  await assert.rejects(new Store(dir).load(), (e) => {
    assert.equal(/** @type {any} */ (e).code, 'NEWER_FORMAT');
    assert.equal(
      e.message,
      `This data folder was last opened by Postbox ${NEWER}, which may have recorded what this older Postbox (${VERSION}) can’t read. Run Postbox ${NEWER} or newer on it, or start this one with --data <another folder>. Postbox left the folder as it was.`,
    );
    return true;
  });
  assert.deepEqual(filesOf(dir), before, 'byte for byte, with no lock left');
});

test('#683 a folder an older or same version opened loads with its state, and records this one', async () => {
  for (const version of ['0.1.0', VERSION]) {
    const dir = await written();
    // The same version may come with more in it, as another branch of this version would leave it.
    recordAs(dir, `${JSON.stringify({ version, from: 'another branch' })}\n`);
    const { state } = await loaded(dir);
    assert.equal(state.threads.th_1?.title, 'Kept', version);
    assert.equal(record(dir), `${JSON.stringify({ version: VERSION })}\n`, version);
  }
});

test('#683 a record cut off by a crash, or not a version, is read as none, with a warning, and the folder loads', async () => {
  for (const text of ['', '{"version":', '{"version":"next"}\n']) {
    const dir = await written();
    recordAs(dir, text);
    const { state, warned } = await loaded(dir);
    assert.equal(state.threads.th_1?.title, 'Kept', JSON.stringify(text));
    assert.ok(
      warned.some((l) => l.includes('couldn’t read which version last opened this data folder')),
      JSON.stringify(text),
    );
    assert.equal(record(dir), `${JSON.stringify({ version: VERSION })}\n`, 'recorded again');
  }
});

test('#683 a record that can’t be written is a warning, not a failed start', async () => {
  const dir = await written();
  recordAs(dir, `${JSON.stringify({ version: '0.1.0' })}\n`);
  const full = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  const io = { ...fs, open: (/** @type {string} */ p, ...rest) => (p.includes(FORMAT_FILE) ? Promise.reject(full) : fs.open(p, ...rest)) };
  const { state, warned } = await loaded(dir, { io });
  assert.equal(state.threads.th_1?.title, 'Kept');
  assert.ok(warned.some((l) => l.includes('couldn’t record its version') && l.includes('no space left on device')));
});

test('#683 a load removes the record’s temporary file a crash left behind', async () => {
  const dir = await written();
  writeFileSync(join(dir, `${FORMAT_FILE}.4242.tmp`), '{"vers');
  await loaded(dir);
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
  );
});

test('#683 a fresh start empties a folder a newer Postbox opened, as it empties any, and records this one', async () => {
  const dir = await written();
  recordAs(dir, `${JSON.stringify({ version: NEWER })}\n`);
  const store = await new Store(dir).load({ fresh: true });
  assert.equal(store.state.threads.th_1, undefined, 'emptied');
  await store.close();
  assert.equal(JSON.parse(record(dir)).version, VERSION);
});

test('#683 Postbox’s start refuses the same folder before it makes its media folder', async () => {
  const dir = await written();
  recordAs(dir, `${JSON.stringify({ version: NEWER })}\n`);
  const before = filesOf(dir);
  await assert.rejects(openDataFolder(dir), { code: 'NEWER_FORMAT' });
  assert.deepEqual(filesOf(dir), before, 'no media folder, no lock');
});

test('#683 a load that finds its own record leaves it as it is, with no write', async () => {
  const dir = await written();
  const ino = statSync(join(dir, FORMAT_FILE)).ino;
  await loaded(dir);
  assert.equal(statSync(join(dir, FORMAT_FILE)).ino, ino, 'not written again');
});

test('#683 versions compare by number, part by part: a newer minor or patch is refused, a lower one loads', async () => {
  const refused = [`${MAJOR}.${MINOR}.${PATCH + 1}`, `${MAJOR}.${MINOR + 1}.0`, `${MAJOR + 1}.0.0`];
  // Lower by number but not as text where the part has two digits: 9 is less than 50, though “9” sorts after “50”.
  const loads = [`${MAJOR}.${MINOR}.${PATCH}`, `${MAJOR - 1}.99.99`, ...(MINOR >= 10 ? [`${MAJOR}.9.0`] : [])];
  for (const version of refused) {
    const dir = await written();
    recordAs(dir, `${JSON.stringify({ version })}\n`);
    await assert.rejects(new Store(dir).load(), { code: 'NEWER_FORMAT' }, version);
  }
  for (const version of loads) {
    const dir = await written();
    recordAs(dir, `${JSON.stringify({ version })}\n`);
    assert.equal((await loaded(dir)).state.threads.th_1?.title, 'Kept', version);
  }
});
