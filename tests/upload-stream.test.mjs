// #870: an upload has no fixed size limit beyond free disk space (the person’s choice, 6 November 2026). The route
// streams the body into the blob store, hashed as it’s written to a draft and renamed into place, so memory stays at a
// chunk whatever the size, and an upload that would leave the disk nearly full is refused with its reason and leaves
// nothing behind. Before, the route held the body in memory twice and answered 413 past 25 MB.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Blobs } from '../server/blobs.mjs';
import { DISK_RESERVE, upload } from '../server/upload.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4879;
const MB = 1024 * 1024;
let app;
let cookie;
before(async () => {
  const dir = tempDir('pb-upload-stream-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  const page = await fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, path: '/', headers: NAVIGATION });
  cookie = page.headers['set-cookie'].split(';')[0];
});
after(async () => {
  await app.close();
});

/** `size` bytes as 64 KB chunks, each a buffer of its own, as a socket gives them. */
async function* chunks(size, onChunk = () => {}) {
  const step = 64 * 1024;
  for (let sent = 0; sent < size; sent += step) {
    onChunk();
    yield Buffer.alloc(Math.min(step, size - sent), 7);
  }
}

/** The same bytes’ SHA-256, hashed as they’re made. */
function shaOf(size) {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(64 * 1024, 7);
  for (let sent = 0; sent < size; sent += chunk.length) hash.update(sent + chunk.length > size ? chunk.subarray(0, size - sent) : chunk);
  return hash.digest('hex');
}

const post = (stream, size) =>
  fakeRequest(app.handle, {
    method: 'POST',
    path: '/api/files',
    host: `127.0.0.1:${PORT}`,
    cookie,
    headers: { 'x-filename': 'Screen%20Recording.mov', 'content-type': 'video/quicktime', 'content-length': String(size) },
    stream,
  });

/** Every file under a folder, drafts included. @param {string} dir */
const filesIn = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());

test('#870 a 40 MB screen recording is attached: stored whole under its hash, past the old 25 MB limit', async () => {
  const size = 40 * MB;
  const r = await post(chunks(size), size);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.size, size);
  assert.equal(r.json.name, 'Screen Recording.mov');
  assert.equal(r.json.sha256, shaOf(size));
  assert.equal(statSync(app.rt.blobs.pathOf(r.json.sha256)).size, size);
  assert.deepEqual(
    filesIn(app.rt.blobs.dir).filter((e) => e.name.endsWith('.draft')),
    [],
    'no draft left',
  );
});

/** A full garbage collection, so what’s measured is what’s held, not chunks already let go and not yet collected. */
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

test('#870 memory stays bounded while a 200 MB upload streams in, not about twice the file', async () => {
  const size = 200 * MB;
  gc();
  const base = process.memoryUsage().arrayBuffers;
  let peak = base;
  let n = 0;
  const held = () => {
    gc();
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
  };
  // Every 8 MB sent: a collection, then what the route still holds.
  const r = await post(
    chunks(size, () => {
      if (++n % 128 === 0) held();
    }),
    size,
  );
  held();
  assert.equal(r.status, 201, r.text);
  // Held whole and copied once more, as before, this would be about 400 MB.
  assert.ok(peak - base < 32 * MB, `array buffers grew by ${((peak - base) / MB).toFixed(1)} MB`);
});

/** A disk with `free` bytes left, as statfs reports it, and `later` once `after` calls have been made. */
const disk = (free, { after = Infinity, later = free } = {}) => {
  let calls = 0;
  return async () => ({ bsize: 4096, bavail: Math.floor((calls++ < after ? free : later) / 4096) });
};

/** The route’s upload over a store of its own, so a refusal’s leftovers can be counted. */
async function uploadTo(size, statfs, io) {
  const dir = tempDir('pb-upload-disk-');
  const blobs = new Blobs(dir, io);
  const emitted = [];
  const req = Object.assign(chunks(size), { headers: { 'x-filename': 'big.mov', 'content-length': String(size) } });
  const result = await upload(/** @type {any} */ (req), { blobs, store: { emit: (...e) => emitted.push(e) }, statfs }).catch((e) => e);
  return { result, dir, emitted };
}

test('#870 an upload that would leave the disk nearly full is refused before it’s written, with its reason', async () => {
  // 64 MB declared with 40 MB to spare: only the declared size shows it won’t fit, before anything is written.
  const { result, dir, emitted } = await uploadTo(64 * MB, disk(DISK_RESERVE + 40 * MB));
  assert.equal(result.status, 507);
  assert.match(result.message, /disk/);
  assert.match(result.message, /Free some space/);
  assert.deepEqual(filesIn(dir), [], 'nothing written');
  assert.deepEqual(emitted, [], 'no file recorded');
});

test('#870 a disk that fills while an upload streams in refuses the rest, and the draft is removed', async () => {
  const size = 48 * MB;
  const { result, dir, emitted } = await uploadTo(size, disk(10 * DISK_RESERVE, { after: 1, later: DISK_RESERVE + MB }));
  assert.equal(result.status, 507, String(result));
  assert.deepEqual(filesIn(dir), [], 'no draft or blob left');
  assert.deepEqual(emitted, []);
});

test('#870 a write the disk refuses (ENOSPC) is the same refusal, and leaves nothing', async () => {
  const { open } = await import('node:fs/promises');
  const io = {
    open: async (/** @type {string} */ path, /** @type {any[]} */ ...rest) => {
      const fh = await open(path, ...rest);
      if (!path.endsWith('.draft')) return fh;
      return Object.assign(Object.create(fh), {
        write: async () => {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        },
        sync: () => fh.sync(),
        close: () => fh.close(),
      });
    },
  };
  const { result, dir } = await uploadTo(2 * MB, disk(10 * DISK_RESERVE), io);
  assert.equal(result.status, 507, String(result));
  assert.deepEqual(filesIn(dir), []);
});

test('#870 a refused upload is read to its end and dropped, not destroyed, so the page gets the refusal', async () => {
  const size = 64 * MB;
  const req = Object.assign(Readable.from(chunks(size)), { headers: { 'x-filename': 'big.mov', 'content-length': String(size) } });
  const blobs = new Blobs(tempDir('pb-upload-drain-'));
  const result = await upload(/** @type {any} */ (req), { blobs, store: { emit: () => {} }, statfs: disk(DISK_RESERVE) }).catch((e) => e);
  assert.equal(result.status, 507);
  assert.equal(req.destroyed && !req.readableEnded, false, 'not destroyed mid-body');
  // Node’s server reads a paused request no further, and the page waits on it: a browser probe of the old route showed
  // “uploading…” still after 60 s, kept open but not resumed, and the refusal within a second once resumed.
  assert.equal(req.readableFlowing, true, 'resumed, so the rest is read');
  await once(req, 'end');
  assert.equal(req.readableEnded, true, 'the rest of the body is read and dropped');
});
