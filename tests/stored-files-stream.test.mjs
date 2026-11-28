// #870: opening an attachment from its chip (GET /api/files/:id) streams the stored file a chunk at a time, checked
// against its hash as it goes. An upload has no fixed size since #870, and the route read the whole file into memory:
// a 1 GB file cost 1.1 GB, and past 2 GiB Node refused to read it at all (the integrator’s review of #2015). A damaged
// file is cut off before its end, never delivered whole.

import assert from 'node:assert/strict';
import { appendFileSync, rmSync } from 'node:fs';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Blobs } from '../server/blobs.mjs';
import { storedFileRoute } from '../server/stored-files.mjs';
import { tempDir } from './temp-dirs.mjs';

const MB = 1024 * 1024;
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

/** `size` bytes as 64 KB chunks, each a buffer of its own. */
async function* chunks(size) {
  for (let sent = 0; sent < size; sent += 64 * 1024) yield Buffer.alloc(Math.min(64 * 1024, size - sent), 7);
}

/** A store holding one file of `size` bytes, recorded as the upload route records it. */
async function storedFile(size) {
  const blobs = new Blobs(tempDir('pb-stored-stream-'));
  const { sha256 } = await blobs.putStream(chunks(size));
  const store = { state: { files: { fi_big: { id: 'fi_big', name: 'Screen Recording.mov', type: 'video/quicktime', size, sha256 } } } };
  return { blobs, store, sha256 };
}

/** An answer that counts what it’s sent and keeps none of it, calling `onChunk` for each chunk. */
function counting(onChunk = () => {}) {
  const res = new Writable({
    write(chunk, _enc, done) {
      res.received += chunk.length;
      onChunk();
      done();
    },
  });
  return Object.assign(res, { received: 0, status: 0, headers: {}, writeHead: (s, h) => Object.assign(res, { status: s, headers: h }) });
}

test('#870 a 100 MB stored file is sent whole, with memory held at a few chunks, not the file', async () => {
  const size = 100 * MB;
  const { blobs, store } = await storedFile(size);
  gc();
  const base = process.memoryUsage().arrayBuffers;
  let peak = base;
  let n = 0;
  const res = counting(() => {
    // From the first chunk, then every 8 MB: a file read whole arrives as one chunk.
    if (++n % 128 === 1) {
      gc();
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }
  });
  assert.equal(await storedFileRoute(store, blobs, '/api/files/fi_big', 'GET', /** @type {any} */ (res)), true);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-length'], String(size));
  assert.equal(res.received, size, 'every byte sent');
  // Read whole, as before, this would be about 100 MB.
  assert.ok(peak - base < 16 * MB, `array buffers grew by ${((peak - base) / MB).toFixed(1)} MB`);
});

test('#870 a stored file damaged on disk is cut off before its end, never sent whole', async () => {
  const size = 4 * MB;
  const { blobs, store, sha256 } = await storedFile(size);
  // One byte changed at the end, the size kept: only the hash can tell.
  const path = blobs.pathOf(sha256);
  rmSync(path);
  for await (const c of chunks(size - 1)) appendFileSync(path, c);
  appendFileSync(path, Buffer.from([8]));
  const res = counting();
  const logged = [];
  const error = console.error;
  console.error = (/** @type {any[]} */ ...a) => logged.push(a.join(' '));
  try {
    await storedFileRoute(store, blobs, '/api/files/fi_big', 'GET', /** @type {any} */ (res));
  } finally {
    console.error = error;
  }
  assert.ok(res.received < size, `${res.received} of ${size} bytes sent`);
  assert.equal(res.destroyed, true, 'the answer is cut short of its length');
  assert.match(logged.join('\n'), /stopped sending file fi_big: This file is damaged/);
});

test('#870 a stored file whose blob is gone, or of another size, refuses before anything is sent', async () => {
  const { blobs, store, sha256 } = await storedFile(MB);
  store.state.files.fi_big.size = MB + 1;
  const res = counting();
  await assert.rejects(storedFileRoute(store, blobs, '/api/files/fi_big', 'GET', /** @type {any} */ (res)), /damaged/);
  rmSync(blobs.pathOf(sha256));
  await assert.rejects(storedFileRoute(store, blobs, '/api/files/fi_big', 'GET', /** @type {any} */ (res)), /ENOENT/);
  assert.equal(res.status, 0, 'no status written');
});
