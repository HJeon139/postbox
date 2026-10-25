// Files Postbox serves from its folders by a request’s path: the data folder’s media, and the joins under its own
// folders. Moved from server/index.mjs.

import { realpath } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { httpError } from './helpers.mjs';

const MEDIA_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

/** An image in the data folder’s media, followed through links, which can’t lead out of it. */
export async function mediaFile(dir, rel) {
  const isImage = (p) => MEDIA_TYPES.has(extname(p).toLowerCase());
  const asked = safeJoin(dir, rel);
  const [root, real] = await Promise.all([realpath(dir), realpath(asked).catch(() => null)]);
  if (!real || !isImage(asked) || !isImage(real)) throw httpError(404, 'Not found.');
  if (!real.startsWith(root + sep)) throw httpError(403, 'That path isn’t allowed.');
  return real;
}

export function safeJoin(dir, rel) {
  const p = normalize(join(dir, decodeURIComponent(rel)));
  if (p !== dir && !p.startsWith(dir + sep)) throw httpError(403, 'That path isn’t allowed.');
  return p;
}
