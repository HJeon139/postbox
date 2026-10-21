// Content-addressed file storage for attachments. A file is stored once, under the SHA-256 of its bytes,
// and the event log keeps only its metadata. See designs/architecture.md, “Attachments”.

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class Blobs {
  constructor(dir) {
    this.dir = dir;
  }

  pathOf(sha256) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Not a SHA-256 hash.');
    return join(this.dir, sha256.slice(0, 2), sha256.slice(2));
  }

  /** Stores bytes and returns { sha256, size, path }. Storing the same bytes twice keeps one copy. */
  async put(buffer) {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const path = this.pathOf(sha256);
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await mkdir(join(this.dir, sha256.slice(0, 2)), { recursive: true });
      await writeFile(path, buffer, { flag: 'wx' }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
    }
    return { sha256, size: buffer.length, path };
  }

  /** Reads bytes back and checks they still match their hash. */
  async get(sha256) {
    const buf = await readFile(this.pathOf(sha256));
    if (createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error('This file is damaged: its contents no longer match its hash.');
    return buf;
  }
}

/** Only these are shown inline; everything else downloads. */
export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
