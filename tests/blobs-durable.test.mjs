// The blob store publishes a file whole or not at all, and keeps it private (#305; critic's design-time review of the
// archive pass, conditions 1 and 2): archive files and file copies can hold command lines and output with secrets.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Blobs } from '../server/blobs.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-blobs-'));
const sha = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex');

test('a truncated file left under a blob’s name, as a crash mid-write leaves it, is replaced by the next put', async () => {
  const dir = await tmp();
  try {
    const bytes = Buffer.from('the whole archive file, every byte of it');
    const blobs = new Blobs(dir);
    const h = sha(bytes);
    await mkdir(join(dir, h.slice(0, 2)), { recursive: true });
    await writeFile(join(dir, h.slice(0, 2), h.slice(2)), bytes.subarray(0, 9));
    await blobs.put(bytes);
    assert.deepEqual(await blobs.get(h), bytes, 'the next read gets the whole file, not “damaged” forever');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a put leaves no draft behind, and nothing under the final name until it is whole', async () => {
  const dir = await tmp();
  try {
    const bytes = Buffer.alloc(1 << 20, 7);
    await new Blobs(dir).put(bytes);
    const h = sha(bytes);
    assert.deepEqual(await readdir(join(dir, h.slice(0, 2))), [h.slice(2)], 'only the published file, no draft');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a blob is readable by its owner only, in a folder only its owner can open', async () => {
  const dir = await tmp();
  try {
    const bytes = Buffer.from('npm publish --otp 123456');
    const { path } = await new Blobs(dir).put(bytes);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, sha(bytes).slice(0, 2)))).mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a folder sync that fails with EIO makes the put reject, so nothing can name a blob that isn’t durable', async () => {
  const dir = await tmp();
  try {
    /** @type {any} */
    const failingFolderSync = async (/** @type {string} */ path, /** @type {any} */ flags, /** @type {any} */ mode) => {
      const fh = await open(path, flags, mode);
      if (flags !== 'r') return fh;
      return Object.assign(Object.create(fh), {
        sync: async () => {
          throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
        },
        close: () => fh.close(),
      });
    };
    await assert.rejects(new Blobs(dir, { open: failingFolderSync }).put(Buffer.from('an archive file')), (e) => e instanceof Error && /EIO/.test(e.message));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a folder sync a platform doesn’t support (EINVAL) doesn’t fail the put', async () => {
  const dir = await tmp();
  try {
    /** @type {any} */
    const unsupported = async (/** @type {string} */ path, /** @type {any} */ flags, /** @type {any} */ mode) => {
      const fh = await open(path, flags, mode);
      if (flags !== 'r') return fh;
      return Object.assign(Object.create(fh), {
        sync: async () => {
          throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
        },
        close: () => fh.close(),
      });
    };
    const { sha256 } = await new Blobs(dir, { open: unsupported }).put(Buffer.from('still stored'));
    assert.equal(sha256.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a put that fails while writing its draft removes the draft, so repeated failures leave none (ENOSPC)', async () => {
  const dir = await tmp();
  try {
    /** @type {any} */
    const full = async (/** @type {string} */ path, /** @type {any} */ flags, /** @type {any} */ mode) => {
      const fh = await open(path, flags, mode);
      if (flags !== 'wx') return fh;
      return Object.assign(Object.create(fh), {
        writeFile: async () => {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        },
        close: () => fh.close(),
      });
    };
    const blobs = new Blobs(dir, { open: full });
    for (let i = 0; i < 3; i++) await assert.rejects(blobs.put(Buffer.from('an archive file')), /ENOSPC/);
    const left = (await readdir(dir, { recursive: true })).filter((f) => String(f).endsWith('.draft'));
    assert.deepEqual(left, [], 'no draft files');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a put of bytes already on disk still syncs the folder, so a blob named by an event is durable (the fast path)', async () => {
  const dir = await tmp();
  try {
    const bytes = Buffer.from('an archive file');
    // First put: the rename lands, the folder sync fails with EIO, so the put rejects.
    let failSync = true;
    /** @type {any} */
    const flaky = async (/** @type {string} */ path, /** @type {any} */ flags, /** @type {any} */ mode) => {
      const fh = await open(path, flags, mode);
      if (flags !== 'r') return fh;
      return Object.assign(Object.create(fh), {
        sync: async () => {
          if (failSync) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
        },
        close: () => fh.close(),
      });
    };
    const blobs = new Blobs(dir, { open: flaky });
    await assert.rejects(blobs.put(bytes), /EIO/);
    // Second put: the file is there, but nobody has synced its folder. The folder sync fails again: the put must too.
    await assert.rejects(blobs.put(bytes), /EIO/, 'the fast path may not return a blob whose folder was never synced');
    failSync = false;
    await blobs.put(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A seam whose draft handle fails at `step` (`sync` or `close`) after really writing. */
const failingAt = (/** @type {'sync' | 'close'} */ step) => async (/** @type {string} */ path, /** @type {any} */ flags, /** @type {any} */ mode) => {
  const fh = await open(path, flags, mode);
  if (flags !== 'wx') return fh;
  return Object.assign(Object.create(fh), {
    writeFile: (/** @type {any} */ b) => fh.writeFile(b),
    sync: async () => {
      if (step === 'sync') throw Object.assign(new Error('EIO: draft sync failed'), { code: 'EIO' });
      return fh.sync();
    },
    close: async () => {
      await fh.close();
      if (step === 'close') throw Object.assign(new Error('EIO: draft close failed'), { code: 'EIO' });
    },
  });
};

for (const step of /** @type {const} */ (['sync', 'close']))
  test(`a put whose draft fails at its ${step} removes the draft`, async () => {
    const dir = await tmp();
    try {
      const blobs = new Blobs(dir, { open: failingAt(step) });
      await assert.rejects(blobs.put(Buffer.from('an archive file')), /EIO/);
      const left = (await readdir(dir, { recursive: true })).filter((f) => String(f).endsWith('.draft'));
      assert.deepEqual(left, [], 'no draft files');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test('a put whose rename fails (a folder under the blob’s name) removes the draft', async () => {
  const dir = await tmp();
  try {
    const bytes = Buffer.from('an archive file');
    const hash = sha(bytes);
    await mkdir(join(dir, hash.slice(0, 2), hash.slice(2)), { recursive: true });
    await assert.rejects(new Blobs(dir).put(bytes));
    const left = (await readdir(dir, { recursive: true })).filter((f) => String(f).endsWith('.draft'));
    assert.deepEqual(left, [], 'no draft files');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
