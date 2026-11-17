// A file a person attached, served by its id (/api/files/:id): moved from server/index.mjs’s routes as it was.

import { INLINE_TYPES } from './blobs.mjs';
import { httpError } from './helpers.mjs';
import { SAME_ORIGIN_ONLY } from './review-files.mjs';

/**
 * A stored file’s bytes and headers, or null for any other request. Images from the safe list show inline; everything
 * else downloads. Neither can run script.
 * @param {any} store @param {import('./blobs.mjs').Blobs} blobs @param {string} path @param {string} method
 * @returns {Promise<{ bytes: Buffer, headers: Record<string, string> } | null>}
 */
export async function storedFileRoute(store, blobs, path, method) {
  const m = path.match(/^\/api\/files\/([^/]+)$/);
  if (!m || method !== 'GET') return null;
  const f = store.state.files[m[1]];
  if (!f) throw httpError(404, 'That file doesn’t exist.');
  const inline = INLINE_TYPES.has(f.type);
  return {
    bytes: await blobs.get(f.sha256),
    headers: {
      'content-type': inline ? f.type : 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'private, max-age=31536000, immutable',
      ...SAME_ORIGIN_ONLY,
    },
  };
}
