// A file a person attached, served by its id (/api/files/:id): moved from server/index.mjs’s routes as it was.

import { INLINE_TYPES } from './blobs.mjs';
import { httpError } from './helpers.mjs';
import { SAME_ORIGIN_ONLY } from './review-files.mjs';

/**
 * Answers a request for a stored file, streamed a chunk at a time with its hash checked as it goes (#870: an upload has
 * no fixed size, so a file read whole cost its size in memory, and past 2 GiB couldn’t be read at all). False for any
 * other request. Images from the safe list show inline; everything else downloads. Neither can run script.
 * @param {any} store @param {import('./blobs.mjs').Blobs} blobs @param {string} path @param {string} method
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function storedFileRoute(store, blobs, path, method, res) {
  const m = path.match(/^\/api\/files\/([^/]+)$/);
  if (!m || method !== 'GET') return false;
  const f = store.state.files[m[1]];
  if (!f) throw httpError(404, 'That file doesn’t exist.');
  const inline = INLINE_TYPES.has(f.type);
  // Opened before the status is written, so a missing or damaged blob is still an error the page can show.
  const bytes = await blobs.stream(f.sha256, f.size);
  res.writeHead(200, {
    'content-type': inline ? f.type : 'application/octet-stream',
    'content-length': String(f.size),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\w.-]/g, '_')}"`,
    'cache-control': 'private, max-age=31536000, immutable',
    ...SAME_ORIGIN_ONLY,
  });
  await sendAll(res, bytes, f.id);
  return true;
}

/**
 * Writes a stream to the answer, waiting while the page is behind. A page that goes away stops the reading; a damaged
 * file, found at its end, cuts the answer short of its length, so the page never takes it as whole, and is logged.
 * @param {import('node:http').ServerResponse} res @param {import('node:stream').Readable} bytes @param {string} id
 */
async function sendAll(res, bytes, id) {
  try {
    for await (const chunk of bytes) {
      if (res.write(chunk) === false)
        await new Promise((go) => {
          res.once('drain', go);
          res.once('close', go);
        });
      if (res.destroyed) return bytes.destroy();
    }
    res.end();
  } catch (e) {
    console.error(`Postbox stopped sending file ${id}: ${/** @type {Error} */ (e).message}`);
    res.destroy();
  }
}
