// The person’s upload of an attachment (POST /api/files). Moved from server/index.mjs.

import { httpError } from './helpers.mjs';
import { decodePath } from './served-files.mjs';
import { newId } from './store.mjs';
import { uploadName } from './upload-name.mjs';

/**
 * POST /api/files: the person’s upload, stored in the blob store, and its metadata emitted as a file.
 * @param {import('node:http').IncomingMessage} req @param {{ blobs: import('./blobs.mjs').Blobs, store: any }} ctx
 */
export async function upload(req, { blobs, store }) {
  const name = uploadName(decodePath(String(req.headers['x-filename'] ?? 'file')));
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 25 * 1024 * 1024) throw httpError(413, 'Files are limited to 25 MB.');
    chunks.push(c);
  }
  const id = newId('fi');
  const { sha256 } = await blobs.put(Buffer.concat(chunks));
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
