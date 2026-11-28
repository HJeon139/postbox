// The person’s upload of an attachment (POST /api/files). Moved from server/index.mjs.
//
// No fixed size limit beyond free disk space (#870, the person’s choice of 6 November 2026): the body streams into
// the blob store (Blobs.putStream), so memory stays at a chunk whatever the size. Only the page can upload, with its
// token, so the disk used is the person’s own files. An upload that would leave less than DISK_RESERVE free is refused
// with that reason, before it’s written when the browser says its size, or as soon as the disk fills while it streams.

import { statfs as fsStatfs } from 'node:fs/promises';
import { httpError } from './helpers.mjs';
import { decodePath } from './served-files.mjs';
import { newId } from './store.mjs';
import { uploadName } from './upload-name.mjs';

/** The free disk space an upload leaves untouched, in bytes, so the event log and other writes still have room. */
export const DISK_RESERVE = 1024 ** 3;
/** How often free space is read again while an upload streams in, in bytes written. */
const RECHECK_BYTES = 16 * 1024 * 1024;

const NO_ROOM = () => httpError(507, 'There isn’t room on this computer’s disk for this file: Postbox keeps 1 GB free. Free some space, then attach it again.');

/**
 * POST /api/files: the person’s upload, streamed into the blob store, and its metadata emitted as a file.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ blobs: import('./blobs.mjs').Blobs, store: any, statfs?: (path: string) => Promise<{ bsize: number, bavail: number }> }} ctx
 */
export async function upload(req, { blobs, store, statfs = fsStatfs }) {
  const name = uploadName(decodePath(String(req.headers['x-filename'] ?? 'file')));
  const declared = Number(req.headers['content-length']) || 0;
  let checkedAt = -Infinity;
  // Before the first chunk, the whole declared size must fit; after it, what’s still to come.
  const check = async (/** @type {number} */ size) => {
    if (size - checkedAt < RECHECK_BYTES) return;
    checkedAt = size;
    const { bsize, bavail } = await statfs(blobs.dir);
    if (bsize * bavail - Math.max(declared - size, RECHECK_BYTES) < DISK_RESERVE) throw NO_ROOM();
  };
  // A refusal must still reach the page: ending the loop destroys the request by default, and the browser, still
  // sending, never read the answer (a 413 on a 30 MB file left “uploading…” showing). So the loop leaves the request
  // open, and a refused one is read to its end and dropped.
  const body = req.iterator?.({ destroyOnReturn: false }) ?? req;
  const { sha256, size } = await blobs.putStream(body, { check }).catch((e) => {
    req.resume?.();
    throw e?.code === 'ENOSPC' ? NO_ROOM() : e;
  });
  const id = newId('fi');
  const f = {
    id,
    name,
    size,
    type: String(req.headers['content-type'] ?? 'application/octet-stream')
      .split(';')[0]
      .trim()
      .slice(0, 100),
    sha256,
    at: Date.now(),
  };
  store.emit('file', f);
  return { id, name, size, type: f.type, sha256 };
}
