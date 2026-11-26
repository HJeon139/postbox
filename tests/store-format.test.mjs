// #683: an older Postbox loaded a data folder a newer one wrote, couldn’t replay the event types it didn’t know, and
// started without them; its next snapshot made the loss permanent. The folder now records the event types the last
// Postbox to load it knows, with its version (server/store-format.mjs), and a Postbox that finds one it doesn’t know
// refuses the folder, changing nothing in it.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDataFolder } from '../server/data-folder.mjs';
import { Store } from '../server/store.mjs';
import { FORMAT_FILE } from '../server/store-format.mjs';
import { EVENTS } from '../shared/state.mjs';
import { tempDir } from './temp-dirs.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

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

/** A folder this Postbox has written to and closed: a conversation in its log, and its format record. */
async function written() {
  const dir = tempDir('pb-format-');
  const store = await new Store(dir).load();
  store.emit('thread', { id: 'th_1', title: 'Kept', members: [] });
  await store.close();
  return dir;
}

test('#683 a folder this Postbox loads records its version and every event type it knows', async () => {
  const dir = await written();
  const rec = JSON.parse(readFileSync(join(dir, FORMAT_FILE), 'utf8'));
  assert.equal(rec.version, VERSION);
  assert.deepEqual(rec.events, Object.keys(EVENTS).sort());
});

test('#683 a folder a newer Postbox wrote is refused, naming the version to run, with every file in it unchanged', async () => {
  const dir = await written();
  // As a newer Postbox would leave it: one event type this one doesn’t know.
  writeFileSync(join(dir, FORMAT_FILE), `${JSON.stringify({ version: '99.1.0', events: [...Object.keys(EVENTS), 'future.thing'].sort() })}\n`);
  const before = filesOf(dir);
  await assert.rejects(new Store(dir).load(), (e) => {
    assert.equal(/** @type {any} */ (e).code, 'NEWER_FORMAT');
    assert.match(
      e.message,
      /last opened by Postbox 99\.1\.0, which records a kind of event this Postbox \(.+\) can’t read: future\.thing\. Run Postbox 99\.1\.0 or newer on it\. Nothing in the folder was changed\./,
    );
    return true;
  });
  assert.deepEqual(filesOf(dir), before, 'byte for byte, with no lock left');
});

test('#683 a folder an older Postbox recorded loads, keeps its state, and records this one', async () => {
  const dir = await written();
  writeFileSync(join(dir, FORMAT_FILE), `${JSON.stringify({ version: '0.1.0', events: ['thread'] })}\n`);
  const store = await new Store(dir).load();
  assert.equal(store.state.threads.th_1?.title, 'Kept');
  await store.close();
  assert.equal(JSON.parse(readFileSync(join(dir, FORMAT_FILE), 'utf8')).version, VERSION);
});

test('#683 a fresh start empties a folder a newer Postbox wrote, as it empties any, and records this one', async () => {
  const dir = await written();
  writeFileSync(join(dir, FORMAT_FILE), `${JSON.stringify({ version: '99.1.0', events: ['future.thing'] })}\n`);
  const store = await new Store(dir).load({ fresh: true });
  assert.equal(store.state.threads.th_1, undefined, 'emptied');
  await store.close();
  assert.equal(JSON.parse(readFileSync(join(dir, FORMAT_FILE), 'utf8')).version, VERSION);
});

test('#683 Postbox’s start refuses the same folder before it makes its media folder', async () => {
  const dir = await written();
  writeFileSync(join(dir, FORMAT_FILE), `${JSON.stringify({ version: '99.1.0', events: ['future.thing'] })}\n`);
  const before = filesOf(dir);
  await assert.rejects(openDataFolder(dir), { code: 'NEWER_FORMAT' });
  assert.deepEqual(filesOf(dir), before, 'no media folder, no lock');
});

test('#683 a load that finds its own record leaves it as it is, with no write', async () => {
  const dir = await written();
  const ino = statSync(join(dir, FORMAT_FILE)).ino;
  const store = await new Store(dir).load();
  await store.close();
  assert.equal(statSync(join(dir, FORMAT_FILE)).ino, ino, 'not written again');
});
